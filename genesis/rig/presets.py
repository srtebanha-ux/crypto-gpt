"""Presets de esqueleto para os membros da MoonSilver.

Cadeias mínimas, porém anatomicamente coerentes, para exercitar a IK: o braço de
2 ossos (Zane dedilhando o violão) e uma cadeia de 4 juntas do dedo (posicionar
a ponta do dedo num traste). Comprimentos em unidades arbitrárias de cena.
"""

from __future__ import annotations

import numpy as np

from .quaternion import quat_identity
from .skeleton import Joint, Skeleton


def humanoid_arm(upper: float = 0.55, fore: float = 0.5) -> Skeleton:
    """Braço direito: ombro → cotovelo → punho, estendido ao longo de +X."""
    return Skeleton(
        [
            Joint("shoulder", parent=-1, rest_offset=[0.0, 0.0, 0.0]),
            Joint("elbow", parent=0, rest_offset=[upper, 0.0, 0.0]),
            Joint("wrist", parent=1, rest_offset=[fore, 0.0, 0.0]),
        ]
    )


def finger_chain(segments: tuple[float, ...] = (0.10, 0.06, 0.04)) -> Skeleton:
    """Cadeia de dedo (metacarpo + falanges) ao longo de +X para IK FABRIK."""
    joints = [Joint("knuckle", parent=-1, rest_offset=[0.0, 0.0, 0.0])]
    names = ["prox", "mid", "dist", "tip"]
    for i, seg in enumerate(segments):
        joints.append(Joint(names[i], parent=i, rest_offset=[seg, 0.0, 0.0]))
    return Skeleton(joints)


def arm_rest_points(skeleton: Skeleton) -> np.ndarray:
    """Posições mundiais em repouso (atalho para FK sem rotações)."""
    positions, _ = skeleton.forward_kinematics()
    return positions
