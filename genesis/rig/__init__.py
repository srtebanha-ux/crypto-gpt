"""Pipeline Gênesis — Módulo 3: Esqueletização Autônoma (Rigging / IK).

Subpacote *autônomo*: depende apenas de ``numpy`` e não importa nenhum outro
módulo do pipeline. Fornece a álgebra de quatérnions/dual quatérnions, o
esqueleto com Cinemática Direta, três solvers de Cinemática Inversa e os dois
esquemas de skinning (LBS vs DQS).
"""

from __future__ import annotations

from .ik import (
    TwoBoneResult,
    apply_hinge_limit,
    bone_lengths,
    solve_ccd,
    solve_fabrik,
    solve_two_bone,
)
from .quaternion import (
    dq_blend,
    dq_from_rotation_translation,
    dq_transform_point,
    quat_from_axis_angle,
    quat_mul,
    quat_rotate,
)
from .skeleton import Joint, Skeleton
from .skinning import dual_quaternion_skinning, linear_blend_skinning, build_test_cylinder

__all__ = [
    "Joint",
    "Skeleton",
    "solve_two_bone",
    "solve_fabrik",
    "solve_ccd",
    "apply_hinge_limit",
    "bone_lengths",
    "TwoBoneResult",
    "quat_from_axis_angle",
    "quat_mul",
    "quat_rotate",
    "dq_from_rotation_translation",
    "dq_transform_point",
    "dq_blend",
    "linear_blend_skinning",
    "dual_quaternion_skinning",
    "build_test_cylinder",
]
