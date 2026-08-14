"""Pipeline Gênesis — Módulo 5: O Motor Fantasma (Renderizador Headless).

Renderiza os membros da MoonSilver (Zane, Vance, Leo) via ``bpy`` importado como
biblioteca — 100% headless, **sem** subprocesso abrindo o executável do Blender.

Hardware-alvo: **MacBook Air (Apple Silicon)**. O backend de compute é o **Metal**
(Apple), nunca CUDA/OptiX. O motor é o **Cycles** com denoise por OpenImageDenoise.

Decisões matemáticas centrais documentadas ao longo do código:

* **Câmera** — construída por uma matriz *look-at* ortonormal (base direita),
  respeitando a convenção do Blender de que a câmera olha ao longo de ``-Z``.
* **Iluminação de 3 pontos** — Key/Fill/Rim posicionadas em coordenadas
  esféricas ao redor do busto e convertidas para cartesianas; a potência (Watts)
  de cada luz deriva de um alvo de irradiância pela lei do inverso do quadrado.

Uso típico (no MacBook, com ``bpy`` instalado no venv)::

    python -m genesis.render.cli --input exports/moonsilver_zane_purificado.obj \
        --out renders/ --format PNG --samples 128
"""

from __future__ import annotations

import logging
import math
import sys
from contextlib import contextmanager
from dataclasses import dataclass, field
from pathlib import Path
from typing import Iterator, Literal, Sequence

# ---------------------------------------------------------------------------
# bpy/mathutils são importados de forma defensiva: o módulo precisa poder ser
# *importado* (para checagem de sintaxe/tipos, testes de config) mesmo onde o
# Blender não está instalado. A ausência só é fatal quando o render de fato roda.
# ---------------------------------------------------------------------------
try:  # pragma: no cover - depende do ambiente Blender
    import bpy
    import mathutils
    from mathutils import Matrix, Vector

    _BPY_AVAILABLE = True
    _BPY_IMPORT_ERROR: Exception | None = None
except Exception as exc:  # noqa: BLE001 - qualquer falha de import é "sem bpy"
    bpy = None  # type: ignore[assignment]
    mathutils = None  # type: ignore[assignment]
    Matrix = Vector = object  # type: ignore[assignment,misc]
    _BPY_AVAILABLE = False
    _BPY_IMPORT_ERROR = exc


LOG = logging.getLogger("NEXUS-RENDER")

Resolution = tuple[int, int]
Vec3 = tuple[float, float, float]


class RenderEngineError(RuntimeError):
    """Falha irrecuperável no motor de render (mensagem já em contexto)."""


# ============================================================ configuração ===
@dataclass
class LightSpec:
    """Especificação física de uma luz de área.

    ``azimuth``/``elevation`` (graus) são coordenadas esféricas relativas ao
    *sujeito*; ``distance`` é o raio até ele. ``irradiance`` é o alvo de fluxo por
    área (W/m²) na superfície do sujeito — a potência real em Watts é derivada
    pela lei do inverso do quadrado em :meth:`HeadlessRenderEngine._light_power`.
    """

    name: str
    azimuth: float
    elevation: float
    distance: float
    irradiance: float
    size: float  # tamanho da luz de área (m) — controla a suavidade da sombra
    color: Vec3 = (1.0, 1.0, 1.0)


