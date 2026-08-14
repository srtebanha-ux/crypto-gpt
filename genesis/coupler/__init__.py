"""Pipeline Gênesis — Acoplador Matemático (parenting de props sem Blender).

Cola um prop rígido (guitarra) na mão do personagem por transformação afim 4×4
(rotação por quatérnion + translação + escala) e concatena as malhas num único
``.obj``. Dependência obrigatória: apenas ``numpy`` (via ``genesis.mesh``).
"""

from __future__ import annotations

from .coupler import (
    CoupleResult,
    affine_matrix,
    attach_prop,
    couple,
    grip_anchor_matrix,
    quat_to_matrix,
    transform_points,
)

__all__ = [
    "affine_matrix",
    "quat_to_matrix",
    "transform_points",
    "grip_anchor_matrix",
    "attach_prop",
    "couple",
    "CoupleResult",
]
