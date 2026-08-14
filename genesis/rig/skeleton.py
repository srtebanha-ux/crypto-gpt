"""Esqueleto digital: hierarquia de juntas e Cinemática Direta (FK).

Uma junta guarda o *offset de repouso* em relação ao pai (o vetor do osso na
pose neutra) e uma *rotação local* (quatérnion). A Cinemática Direta compõe, do
root às folhas, a transformação de cada junta:

    world_i = world_pai(i) ∘ (rot_local_i, offset_repouso_i)

produzindo a posição mundial de cada junta. É a base sobre a qual a IK resolve.
"""

from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np

from .quaternion import Array, quat_identity, quat_mul, quat_normalize, quat_rotate


@dataclass
class Joint:
    """Uma junta na hierarquia do esqueleto."""

    name: str
    parent: int  # índice do pai, ou -1 para o root
    rest_offset: Array  # vetor do osso em repouso, no frame do pai
    local_rotation: Array = field(default_factory=quat_identity)  # quatérnion (4,)

    def __post_init__(self) -> None:
        self.rest_offset = np.asarray(self.rest_offset, dtype=np.float64)
        self.local_rotation = quat_normalize(np.asarray(self.local_rotation, dtype=np.float64))


class Skeleton:
    """Coleção ordenada de juntas (pais sempre antes dos filhos)."""

    def __init__(self, joints: list[Joint]) -> None:
        for i, j in enumerate(joints):
            if j.parent >= i:
                raise ValueError(
                    f"junta '{j.name}' referencia pai {j.parent} >= {i}; "
                    "pais devem vir antes dos filhos"
                )
        self.joints = joints

    def __len__(self) -> int:
        return len(self.joints)

    def index(self, name: str) -> int:
        for i, j in enumerate(self.joints):
            if j.name == name:
                return i
        raise KeyError(name)

    def forward_kinematics(self) -> tuple[Array, Array]:
        """Resolve FK. Retorna ``(positions (J,3), world_rotations (J,4))``."""
        n = len(self.joints)
        positions = np.zeros((n, 3), dtype=np.float64)
        rotations = np.zeros((n, 4), dtype=np.float64)
        for i, j in enumerate(self.joints):
            if j.parent < 0:
                rotations[i] = j.local_rotation
                positions[i] = j.rest_offset  # posição do root no mundo
            else:
                parent_rot = rotations[j.parent]
                rotations[i] = quat_normalize(quat_mul(parent_rot, j.local_rotation))
                positions[i] = positions[j.parent] + quat_rotate(parent_rot, j.rest_offset)
        return positions, rotations

    def chain_indices(self, leaf: str) -> list[int]:
        """Índices do root até a folha ``leaf`` (útil para montar uma cadeia IK)."""
        idx = self.index(leaf)
        chain = [idx]
        while self.joints[chain[-1]].parent >= 0:
            chain.append(self.joints[chain[-1]].parent)
        chain.reverse()
        return chain
