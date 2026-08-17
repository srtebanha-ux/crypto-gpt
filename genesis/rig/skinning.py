"""Skinning: deforma a malha seguindo os ossos.

Implementa os dois esquemas para comparação direta:

* :func:`linear_blend_skinning` (LBS) — média linear das matrizes por osso.
  Rápido, porém colapsa volume em juntas dobradas/torcidas (candy-wrapper).
* :func:`dual_quaternion_skinning` (DQS) — média sobre movimentos rígidos via
  dual quatérnions; preserva a espessura do membro nas articulações.

Inclui um cilindro de teste com pesos suaves em torno de uma junta, usado para
demonstrar numericamente a diferença (ver ``cli.py --selftest``).
"""

from __future__ import annotations

import numpy as np

from .quaternion import (
    Array,
    dq_blend,
    dq_from_rotation_translation,
    dq_transform_point,
    quat_rotate,
)


def linear_blend_skinning(
    vertices: Array, weights: Array, rotations: Array, translations: Array
) -> Array:
    """LBS: ``v' = Σ_b w_b (R_b v + t_b)`` por vértice.

    ``rotations`` são quatérnions ``(B,4)`` e ``translations`` ``(B,3)`` — as
    transformações delta de cada osso em relação à pose de bind.
    """
    vertices = np.asarray(vertices, dtype=np.float64)
    weights = np.asarray(weights, dtype=np.float64)
    out = np.zeros_like(vertices)
    for b in range(len(rotations)):
        transformed = quat_rotate(rotations[b], vertices) + translations[b]
        out += weights[:, b : b + 1] * transformed
    return out


def dual_quaternion_skinning(
    vertices: Array, weights: Array, rotations: Array, translations: Array
) -> Array:
    """DQS: mistura os movimentos rígidos dos ossos como dual quatérnions."""
    dquats = np.stack(
        [dq_from_rotation_translation(rotations[b], translations[b]) for b in range(len(rotations))]
    )
    blended = dq_blend(dquats, weights)  # (V, 8)
    return dq_transform_point(blended, vertices)


def build_test_cylinder(
    n_rings: int = 21, n_segments: int = 16, height: float = 2.0, radius: float = 0.3
) -> tuple[Array, Array, int]:
    """Cilindro alinhado a Y, com pesos suaves para uma junta no meio.

    Retorna ``(vertices (V,3), weights (V,2), joint_ring_index)`` onde ``weights``
    faz uma transição suave do osso 0 (base) para o osso 1 (topo) atravessando a
    junta em ``y=0``, e ``joint_ring_index`` é o índice do primeiro vértice do
    anel exatamente na junta (peso 0.5/0.5) — a seção onde o candy-wrapper
    aparece.
    """
    ys = np.linspace(-height / 2, height / 2, n_rings)
    angles = np.linspace(0, 2 * np.pi, n_segments, endpoint=False)
    verts = []
    weights = []
    joint_ring = n_rings // 2
    for ri, y in enumerate(ys):
        # Peso do osso 1 (topo) cresce suavemente de 0→1 ao cruzar a junta.
        w_top = float(np.clip(0.5 + 0.5 * np.tanh(4.0 * y / (height / 2)), 0.0, 1.0))
        if ri == joint_ring:
            w_top = 0.5  # anel da junta: 50/50, o pior caso para o LBS
        for a in angles:
            verts.append([radius * np.cos(a), y, radius * np.sin(a)])
            weights.append([1.0 - w_top, w_top])
    joint_ring_index = joint_ring * n_segments
    return (
        np.array(verts, dtype=np.float64),
        np.array(weights, dtype=np.float64),
        joint_ring_index,
    )
