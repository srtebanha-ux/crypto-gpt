"""Etapa 4 — Motor de Luz Puro (Mitsuba 3), sem Blender.

Renderiza a malha acoplada (``zane_com_guitarra.obj``) por **path-tracing** com o
``mitsuba`` — um motor científico de renderização em Python. A câmera é instanciada
por matriz *look-at*, as luzes por posições cartesianas com potência física, e o
traçado roda na CPU (variante ``llvm``) ou GPU (``cuda``, se houver NVIDIA).

Arquitetura em duas camadas para testabilidade:

* :func:`describe_scene` — **pura** (só ``numpy``): dado o centro/dimensões do
  sujeito, devolve uma *descrição* numérica da cena (câmera, luzes, filme). Não
  toca no ``mitsuba``, então é 100% testável sem o motor instalado.
* :class:`MitsubaRenderer` — converte a descrição no dicionário do ``mitsuba`` e
  executa o render. Importa ``mitsuba`` só na hora de renderizar.

Medição do sujeito reaproveita nossa própria engine (``genesis.mesh.Mesh``, numpy):
nada de dependência escondida para posicionar câmera e luzes.
"""

from __future__ import annotations

import logging
import math
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Sequence

import numpy as np
from numpy.typing import NDArray

from ..mesh import Mesh

Array = NDArray[np.float64]
Vec3 = tuple[float, float, float]
LOG = logging.getLogger("NEXUS-MITSUBA")


class MitsubaRenderError(RuntimeError):
    """Falha irrecuperável no render (mensagem já contextualizada)."""


# ------------------------------------------------------------- especificações
@dataclass
class LightSpec:
    """Luz pontual em coordenadas esféricas relativas ao sujeito.

    ``irradiance`` é o alvo (W/m²) na superfície; a intensidade radiante do ponto
    (W/sr) do Mitsuba é ``I = E · d²`` (lei do inverso do quadrado para fonte
    pontual, ``E = I / d²``).
    """

    name: str
    azimuth: float
    elevation: float
    distance: float
    irradiance: float
    color: Vec3 = (1.0, 1.0, 1.0)

    def intensity(self) -> Array:
        I = self.irradiance * (self.distance ** 2)
        return np.array(self.color, dtype=np.float64) * I


# Iluminação para figura em pé: KEY/FILL/RIM + uma FRONTAL baixa que garante o
# lado voltado à câmera sempre iluminado (sem ela, luzes altas passam rente ao
# corpo vertical e o deixam escuro, iluminando só o chão).
DEFAULT_LIGHTS: tuple[LightSpec, ...] = (
    LightSpec("KEY", azimuth=35.0, elevation=22.0, distance=2.2, irradiance=42.0,
              color=(1.0, 0.85, 0.65)),
    LightSpec("FILL", azimuth=-50.0, elevation=14.0, distance=2.6, irradiance=16.0,
              color=(1.0, 0.9, 0.8)),
    LightSpec("FRONT", azimuth=0.0, elevation=8.0, distance=2.7, irradiance=24.0,
              color=(1.0, 0.95, 0.88)),  # frontal baixa: banha o lado da câmera
    LightSpec("RIM", azimuth=195.0, elevation=42.0, distance=2.4, irradiance=55.0,
              color=(0.7, 0.8, 1.0)),
)


@dataclass
class RenderConfig:
    """Parâmetros do render Mitsuba."""

    input_mesh: Path
    output_path: Path = Path("renders/mitsuba_out.png")
    resolution: tuple[int, int] = (1080, 1920)
    samples: int = 128            # amostras por pixel (spp)
    max_depth: int = 8            # profundidade máxima do path-tracing
    fov_deg: float = 32.0
    frame_height_fraction: float = 0.9
    exposure: float = 0.0
    reflectance: Vec3 = (0.65, 0.62, 0.58)  # albedo difuso do sujeito
    ambient: float = 0.03         # luz constante de fundo (evita preto puro)
    add_floor: bool = False       # o piso da cena competia com o sujeito; off por padrão
    lights: Sequence[LightSpec] = field(default_factory=lambda: DEFAULT_LIGHTS)

    def __post_init__(self) -> None:
        self.input_mesh = Path(self.input_mesh)
        self.output_path = Path(self.output_path)
        if self.samples <= 0:
            raise ValueError("samples deve ser positivo")
        if self.max_depth < 1:
            raise ValueError("max_depth deve ser >= 1")


