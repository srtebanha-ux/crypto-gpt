"""Quatérnions e Dual Quatérnions — a álgebra de rotação/rigidez do rigging.

Convenção: quatérnion unitário ``q = (w, x, y, z)`` com parte real ``w`` primeiro.
Todas as operações são vetorizadas: aceitam formas ``(..., 4)`` para quatérnions e
``(..., 3)`` para vetores, fazendo *broadcast* sobre as dimensões-batch à esquerda.

**Por que Dual Quatérnions?** O Linear Blend Skinning (LBS) interpola matrizes
por combinação linear, o que colapsa o volume em juntas dobradas/torcidas (o
artefato "candy-wrapper"). O Dual Quaternion Skinning (DQS) interpola sobre o
grupo de movimentos rígidos SE(3): um dual quatérnion unitário ``q̂ = q_r + ε q_d``
(com ``ε² = 0``) codifica rotação **e** translação como um parafuso rígido, então
a média de poses continua sendo uma pose rígida — preservando a espessura do
membro nas articulações de Zane, Vance e Leo.
"""

from __future__ import annotations

import numpy as np
from numpy.typing import NDArray

Array = NDArray[np.float64]


# ------------------------------------------------------------- quatérnions ---
def quat_identity() -> Array:
    return np.array([1.0, 0.0, 0.0, 0.0])


def quat_normalize(q: Array) -> Array:
    q = np.asarray(q, dtype=np.float64)
    n = np.linalg.norm(q, axis=-1, keepdims=True)
    return q / np.where(n > 0, n, 1.0)


def quat_conjugate(q: Array) -> Array:
    q = np.asarray(q, dtype=np.float64)
    out = q.copy()
    out[..., 1:] *= -1.0
    return out


def quat_from_axis_angle(axis: Array, angle: float) -> Array:
    """Quatérnion de rotação de ``angle`` radianos em torno de ``axis``."""
    axis = np.asarray(axis, dtype=np.float64)
    axis = axis / (np.linalg.norm(axis) or 1.0)
    half = angle / 2.0
    return np.concatenate([[np.cos(half)], np.sin(half) * axis])


def quat_mul(a: Array, b: Array) -> Array:
    """Produto de Hamilton ``a ⊗ b`` (composição de rotações), vetorizado."""
    a = np.asarray(a, dtype=np.float64)
    b = np.asarray(b, dtype=np.float64)
    aw, ax, ay, az = a[..., 0], a[..., 1], a[..., 2], a[..., 3]
    bw, bx, by, bz = b[..., 0], b[..., 1], b[..., 2], b[..., 3]
    return np.stack(
        [
            aw * bw - ax * bx - ay * by - az * bz,
            aw * bx + ax * bw + ay * bz - az * by,
            aw * by - ax * bz + ay * bw + az * bx,
            aw * bz + ax * by - ay * bx + az * bw,
        ],
        axis=-1,
    )


def quat_rotate(q: Array, v: Array) -> Array:
    """Aplica a rotação ``q`` ao vetor ``v`` via ``q ⊗ (0,v) ⊗ q*``."""
    q = quat_normalize(q)
    v = np.asarray(v, dtype=np.float64)
    qv = q[..., 1:]
    w = q[..., 0:1]
    # Fórmula de Rodrigues em forma quaterniônica (evita montar q⊗v⊗q*):
    t = 2.0 * np.cross(qv, v)
    return v + w * t + np.cross(qv, t)


def quat_between(a: Array, b: Array) -> Array:
    """Menor rotação que leva o vetor ``a`` ao vetor ``b``."""
    a = a / (np.linalg.norm(a) or 1.0)
    b = b / (np.linalg.norm(b) or 1.0)
    d = float(np.dot(a, b))
    if d >= 1.0 - 1e-12:
        return quat_identity()
    if d <= -1.0 + 1e-12:  # opostos: escolhe qualquer eixo ortogonal
        axis = np.cross(a, [1.0, 0.0, 0.0])
        if np.linalg.norm(axis) < 1e-6:
            axis = np.cross(a, [0.0, 1.0, 0.0])
        return quat_from_axis_angle(axis, np.pi)
    axis = np.cross(a, b)
    return quat_normalize(np.concatenate([[1.0 + d], axis]))


# --------------------------------------------------------- dual quatérnions --
def dq_from_rotation_translation(q: Array, t: Array) -> Array:
    """Dual quatérnion unitário ``(q_r | q_d)`` de forma ``(8,)`` a partir de R,t.

    ``q_r = q`` (rotação) e ``q_d = ½ (0, t) ⊗ q_r`` (a parte dual codifica a
    translação acoplada à rotação).
    """
    q = quat_normalize(q)
    t_quat = np.concatenate([[0.0], np.asarray(t, dtype=np.float64)])
    dual = 0.5 * quat_mul(t_quat, q)
    return np.concatenate([q, dual])


def dq_real(dq: Array) -> Array:
    return dq[..., :4]


def dq_dual(dq: Array) -> Array:
    return dq[..., 4:]


def dq_translation(dq: Array) -> Array:
    """Extrai a translação de um dual quatérnion unitário: ``t = 2 q_d ⊗ q_r*``."""
    t = 2.0 * quat_mul(dq_dual(dq), quat_conjugate(dq_real(dq)))
    return t[..., 1:]


def dq_normalize(dq: Array) -> Array:
    """Normaliza pela magnitude da parte real (mantém ``q̂`` unitário)."""
    n = np.linalg.norm(dq_real(dq), axis=-1, keepdims=True)
    n = np.where(n > 0, n, 1.0)
    return dq / n


def dq_transform_point(dq: Array, p: Array) -> Array:
    """Aplica o movimento rígido do dual quatérnion ao ponto ``p``."""
    dq = dq_normalize(dq)
    return quat_rotate(dq_real(dq), p) + dq_translation(dq)


def dq_blend(dquats: Array, weights: Array) -> Array:
    """Dual Quaternion Linear Blending (DLB) com correção de antipodalidade.

    ``dquats`` tem forma ``(B, 8)`` (um dq por osso) e ``weights`` forma ``(V, B)``.
    Retorna ``(V, 8)``: para cada vértice, a média ponderada dos dqs dos ossos,
    renormalizada. Antes de somar, alinhamos o sinal de cada dq ao do osso de
    **maior peso** do vértice (dq e −dq representam a mesma pose; sem esse
    alinhamento a média pode cancelar rotações ~180°).
    """
    dquats = np.asarray(dquats, dtype=np.float64)
    weights = np.asarray(weights, dtype=np.float64)
    dominant = np.argmax(weights, axis=1)  # (V,)
    ref_real = dq_real(dquats)[dominant]  # (V, 4)
    # sinal[v,b] = +1 se o dq do osso b alinha com o dq dominante do vértice v
    dots = np.einsum("vk,bk->vb", ref_real, dq_real(dquats))
    signs = np.where(dots < 0.0, -1.0, 1.0)  # (V, B)
    weighted = (weights * signs)[:, :, None] * dquats[None, :, :]  # (V, B, 8)
    blended = weighted.sum(axis=1)  # (V, 8)
    return dq_normalize(blended)
