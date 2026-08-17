"""Auto-rig: esqueleto humanoide + skinning automático + posagem.

Liga os primitivos do Módulo 3 (esqueleto, FK, quatérnions, DQS) a uma malha de
personagem real (ex.: o manequim do visual hull). Fluxo:

1. :func:`humanoid_skeleton` — monta um esqueleto humanoide (coluna, cabeça,
   braços, pernas) ajustado à altura do sujeito, em bind pose "braços para baixo"
   (a pose neutra do manequim).
2. :func:`build_rig` — calcula os **pesos de skinning**: cada vértice é ligado aos
   ossos por proximidade ao segmento do osso (peso ∝ 1/dist^p, normalizado).
3. :func:`pose` — dado um conjunto de rotações locais por junta, roda a FK, deriva
   a transformação bind→pose de cada osso e deforma a malha por **DQS** (preserva
   volume nas articulações) ou LBS.

Tudo em ``numpy`` sobre nossas próprias peças — sem Blender.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np
from numpy.typing import NDArray

from ..mesh import Mesh
from .quaternion import quat_from_axis_angle, quat_identity, quat_mul, quat_normalize, quat_rotate
from .skeleton import Joint, Skeleton
from .skinning import dual_quaternion_skinning, linear_blend_skinning

Array = NDArray[np.float64]

# Posições dos ossos como fração da altura (figura em pé, pés em z=0, frente −Y).
# (nome, pai, x, z) — x é meia-largura (lado direito +x); y=0 (perfil fino).
_HUMANOID = [
    ("pelvis", -1, 0.00, 0.50),
    ("spine", 0, 0.00, 0.62),
    ("chest", 1, 0.00, 0.73),
    ("neck", 2, 0.00, 0.82),
    ("head", 3, 0.00, 0.94),
    ("shoulder_R", 2, 0.16, 0.80),
    ("elbow_R", 5, 0.19, 0.60),
    ("wrist_R", 6, 0.20, 0.42),
    ("shoulder_L", 2, -0.16, 0.80),
    ("elbow_L", 8, -0.19, 0.60),
    ("wrist_L", 9, -0.20, 0.42),
    ("hip_R", 0, 0.09, 0.48),
    ("knee_R", 11, 0.10, 0.26),
    ("ankle_R", 12, 0.10, 0.04),
    ("hip_L", 0, -0.09, 0.48),
    ("knee_L", 14, -0.10, 0.26),
    ("ankle_L", 15, -0.10, 0.04),
]


def humanoid_skeleton(height: float = 1.8) -> tuple[Skeleton, list[str]]:
    """Esqueleto humanoide em bind pose, escalado para ``height``."""
    names = [row[0] for row in _HUMANOID]
    world = {}
    joints: list[Joint] = []
    for i, (name, parent, x, z) in enumerate(_HUMANOID):
        pos = np.array([x * height, 0.0, z * height])
        world[i] = pos
        offset = pos if parent < 0 else pos - world[parent]
        joints.append(Joint(name, parent=parent, rest_offset=offset))
    return Skeleton(joints), names


# ----------------------------------------------------------------- skinning --
def _point_segment_distance(points: Array, a: Array, b: Array) -> Array:
    """Distância de cada ponto ``(N,3)`` ao segmento ``a→b``."""
    ab = b - a
    length2 = float(ab @ ab)
    if length2 < 1e-12:
        return np.linalg.norm(points - a, axis=1)
    t = np.clip((points - a) @ ab / length2, 0.0, 1.0)
    proj = a[None, :] + t[:, None] * ab[None, :]
    return np.linalg.norm(points - proj, axis=1)


@dataclass
class Rig:
    """Esqueleto + bind pose + pesos de skinning de uma malha."""

    skeleton: Skeleton
    names: list[str]
    bind_positions: Array          # (B,3) posições mundiais dos ossos em bind
    weights: Array                 # (V,B) pesos por vértice
    height: float


def build_rig(mesh: Mesh, height: float | None = None, power: float = 4.0, keep: int = 4) -> Rig:
    """Ajusta um esqueleto humanoide à malha e calcula os pesos de skinning.

    Peso do vértice ao osso ``∝ 1/dist(vértice, segmento_do_osso)^power``; mantém
    os ``keep`` ossos mais próximos por vértice e normaliza. ``height`` default é a
    extensão vertical (Z) da malha.
    """
    verts = mesh.vertices
    if height is None:
        height = float(verts[:, 2].max() - verts[:, 2].min())
    skeleton, names = humanoid_skeleton(height)
    positions, _ = skeleton.forward_kinematics()

    n_bones = len(names)
    dists = np.empty((len(verts), n_bones), dtype=np.float64)
    for i, joint in enumerate(skeleton.joints):
        a = positions[joint.parent] if joint.parent >= 0 else positions[i]
        dists[:, i] = _point_segment_distance(verts, a, positions[i])

    raw = 1.0 / (dists ** power + 1e-9)
    # mantém apenas os `keep` ossos mais próximos por vértice
    if keep < n_bones:
        cutoff = np.partition(raw, n_bones - keep, axis=1)[:, n_bones - keep][:, None]
        raw = np.where(raw >= cutoff, raw, 0.0)
    weights = raw / raw.sum(axis=1, keepdims=True)
    return Rig(skeleton=skeleton, names=names, bind_positions=positions, weights=weights, height=height)


# -------------------------------------------------------------------- pose ---
def _bone_transforms(rig: Rig, local_rotations: dict[str, Array]) -> tuple[Array, Array]:
    """Transformações rígidas bind→pose por osso (rotação, translação).

    Aplica as rotações locais, roda a FK e, para cada osso ``i``, deriva
    ``R_i = R_pose_i`` e ``t_i = p_pose_i − R_i · p_bind_i`` — o movimento rígido
    que leva um vértice ligado ao osso da bind pose para a pose atual.
    """
    for name, quat in local_rotations.items():
        rig.skeleton.joints[rig.names.index(name)].local_rotation = quat_normalize(np.asarray(quat, float))

    pose_pos, pose_rot = rig.skeleton.forward_kinematics()
    translations = pose_pos - np.array(
        [quat_rotate(pose_rot[i], rig.bind_positions[i]) for i in range(len(rig.names))]
    )
    return pose_rot, translations


def pose(rig: Rig, mesh: Mesh, local_rotations: dict[str, Array], method: str = "dqs") -> Mesh:
    """Deforma a malha para a pose dada. ``method`` = 'dqs' (padrão) ou 'lbs'."""
    rotations, translations = _bone_transforms(rig, local_rotations)
    skin = dual_quaternion_skinning if method == "dqs" else linear_blend_skinning
    deformed = skin(mesh.vertices, rig.weights, rotations, translations)
    # restaura bind (não deixa o rig sujo entre chamadas)
    for joint in rig.skeleton.joints:
        joint.local_rotation = quat_identity()
    return Mesh(deformed, mesh.faces.copy())


# ---------------------------------------------------------------- presets ----
def _rot(axis: tuple[float, float, float], degrees: float) -> Array:
    return quat_from_axis_angle(list(axis), np.radians(degrees))


# Poses de demonstração: rotações locais por junta (eixo no espaço do mundo).
POSES: dict[str, dict[str, Array]] = {
    "a-pose": {
        "shoulder_R": _rot((0, -1, 0), 18),   # braços levemente abertos
        "shoulder_L": _rot((0, 1, 0), 18),
    },
    "wave": {  # braço direito levantado + cotovelo dobrado (aceno)
        "shoulder_R": _rot((0, -1, 0), 130),
        "elbow_R": _rot((1, 0, 0), -55),
    },
    "guitar": {  # ambos os braços à frente/dentro, cotovelos dobrados
        "shoulder_R": _rot((1, 0, 0), 55),
        "elbow_R": _rot((0, 0, 1), 45),
        "shoulder_L": _rot((1, 0, 0), 70),
        "elbow_L": _rot((0, 0, 1), -60),
    },
}