# -------------------------------------------------- descrição de cena (pura) --
def measure_mesh(mesh: Mesh) -> tuple[Array, Array]:
    """Centro e dimensões da bounding box mundial do sujeito."""
    v = mesh.vertices
    lo, hi = v.min(axis=0), v.max(axis=0)
    return (lo + hi) / 2.0, (hi - lo)


def spherical_to_cartesian(azimuth_deg: float, elevation_deg: float, distance: float) -> Array:
    """Esféricas (azimute a partir de −Y, elevação) → cartesianas. Convenção destra."""
    az, el = math.radians(azimuth_deg), math.radians(elevation_deg)
    horizontal = distance * math.cos(el)
    return np.array([
        horizontal * math.sin(az),
        -horizontal * math.cos(az),
        distance * math.sin(el),
    ])


def describe_scene(config: RenderConfig, center: Array, dims: Array) -> dict:
    """Descrição numérica da cena (sem ``mitsuba``). Base testável do render.

    Câmera na frente (−Y) a uma distância que enquadra ``frame_height_fraction``
    da altura do sujeito: ``d = (h/2) / tan(fov/2)``. Luzes posicionadas ao redor
    do ponto de mira (centro do sujeito, levemente acima).
    """
    center = np.asarray(center, dtype=np.float64)
    height = float(dims[2])
    aim = center + np.array([0.0, 0.0, height * 0.05])

    frame_h = max(height * config.frame_height_fraction, 1e-3)
    distance = (frame_h / 2.0) / math.tan(math.radians(config.fov_deg) / 2.0)
    cam_origin = aim + np.array([0.0, -distance, 0.0])

    lights = []
    for spec in config.lights:
        pos = aim + spherical_to_cartesian(spec.azimuth, spec.elevation, spec.distance)
        lights.append({
            "name": spec.name,
            "position": pos.tolist(),
            "intensity": spec.intensity().tolist(),
        })

    floor_z = float(center[2] - dims[2] / 2.0)
    return {
        "sensor": {
            "origin": cam_origin.tolist(),
            "target": aim.tolist(),
            "up": [0.0, 0.0, 1.0],
            "fov": config.fov_deg,
        },
        "film": {
            "width": config.resolution[0],
            "height": config.resolution[1],
            "spp": config.samples,
        },
        "integrator": {"max_depth": config.max_depth},
        "subject": {
            "filename": str(config.input_mesh),
            "reflectance": list(config.reflectance),
        },
        "lights": lights,
        "ambient": config.ambient,
        "floor": {"z": floor_z, "size": float(max(dims) * 8.0)} if config.add_floor else None,
    }