@dataclass
class RenderConfig:
    """Todos os parâmetros da cena e do render num único objeto tipado."""

    input_mesh: Path
    output_dir: Path
    resolution: Resolution = (1080, 1920)  # vertical (Reels/TikTok) por padrão
    samples: int = 128
    use_denoise: bool = True
    output_format: Literal["PNG", "MP4"] = "PNG"
    frame_start: int = 1
    frame_end: int = 1  # 1 == frame único; > start habilita sequência/MP4
    fps: int = 24
    device_type: Literal["METAL"] = "METAL"  # Apple Silicon: nunca CUDA/OptiX
    film_transparent: bool = False
    exposure: float = 0.0
    # Enquadramento: fração da altura do sujeito visível (busto ~ 0.45).
    frame_height_fraction: float = 0.45
    camera_vertical_fov_deg: float = 32.0
    subject_name: str = "MoonSilver_Subject"
    allow_placeholder: bool = False  # gera Suzanne se o asset não existir
    lights: Sequence[LightSpec] = field(default_factory=lambda: DEFAULT_THREE_POINT)

    def __post_init__(self) -> None:
        self.input_mesh = Path(self.input_mesh)
        self.output_dir = Path(self.output_dir)
        if self.frame_end < self.frame_start:
            raise ValueError("frame_end não pode ser menor que frame_start")
        if self.samples <= 0:
            raise ValueError("samples deve ser positivo")


# Setup clássico de três pontos, calibrado para retrato/busto:
#  - Key: fonte principal, 40° à frente-lateral, elevada — define a forma.
#  - Fill: lado oposto, ~1/4 da irradiância da key (razão de contraste 4:1),
#    grande e suave, para abrir as sombras sem apagar a modelagem.
#  - Rim: atrás e acima, separa o sujeito do fundo (luz de contorno/cabelo).
#
# Os alvos de irradiância (W/m²) estão calibrados para a escala de Watts das
# luzes do Blender a distâncias de retrato (~2–3 m): via P = E·4π d², a Key rende
# ~700 W, a Fill ~250 W e a Rim ~1.1 kW — a faixa saudável do Cycles com Filmic.
# (900 W/m² seria irradiância de sol a pino e estouraria o frame para branco.)
DEFAULT_THREE_POINT: tuple[LightSpec, ...] = (
    LightSpec("KEY", azimuth=40.0, elevation=25.0, distance=2.2, irradiance=11.5, size=0.9),
    LightSpec("FILL", azimuth=-55.0, elevation=10.0, distance=2.6, irradiance=2.9, size=1.6),
    LightSpec("RIM", azimuth=190.0, elevation=45.0, distance=2.4, irradiance=15.5, size=0.5,
              color=(0.85, 0.9, 1.0)),  # rim levemente fria para separar do fundo
)


