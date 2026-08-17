"""Cenário procedural: um palco de show para a MoonSilver (rock folk).

Constrói, via ``bpy``, um palco completo — piso, backdrop (cyclorama), uma
treliça frontal de spots com mira calculada, luzes de contorno traseiras e névoa
volumétrica opcional (para god-rays). A matemática de posicionamento é pura
(``numpy``) e testável sem Blender; a montagem de objetos vive no caminho ``bpy``.

Composição de luz: paleta quente (âmbares e brancos quentes) com um acento frio
atrás para separar a silhueta do fundo — clima íntimo de casa de show, não de
palco estridente.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Sequence

import numpy as np
from numpy.typing import NDArray

Array = NDArray[np.float64]
Vec3 = tuple[float, float, float]

# Convenção da cena (coerente com o Módulo 5): o sujeito fica na origem, olhando
# para -Y; a plateia/câmera está no lado -Y; +Z é para cima.

# Paleta quente de rock folk: âmbar de tungstênio, branco quente e um acento frio.
WARM_STAGE_PALETTE: dict[str, Vec3] = {
    "amber": (1.0, 0.58, 0.24),        # spot âmbar (key quente)
    "warm_white": (1.0, 0.82, 0.60),   # branco quente (preenchimento)
    "cool_rim": (0.55, 0.72, 1.0),     # acento frio (contorno traseiro)
}


@dataclass
class StageConfig:
    """Parâmetros geométricos e de luz do palco."""

    subject_mesh: Path | None = None       # .obj/.fbx opcional para pôr no palco
    output_dir: Path = Path("renders")
    # Piso e fundo
    floor_size: float = 24.0
    backdrop_distance: float = 6.0         # atrás do sujeito (+Y)
    backdrop_height: float = 8.0
    # Treliça frontal de spots
    truss_count: int = 5
    truss_width: float = 7.0
    truss_height: float = 4.5
    truss_depth: float = 4.0               # à frente do sujeito (-Y)
    spot_power: float = 800.0              # Watts por spot
    spot_blend: float = 0.25               # suavidade da borda do cone
    spot_size_deg: float = 35.0            # ângulo do cone
    # Contraluz (rim) traseiro
    rim_count: int = 2
    rim_power: float = 1200.0
    # Névoa volumétrica (god-rays) — custosa; desligada por padrão
    volumetric: bool = False
    volumetric_density: float = 0.02
    aim_height: float = 1.4                # altura do alvo (rosto/peito) em Z

    def __post_init__(self) -> None:
        self.output_dir = Path(self.output_dir)
        if self.subject_mesh is not None:
            self.subject_mesh = Path(self.subject_mesh)
        if self.truss_count < 1:
            raise ValueError("truss_count deve ser >= 1")
        if not 0.0 <= self.spot_blend <= 1.0:
            raise ValueError("spot_blend deve estar em [0, 1]")


# --------------------------------------------------------- matemática (pura) --
def truss_spot_positions(
    count: int, width: float, height: float, depth: float
) -> Array:
    """Posições dos spots pendurados numa treliça horizontal frontal.

    Distribui ``count`` spots uniformemente ao longo de X em
    ``[-width/2, +width/2]``, todos à altura ``height`` (Z) e à frente do sujeito
    em ``y = -depth``. Com ``count == 1`` o spot fica centralizado.
    """
    if count < 1:
        raise ValueError("count deve ser >= 1")
    xs = np.zeros(1) if count == 1 else np.linspace(-width / 2.0, width / 2.0, count)
    pos = np.zeros((count, 3), dtype=np.float64)
    pos[:, 0] = xs
    pos[:, 1] = -depth
    pos[:, 2] = height
    return pos


def rim_positions(count: int, width: float, height: float, depth: float) -> Array:
    """Posições das luzes de contorno atrás do sujeito (``y = +depth``)."""
    if count < 1:
        raise ValueError("count deve ser >= 1")
    xs = np.zeros(1) if count == 1 else np.linspace(-width / 2.0, width / 2.0, count)
    pos = np.zeros((count, 3), dtype=np.float64)
    pos[:, 0] = xs
    pos[:, 1] = depth
    pos[:, 2] = height
    return pos


def aim_directions(positions: Array, target: Array) -> Array:
    """Vetores unitários de cada luz apontando para o alvo (mira do cone)."""
    d = np.asarray(target, dtype=np.float64)[None, :] - np.asarray(positions, float)
    norms = np.linalg.norm(d, axis=1, keepdims=True)
    norms = np.where(norms > 1e-9, norms, 1.0)
    return d / norms


# ------------------------------------------------------- construtor (bpy) -----
class StageBuilder:
    """Monta o palco na cena ativa do Blender (requer ``bpy``)."""

    def __init__(self, config: StageConfig) -> None:
        self.config = config

    def build(self) -> object:
        """Constrói piso, backdrop, treliça, rim e névoa. Retorna a câmera."""
        import bpy  # import tardio: só necessário ao construir de fato
        from mathutils import Vector

        cfg = self.config
        target = Vector((0.0, 0.0, cfg.aim_height))

        self._build_floor(bpy)
        self._build_backdrop(bpy)
        self._build_spots(bpy, Vector, target)
        self._build_rims(bpy, Vector, target)
        if cfg.volumetric:
            self._build_volumetric_world(bpy)
        return self._build_camera(bpy, Vector, target)

    # -- geometria ---------------------------------------------------------
    def _build_floor(self, bpy) -> None:
        cfg = self.config
        bpy.ops.mesh.primitive_plane_add(size=cfg.floor_size, location=(0, 0, 0))
        floor = bpy.context.active_object
        floor.name = "Stage_Floor"
        mat = bpy.data.materials.new("Floor_Mat")
        mat.use_nodes = True
        bsdf = mat.node_tree.nodes.get("Principled BSDF")
        if bsdf:  # piso escuro, semi-reflexivo (madeira de palco encerada)
            bsdf.inputs["Base Color"].default_value = (0.02, 0.02, 0.025, 1.0)
            _set_bsdf(bsdf, "Roughness", 0.35)
        floor.data.materials.append(mat)

    def _build_backdrop(self, bpy) -> None:
        cfg = self.config
        bpy.ops.mesh.primitive_plane_add(size=cfg.floor_size, location=(0, cfg.backdrop_distance, cfg.backdrop_height / 2))
        back = bpy.context.active_object
        back.name = "Stage_Backdrop"
        back.rotation_euler = (np.radians(90.0), 0.0, 0.0)  # de pé, encarando -Y
        mat = bpy.data.materials.new("Backdrop_Mat")
        mat.use_nodes = True
        bsdf = mat.node_tree.nodes.get("Principled BSDF")
        if bsdf:
            bsdf.inputs["Base Color"].default_value = (0.03, 0.03, 0.04, 1.0)
            _set_bsdf(bsdf, "Roughness", 0.9)
        back.data.materials.append(mat)

    # -- luzes -------------------------------------------------------------
    def _build_spots(self, bpy, Vector, target) -> None:
        cfg = self.config
        positions = truss_spot_positions(
            cfg.truss_count, cfg.truss_width, cfg.truss_height, cfg.truss_depth
        )
        colors = [
            WARM_STAGE_PALETTE["amber"],
            WARM_STAGE_PALETTE["warm_white"],
        ]
        for i, pos in enumerate(positions):
            color = colors[i % len(colors)]
            self._add_spot(bpy, Vector, f"Spot_Key_{i}", pos, target, cfg.spot_power, color)

    def _build_rims(self, bpy, Vector, target) -> None:
        cfg = self.config
        positions = rim_positions(
            cfg.rim_count, cfg.truss_width * 0.7, cfg.truss_height, cfg.backdrop_distance * 0.6
        )
        for i, pos in enumerate(positions):
            self._add_spot(
                bpy, Vector, f"Spot_Rim_{i}", pos, target,
                cfg.rim_power, WARM_STAGE_PALETTE["cool_rim"],
            )

    def _add_spot(self, bpy, Vector, name, pos, target, power, color) -> None:
        cfg = self.config
        light = bpy.data.lights.new(name=name, type="SPOT")
        light.energy = power
        light.color = color
        light.spot_size = np.radians(cfg.spot_size_deg)
        light.spot_blend = cfg.spot_blend
        obj = bpy.data.objects.new(name, light)
        obj.matrix_world = _look_at(Vector, Vector(tuple(pos)), target)
        bpy.context.collection.objects.link(obj)

    def _build_volumetric_world(self, bpy) -> None:
        cfg = self.config
        world = bpy.context.scene.world or bpy.data.worlds.new("World")
        bpy.context.scene.world = world
        world.use_nodes = True
        nt = world.node_tree
        # Adiciona um Volume Scatter no mundo para materializar os feixes de luz.
        scatter = nt.nodes.new("ShaderNodeVolumeScatter")
        scatter.inputs["Density"].default_value = cfg.volumetric_density
        out = nt.nodes.get("World Output")
        if out is not None:
            nt.links.new(scatter.outputs["Volume"], out.inputs["Volume"])

    def _build_camera(self, bpy, Vector, target) -> object:
        # Câmera 3/4 frontal, à altura do peito, ligeiramente à esquerda.
        cam_data = bpy.data.cameras.new("Stage_Camera")
        cam_data.lens = 50.0  # 50mm: perspectiva natural, pouca distorção
        cam_obj = bpy.data.objects.new("Stage_Camera", cam_data)
        eye = Vector((-1.6, -5.5, 1.7))
        cam_obj.matrix_world = _look_at(Vector, eye, target)
        bpy.context.collection.objects.link(cam_obj)
        bpy.context.scene.camera = cam_obj
        return cam_obj


# ------------------------------------------------------------- helpers bpy ----
def _set_bsdf(bsdf, name: str, value: float) -> None:
    """Define uma entrada do Principled BSDF se ela existir (varia por versão)."""
    if name in bsdf.inputs:
        bsdf.inputs[name].default_value = value


def _look_at(Vector, eye, target):
    """Matriz look-at do Blender (câmera/spot olham ao longo de -Z local)."""
    from mathutils import Matrix

    up = Vector((0.0, 0.0, 1.0))
    back = (eye - target).normalized()
    right = up.cross(back)
    if right.length < 1e-8:
        right = Vector((1.0, 0.0, 0.0)).cross(back)
    right.normalize()
    true_up = back.cross(right)
    return Matrix((
        (right.x, true_up.x, back.x, eye.x),
        (right.y, true_up.y, back.y, eye.y),
        (right.z, true_up.z, back.z, eye.z),
        (0.0, 0.0, 0.0, 1.0),
    ))