# ----------------------------------------------------------------- renderizador
class MitsubaRenderer:
    """Executa o render Mitsuba a partir de uma :class:`RenderConfig`."""

    def __init__(self, config: RenderConfig) -> None:
        self.config = config

    @staticmethod
    def _import_mitsuba():
        try:
            import mitsuba as mi  # type: ignore
        except ImportError as exc:  # pragma: no cover - depende do ambiente
            raise MitsubaRenderError(
                "mitsuba não instalado — `pip install mitsuba`. É o motor de "
                "render puro em Python (path-tracing), sem Blender."
            ) from exc
        return mi

    @staticmethod
    def select_variant(mi) -> str:
        """Ativa a melhor variante que **realmente inicializa**: LLVM → escalar → CUDA.

        Estar listada em ``mi.variants()`` não garante que a variante ativa: o
        backend ``llvm`` só inicializa se a ``libLLVM`` estiver presente, e o
        ``cuda`` exige GPU NVIDIA. Por isso tentamos ``set_variant`` de fato e, se
        a ativação falhar (ex.: ``libLLVM.dylib`` ausente no macOS), caímos para a
        próxima — ``scalar_rgb`` sempre funciona (CPU, sem JIT), só é mais lento.
        """
        available = mi.variants()
        errors: list[str] = []
        for variant in ("llvm_ad_rgb", "scalar_rgb", "cuda_ad_rgb"):
            if variant not in available:
                continue
            try:
                mi.set_variant(variant)
                if variant == "scalar_rgb":
                    LOG.warning(
                        "[NEXUS-MITSUBA] usando 'scalar_rgb' (CPU escalar) — o "
                        "backend LLVM não pôde iniciar; o render será mais lento."
                    )
                return variant
            except Exception as exc:  # noqa: BLE001 - tenta a próxima variante
                errors.append(f"{variant}: {str(exc).splitlines()[0]}")
        raise MitsubaRenderError(
            "nenhuma variante do Mitsuba pôde ser ativada — " + " | ".join(errors)
        )

    def _to_mitsuba_dict(self, mi, desc: dict) -> dict:
        """Converte a descrição pura no dicionário de cena do Mitsuba."""
        s = desc["sensor"]
        to_world = mi.ScalarTransform4f().look_at(
            origin=s["origin"], target=s["target"], up=s["up"]
        )
        scene = {
            "type": "scene",
            "integrator": {"type": "path", "max_depth": desc["integrator"]["max_depth"]},
            "sensor": {
                "type": "perspective",
                "fov": s["fov"],
                "fov_axis": "y",
                "to_world": to_world,
                "sampler": {"type": "independent", "sample_count": desc["film"]["spp"]},
                "film": {
                    "type": "hdrfilm",
                    "width": desc["film"]["width"],
                    "height": desc["film"]["height"],
                    "pixel_format": "rgb",
                    "rfilter": {"type": "gaussian"},
                },
            },
            "subject": {
                "type": "obj",
                "filename": desc["subject"]["filename"],
                # 'twosided' reflete dos dois lados da face: blinda contra malhas
                # com winding/normais invertidas (comum no visual hull), que de
                # outro modo apareceriam pretas (Mitsuba não ilumina o verso).
                "bsdf": {
                    "type": "twosided",
                    "material": {
                        "type": "principled",
                        "base_color": {"type": "rgb", "value": desc["subject"]["reflectance"]},
                        "roughness": 0.5,
                    },
                },
            },
        }
        if desc["ambient"] > 0:
            scene["ambient"] = {
                "type": "constant",
                "radiance": {"type": "rgb", "value": desc["ambient"]},
            }
        if desc["floor"] is not None:
            f = desc["floor"]
            scene["floor"] = {
                "type": "rectangle",
                "to_world": mi.ScalarTransform4f().translate([0, 0, f["z"]]).scale(f["size"]),
                "bsdf": {"type": "diffuse", "reflectance": {"type": "rgb", "value": [0.03, 0.03, 0.035]}},
            }
        for light in desc["lights"]:
            scene[f"light_{light['name']}"] = {
                "type": "point",
                "position": light["position"],
                "intensity": {"type": "rgb", "value": light["intensity"]},
            }
        return scene

    def render(self) -> Path:
        """Carrega, path-traceia e grava o PNG. Retorna o caminho de saída."""
        cfg = self.config
        if not cfg.input_mesh.exists():
            raise MitsubaRenderError(f"malha de entrada não encontrada: {cfg.input_mesh}")

        LOG.info("[NEXUS-MITSUBA] medindo sujeito (%s)", cfg.input_mesh.name)
        mesh = Mesh.load_obj(cfg.input_mesh)
        center, dims = measure_mesh(mesh)
        desc = describe_scene(cfg, center, dims)

        mi = self._import_mitsuba()
        variant = self.select_variant(mi)
        LOG.info("[NEXUS-MITSUBA] variante: %s | %d spp | max_depth %d",
                 variant, cfg.samples, cfg.max_depth)

        try:
            scene = mi.load_dict(self._to_mitsuba_dict(mi, desc))
            image = mi.render(scene, spp=cfg.samples)
            if cfg.exposure != 0.0:
                image = image * (2.0 ** cfg.exposure)  # ajuste de exposição (stops)
            cfg.output_path.parent.mkdir(parents=True, exist_ok=True)
            mi.util.write_bitmap(str(cfg.output_path), image)
        except MitsubaRenderError:
            raise
        except Exception as exc:  # noqa: BLE001 - blinda e contextualiza
            raise MitsubaRenderError(f"falha no render Mitsuba: {exc}") from exc

        LOG.info("[NEXUS-MITSUBA] gravado: %s", cfg.output_path)
        return cfg.output_path


def configure_logging(verbose: bool = True) -> None:
    logging.basicConfig(
        level=logging.INFO if verbose else logging.WARNING,
        format="%(asctime)s %(levelname)-7s %(message)s",
        datefmt="%H:%M:%S",
        stream=sys.stdout,
    )