# ============================================================ o motor =========
class HeadlessRenderEngine:
    """Renderizador headless orientado a objetos sobre o Cycles/Metal.

    O ciclo de vida é: :meth:`configure_device` → :meth:`reset_scene` →
    :meth:`import_subject` → :meth:`frame_subject_camera` →
    :meth:`build_three_point_lighting` → :meth:`configure_render_settings` →
    :meth:`render`. O orquestrador :meth:`run` executa tudo com telemetria e
    tratamento de exceções blindado.
    """

    def __init__(self, config: RenderConfig) -> None:
        self.config = config
        self._camera: object | None = None
        self._subject: object | None = None
        self._subject_center: Vec3 = (0.0, 0.0, 0.0)
        self._subject_dims: Vec3 = (1.0, 1.0, 1.0)

    # ----------------------------------------------------------- utilidades --
    @staticmethod
    def _ensure_bpy() -> None:
        """Garante que o Blender/bpy está disponível; senão, erro claro."""
        if not _BPY_AVAILABLE:
            raise RenderEngineError(
                "bpy indisponível — este módulo precisa rodar num Python com o "
                "Blender como biblioteca (`pip install bpy`). Erro de import: "
                f"{_BPY_IMPORT_ERROR!r}"
            )

    @contextmanager
    def _stage(self, label: str) -> Iterator[None]:
        """Cronometra e loga uma etapa; converte exceções em RenderEngineError."""
        LOG.info("[NEXUS-RENDER] %s ...", label)
        start = _now()
        try:
            yield
        except RenderEngineError:
            raise
        except Exception as exc:  # noqa: BLE001 - blindagem: contextualiza tudo
            LOG.exception("[NEXUS-RENDER] FALHA em '%s'", label)
            raise RenderEngineError(f"falha em '{label}': {exc}") from exc
        LOG.info("[NEXUS-RENDER] %s concluído em %.3fs", label, _now() - start)

    # --------------------------------------------------------- 1. dispositivo -
    def configure_device(self) -> None:
        """Ativa o Cycles no backend **Metal** e habilita a GPU Apple Silicon.

        No macOS/Apple Silicon o ``compute_device_type`` correto é ``'METAL'``.
        CUDA/OptiX são exclusivos da NVIDIA e **não** existem neste alvo — usá-los
        aqui derrubaria o render. Ativamos os dispositivos Metal (GPU) e deixamos
        a CPU como coprocessador quando o Blender expõe ambos.
        """
        with self._stage("Configurando backend de compute (Cycles/Metal)"):
            self._ensure_bpy()
            prefs = bpy.context.preferences.addons["cycles"].preferences
            prefs.compute_device_type = self.config.device_type  # 'METAL'

            # Atualiza a lista de dispositivos (o nome do método variou entre
            # versões do Blender; tentamos os conhecidos de forma defensiva).
            for refresh in ("refresh_devices", "get_devices"):
                fn = getattr(prefs, refresh, None)
                if callable(fn):
                    try:
                        fn()
                        break
                    except Exception:  # noqa: BLE001
                        continue

            enabled = 0
            for device in prefs.devices:
                is_metal_gpu = device.type == self.config.device_type
                device.use = is_metal_gpu or device.type == "CPU"
                if device.use:
                    enabled += 1
                    LOG.info(
                        "[NEXUS-RENDER]   dispositivo ativo: %s (%s)",
                        device.name, device.type,
                    )
            if enabled == 0:
                raise RenderEngineError(
                    "nenhum dispositivo Metal/CPU encontrado — verifique se o "
                    "Blender foi compilado com suporte a Metal neste macOS"
                )

            scene = bpy.context.scene
            scene.render.engine = "CYCLES"
            scene.cycles.device = "GPU"  # despacha o traçado para a GPU Metal

    # ------------------------------------------------------- 2. limpar cena ---
    def reset_scene(self) -> None:
        """Zera a cena default (cubo, luz e câmera) para um palco limpo."""
        with self._stage("Limpando a cena default"):
            self._ensure_bpy()
            # Remoção em lote via batch_remove é O(n) e não deixa órfãos.
            bpy.ops.object.select_all(action="SELECT")
            bpy.ops.object.delete(use_global=False)
            # Limpa data-blocks órfãos (malhas/câmeras/luzes sem usuários).
            for collection in (bpy.data.meshes, bpy.data.cameras, bpy.data.lights):
                for block in list(collection):
                    if block.users == 0:
                        collection.remove(block)

    # ---------------------------------------------------- 3. importar sujeito -
    def import_subject(self) -> None:
        """Importa a malha purificada (``.obj``/``.fbx``) e mede sua bounding box."""
        with self._stage(f"Importando sujeito: {self.config.input_mesh.name}"):
            self._ensure_bpy()
            path = self.config.input_mesh
            before = set(bpy.data.objects)

            if not path.exists():
                if self.config.allow_placeholder:
                    LOG.warning(
                        "[NEXUS-RENDER] asset '%s' ausente — gerando placeholder "
                        "(Suzanne) para validar o pipeline.", path,
                    )
                    bpy.ops.mesh.primitive_monkey_add(size=1.0, location=(0, 0, 0))
                else:
                    raise RenderEngineError(f"asset não encontrado: {path}")
            else:
                self._invoke_importer(path)

            new_objects = [o for o in bpy.data.objects if o not in before]
            meshes = [o for o in new_objects if o.type == "MESH"]
            if not meshes:
                raise RenderEngineError("importação não produziu nenhuma malha")

            subject = meshes[0]
            subject.name = self.config.subject_name
            self._subject = subject
            self._measure_subject(subject)

    def _invoke_importer(self, path: Path) -> None:
        """Escolhe o importador certo pela extensão (API do Blender 4.x)."""
        suffix = path.suffix.lower()
        if suffix == ".obj":
            # Importador C++ moderno (`wm.obj_import`); o antigo `import_scene.obj`
            # foi removido no Blender 4.0.
            bpy.ops.wm.obj_import(filepath=str(path))
        elif suffix == ".fbx":
            bpy.ops.import_scene.fbx(filepath=str(path))
        else:
            raise RenderEngineError(f"extensão não suportada: {suffix} (use .obj/.fbx)")

    def _measure_subject(self, subject: object) -> None:
        """Calcula centro e dimensões mundiais da bounding box do sujeito."""
        # bound_box são os 8 cantos em espaço local; levamos ao mundo via matrix.
        corners = [subject.matrix_world @ Vector(c) for c in subject.bound_box]
        xs = [c.x for c in corners]
        ys = [c.y for c in corners]
        zs = [c.z for c in corners]
        self._subject_center = (
            (min(xs) + max(xs)) / 2.0,
            (min(ys) + max(ys)) / 2.0,
            (min(zs) + max(zs)) / 2.0,
        )
        self._subject_dims = (max(xs) - min(xs), max(ys) - min(ys), max(zs) - min(zs))
        LOG.info(
            "[NEXUS-RENDER]   sujeito: centro=%s dims=%s",
            _fmt(self._subject_center), _fmt(self._subject_dims),
        )

    # ------------------------------------------------------- 4. câmera --------
    def frame_subject_camera(self) -> None:
        """Cria e posiciona a câmera para um enquadramento de busto/rosto.

        Matemática do enquadramento: para mostrar uma faixa vertical de altura
        ``h`` com um campo de visão vertical ``θ``, a distância necessária é

            d = (h / 2) / tan(θ / 2)

        A câmera é orientada por uma **matriz look-at** ortonormal. No Blender, a
        câmera olha ao longo de ``-Z`` local, então montamos a base direita
        ``[right, up, back]`` com ``back = +Z`` apontando do alvo para a câmera.
        """
        with self._stage("Calculando matrizes de câmera (enquadramento busto)"):
            self._ensure_bpy()
            cx, cy, cz = self._subject_center
            height = self._subject_dims[2]
            # Alvo: topo do busto — miramos acima do centro, na região do rosto.
            head_z = (cz - height / 2.0) + height * (1.0 - self.config.frame_height_fraction / 2.0)
            target = Vector((cx, cy, head_z))

            frame_h = height * self.config.frame_height_fraction
            fov = math.radians(self.config.camera_vertical_fov_deg)
            distance = (frame_h / 2.0) / math.tan(fov / 2.0)

            # Posiciona a câmera à frente do sujeito no eixo -Y (frente canônica).
            cam_location = Vector((cx, cy - distance, head_z))
            matrix = self._look_at_matrix(cam_location, target, up=Vector((0.0, 0.0, 1.0)))

            cam_data = bpy.data.cameras.new(name="NEXUS_Camera")
            cam_data.sensor_fit = "VERTICAL"
            cam_data.angle_y = fov  # fixa o FOV vertical usado no cálculo de d
            cam_obj = bpy.data.objects.new("NEXUS_Camera", cam_data)
            cam_obj.matrix_world = matrix
            bpy.context.collection.objects.link(cam_obj)
            bpy.context.scene.camera = cam_obj
            self._camera = cam_obj
            LOG.info(
                "[NEXUS-RENDER]   câmera em %s, alvo %s, d=%.3f, FOV=%.1f°",
                _fmt(tuple(cam_location)), _fmt(tuple(target)),
                distance, self.config.camera_vertical_fov_deg,
            )

    @staticmethod
    def _look_at_matrix(eye: Vector, target: Vector, up: Vector) -> Matrix:
        """Matriz 4×4 mundial de uma câmera Blender olhando de ``eye`` para ``target``.

        Constrói uma base ortonormal destra:
            back  = normalize(eye - target)   # +Z local (câmera olha em -Z)
            right = normalize(up × back)       # +X local
            up'   = back × right               # +Y local (reortogonalizado)
        """
        back = (eye - target).normalized()
        right = up.cross(back)
        if right.length < 1e-8:  # up paralelo à linha de visão: escolhe outro
            right = Vector((1.0, 0.0, 0.0)).cross(back)
        right.normalize()
        true_up = back.cross(right)
        return Matrix((
            (right.x, true_up.x, back.x, eye.x),
            (right.y, true_up.y, back.y, eye.y),
            (right.z, true_up.z, back.z, eye.z),
            (0.0, 0.0, 0.0, 1.0),
        ))

    # ------------------------------------------------- 5. iluminação 3 pontos -
    def build_three_point_lighting(self) -> None:
        """Monta Key/Fill/Rim em torno do sujeito com potência física (Watts)."""
        with self._stage("Calculando matrizes de luz (Three-Point Lighting)"):
            self._ensure_bpy()
            center = Vector(self._subject_center)
            head_z = center.z + self._subject_dims[2] * 0.30  # mira na altura do rosto
            aim = Vector((center.x, center.y, head_z))
            for spec in self.config.lights:
                self._create_area_light(spec, aim)

    def _create_area_light(self, spec: LightSpec, aim: Vector) -> None:
        """Cria uma luz de área a partir de sua especificação esférica/física."""
        # Esféricas → cartesianas. Azimute medido a partir de -Y (frente), no
        # plano XY; elevação acima do plano horizontal. Convenção destra.
        az = math.radians(spec.azimuth)
        el = math.radians(spec.elevation)
        horizontal = spec.distance * math.cos(el)
        offset = Vector((
            horizontal * math.sin(az),
            -horizontal * math.cos(az),
            spec.distance * math.sin(el),
        ))
        location = aim + offset

        light_data = bpy.data.lights.new(name=f"NEXUS_{spec.name}", type="AREA")
        light_data.shape = "DISK"
        light_data.size = spec.size
        light_data.color = spec.color
        light_data.energy = self._light_power(spec)

        light_obj = bpy.data.objects.new(f"NEXUS_{spec.name}", light_data)
        light_obj.matrix_world = self._look_at_matrix(
            location, aim, up=Vector((0.0, 0.0, 1.0))
        )
        bpy.context.collection.objects.link(light_obj)
        LOG.info(
            "[NEXUS-RENDER]   luz %-4s em %s | %.0f W | irradiância-alvo %.0f W/m²",
            spec.name, _fmt(tuple(location)), light_data.energy, spec.irradiance,
        )

    @staticmethod
    def _light_power(spec: LightSpec) -> float:
        """Converte irradiância-alvo (W/m²) em potência radiante (W) da luz.

        Modelo de fonte pontual pela lei do inverso do quadrado: um emissor
        isotrópico de potência ``P`` produz irradiância ``E = P / (4π d²)`` a uma
        distância ``d``. Invertendo, ``P = E · 4π d²``. É uma aproximação (a área
        finita da luz suaviza o resultado), mas dá potências fisicamente
        plausíveis e uma razão Key:Fill previsível.
        """
        return spec.irradiance * 4.0 * math.pi * (spec.distance ** 2)

    # ------------------------------------------------- 6. settings de render --
    def configure_render_settings(self) -> None:
        """Aplica motor, samples, denoise, resolução, cor e formato de saída."""
        with self._stage("Aplicando configuração de render (Cycles)"):
            self._ensure_bpy()
            scene = bpy.context.scene
            cfg = self.config

            scene.render.engine = "CYCLES"
            scene.cycles.samples = cfg.samples
            scene.cycles.use_denoising = cfg.use_denoise
            if cfg.use_denoise:
                # OpenImageDenoise roda na CPU/Apple Silicon e é o denoiser de
                # produção do Cycles (OptiX exigiria NVIDIA, indisponível aqui).
                scene.cycles.denoiser = "OPENIMAGEDENOISE"

            scene.render.resolution_x = cfg.resolution[0]
            scene.render.resolution_y = cfg.resolution[1]
            scene.render.resolution_percentage = 100
            scene.render.film_transparent = cfg.film_transparent

            # Gestão de cor: Filmic dá resposta tonal cinematográfica (highlights
            # suaves), coerente com a estética foto-real da MoonSilver.
            try:
                scene.view_settings.view_transform = "Filmic"
            except Exception:  # noqa: BLE001 - nome do transform varia por versão
                pass
            scene.view_settings.exposure = cfg.exposure

            scene.frame_start = cfg.frame_start
            scene.frame_end = cfg.frame_end
            scene.render.fps = cfg.fps

            cfg.output_dir.mkdir(parents=True, exist_ok=True)
            self._configure_output(scene)

    def _configure_output(self, scene: object) -> None:
        """Define formato/caminho de saída (PNG único ou MP4 H.264)."""
        cfg = self.config
        if cfg.output_format == "PNG":
            scene.render.image_settings.file_format = "PNG"
            scene.render.image_settings.color_mode = "RGBA"
            scene.render.image_settings.color_depth = "16"
            scene.render.filepath = str(cfg.output_dir / f"{cfg.subject_name}_")
        elif cfg.output_format == "MP4":
            scene.render.image_settings.file_format = "FFMPEG"
            scene.render.ffmpeg.format = "MPEG4"
            scene.render.ffmpeg.codec = "H264"
            scene.render.ffmpeg.constant_rate_factor = "HIGH"
            scene.render.ffmpeg.ffmpeg_preset = "GOOD"
            scene.render.filepath = str(cfg.output_dir / f"{cfg.subject_name}.mp4")
        else:  # pragma: no cover - guardado por Literal + __post_init__
            raise RenderEngineError(f"formato de saída inválido: {cfg.output_format}")

    # ------------------------------------------------------------- 7. render --
    def render(self) -> Path:
        """Dispara o render e devolve o caminho do arquivo produzido."""
        cfg = self.config
        is_animation = cfg.output_format == "MP4" or cfg.frame_end > cfg.frame_start
        label = "Renderizando sequência (MP4)" if is_animation else "Renderizando frame (PNG)"
        with self._stage(label):
            self._ensure_bpy()
            if self._camera is None:
                raise RenderEngineError("câmera não configurada antes do render")
            bpy.ops.render.render(animation=is_animation, write_still=not is_animation)

        out = Path(bpy.context.scene.render.filepath)
        result = out if is_animation else out.with_name(
            f"{out.name}{cfg.frame_start:04d}.png"
        )
        LOG.info("[NEXUS-RENDER] Saída gravada em: %s", result)
        return result

    # ----------------------------------------------------------- orquestração -
    def run(self) -> Path:
        """Executa o pipeline completo com telemetria e blindagem de exceções."""
        LOG.info("[NEXUS-RENDER] === MOTOR FANTASMA: INICIANDO (Cycles/Metal) ===")
        t0 = _now()
        try:
            self.configure_device()
            self.reset_scene()
            self.import_subject()
            self.frame_subject_camera()
            self.build_three_point_lighting()
            self.configure_render_settings()
            output = self.render()
        except RenderEngineError:
            LOG.error("[NEXUS-RENDER] === PIPELINE ABORTADO ===")
            raise
        LOG.info(
            "[NEXUS-RENDER] === CONCLUÍDO em %.2fs → %s ===", _now() - t0, output
        )
        return output


# ================================================================ helpers =====
def _now() -> float:
    import time

    return time.perf_counter()


def _fmt(vec: Sequence[float]) -> str:
    return "(" + ", ".join(f"{v:.3f}" for v in vec) + ")"


def configure_logging(verbose: bool = True) -> None:
    """Configura o logger de telemetria para o terminal."""
    logging.basicConfig(
        level=logging.INFO if verbose else logging.WARNING,
        format="%(asctime)s %(levelname)-7s %(message)s",
        datefmt="%H:%M:%S",
        stream=sys.stdout,
    )
