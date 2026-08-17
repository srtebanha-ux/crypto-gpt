"""Solvers de Cinemática Inversa (IK).

Três abordagens, cada uma no seu regime:

* :func:`solve_two_bone` — analítica (lei dos cossenos) para membros de 2 ossos
  (braço, perna). Exata em uma única passada; usa um *pole vector* para escolher
  a direção em que o cotovelo/joelho dobra.
* :func:`solve_fabrik` — FABRIK (Forward And Backward Reaching IK) para cadeias
  de comprimento arbitrário (ex.: os dedos de Zane no braço do violão).
* :func:`solve_ccd` — Cyclic Coordinate Descent, que opera em espaço de rotação e
  acomoda naturalmente limites angulares por junta.

Todas trabalham em **espaço de posições mundiais** (arrays ``(N, 3)``) e mantêm os
comprimentos de osso fixos — a restrição rígida que impede o membro de esticar.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from .quaternion import Array


def bone_lengths(points: Array) -> Array:
    """Comprimentos dos segmentos de uma cadeia de juntas ``(N,3)`` → ``(N-1,)``."""
    p = np.asarray(points, dtype=np.float64)
    return np.linalg.norm(np.diff(p, axis=0), axis=1)


def _normalize(v: Array) -> Array:
    n = np.linalg.norm(v)
    return v / n if n > 1e-12 else v


# --------------------------------------------------- IK analítica de 2 ossos --
@dataclass
class TwoBoneResult:
    root: Array
    mid: Array
    end: Array
    reached: bool  # True se o alvo está dentro do alcance
    interior_angle: float  # ângulo do cotovelo (rad); π = esticado


def solve_two_bone(
    root: Array, mid: Array, end: Array, target: Array, pole: Array | None = None
) -> TwoBoneResult:
    """IK analítica de 2 ossos. Mantém ``root`` fixo e leva ``end`` ao alvo.

    Usa a lei dos cossenos para achar o ângulo interno da junta média (cotovelo):
    dados os comprimentos ``a=|root→mid|``, ``b=|mid→end|`` e a distância ``c`` até o
    alvo (limitada a ``a+b``), o ângulo do cotovelo é
    ``θ = arccos((a²+b²−c²)/(2ab))``. O *pole vector* fixa o plano em que o
    membro dobra, garantindo que o cotovelo aponte para uma direção anatômica.
    """
    root = np.asarray(root, dtype=np.float64)
    a = float(np.linalg.norm(mid - root))
    b = float(np.linalg.norm(end - mid))
    to_target = np.asarray(target, dtype=np.float64) - root
    c = float(np.linalg.norm(to_target))
    reach = a + b
    reached = c <= reach + 1e-9
    c_eff = min(c, reach) if c > 1e-12 else 1e-12
    direction = _normalize(to_target) if c > 1e-12 else np.array([1.0, 0.0, 0.0])

    # Distância do root à projeção do cotovelo sobre a linha root→alvo, e a
    # altura do cotovelo fora dessa linha (ambas via lei dos cossenos).
    cos_root = np.clip((a * a + c_eff * c_eff - b * b) / (2 * a * c_eff), -1.0, 1.0)
    along = a * cos_root
    height = a * np.sqrt(max(0.0, 1.0 - cos_root * cos_root))

    # Direção do "cotovelo" no plano definido pelo pole vector.
    if pole is None:
        pole = np.array([0.0, 0.0, 1.0])
    pole = np.asarray(pole, dtype=np.float64) - root
    perp = pole - np.dot(pole, direction) * direction  # componente ⊥ à linha
    perp = _normalize(perp)
    if np.linalg.norm(perp) < 1e-9:  # pole degenerado: escolhe um ⊥ qualquer
        perp = _normalize(np.cross(direction, [1.0, 0.0, 0.0]))
        if np.linalg.norm(perp) < 1e-9:
            perp = _normalize(np.cross(direction, [0.0, 1.0, 0.0]))

    new_mid = root + along * direction + height * perp
    new_end = root + c_eff * direction

    cos_elbow = np.clip((a * a + b * b - c_eff * c_eff) / (2 * a * b), -1.0, 1.0)
    interior = float(np.arccos(cos_elbow))
    return TwoBoneResult(root=root, mid=new_mid, end=new_end, reached=reached, interior_angle=interior)


# ----------------------------------------------------------------- FABRIK ----
def solve_fabrik(
    points: Array,
    target: Array,
    lengths: Array | None = None,
    iterations: int = 20,
    tol: float = 1e-4,
) -> Array:
    """FABRIK: resolve a cadeia mantendo ``points[0]`` (root) fixo.

    Cada iteração faz duas passadas que reposicionam as juntas ao longo das
    linhas junta→junta preservando os comprimentos: uma *para trás* (do alvo ao
    root) e outra *para frente* (do root de volta ao alvo). Converge rápido e
    sem singularidades matriciais (não inverte Jacobiano).
    """
    p = np.array(points, dtype=np.float64)
    n = len(p)
    if n < 2:
        return p
    d = np.asarray(lengths, dtype=np.float64) if lengths is not None else bone_lengths(p)
    reach = float(d.sum())
    root = p[0].copy()
    target = np.asarray(target, dtype=np.float64)

    if np.linalg.norm(target - root) > reach:  # alvo inalcançável: estica reto
        dir_ = _normalize(target - root)
        for i in range(1, n):
            p[i] = p[i - 1] + d[i - 1] * dir_
        return p

    for _ in range(iterations):
        if np.linalg.norm(p[-1] - target) < tol:
            break
        # Passada para trás: fixa o end no alvo e recua.
        p[-1] = target
        for i in range(n - 2, -1, -1):
            r = _normalize(p[i] - p[i + 1])
            p[i] = p[i + 1] + d[i] * r
        # Passada para frente: recoloca o root e avança.
        p[0] = root
        for i in range(1, n):
            r = _normalize(p[i] - p[i - 1])
            p[i] = p[i - 1] + d[i - 1] * r
    return p


# ------------------------------------------------------------------- CCD -----
def solve_ccd(
    points: Array,
    target: Array,
    iterations: int = 40,
    tol: float = 1e-4,
    max_step: float | None = None,
) -> Array:
    """Cyclic Coordinate Descent: rotaciona cada junta (do fim ao início).

    Em cada passo, gira a junta ``i`` para alinhar o vetor junta→end ao vetor
    junta→alvo. ``max_step`` (radianos) limita a rotação por junta a cada passo —
    útil para poses suaves e como aproximação de limites articulares.
    """
    p = np.array(points, dtype=np.float64)
    n = len(p)
    if n < 2:
        return p
    target = np.asarray(target, dtype=np.float64)

    for _ in range(iterations):
        if np.linalg.norm(p[-1] - target) < tol:
            break
        for i in range(n - 2, -1, -1):
            to_end = p[-1] - p[i]
            to_target = target - p[i]
            ne, nt = np.linalg.norm(to_end), np.linalg.norm(to_target)
            if ne < 1e-9 or nt < 1e-9:
                continue
            u, v = to_end / ne, to_target / nt
            axis = np.cross(u, v)
            s = np.linalg.norm(axis)
            if s < 1e-9:
                continue
            axis /= s
            angle = float(np.arctan2(s, np.clip(np.dot(u, v), -1.0, 1.0)))
            if max_step is not None:
                angle = float(np.clip(angle, -max_step, max_step))
            # Roda todas as juntas após i em torno de `axis` centrado em p[i].
            rot = _axis_angle_matrix(axis, angle)
            p[i + 1 :] = (p[i + 1 :] - p[i]) @ rot.T + p[i]
    return p


def _axis_angle_matrix(axis: Array, angle: float) -> Array:
    """Matriz de rotação 3×3 via fórmula de Rodrigues."""
    x, y, z = axis
    c, s = np.cos(angle), np.sin(angle)
    C = 1.0 - c
    return np.array(
        [
            [c + x * x * C, x * y * C - z * s, x * z * C + y * s],
            [y * x * C + z * s, c + y * y * C, y * z * C - x * s],
            [z * x * C - y * s, z * y * C + x * s, c + z * z * C],
        ]
    )


# ----------------------------------------------------- restrição de dobradiça -
def apply_hinge_limit(
    root: Array, mid: Array, end: Array, min_angle: float, max_angle: float
) -> Array:
    """Restringe o ângulo interno da junta média a ``[min_angle, max_angle]`` (rad).

    Modela cotovelo/joelho: dobradiças que não hiperextendem nem invertem. Se o
    ângulo atual violar o limite, reposiciona ``end`` girando o segmento
    ``mid→end`` no plano do membro até o ângulo mais próximo válido.
    """
    a = mid - root
    b = end - mid
    na, nb = np.linalg.norm(a), np.linalg.norm(b)
    if na < 1e-9 or nb < 1e-9:
        return np.asarray(end, dtype=np.float64)
    cos_cur = np.clip(np.dot(-a, b) / (na * nb), -1.0, 1.0)
    interior = float(np.arccos(cos_cur))
    clamped = float(np.clip(interior, min_angle, max_angle))
    if abs(clamped - interior) < 1e-9:
        return np.asarray(end, dtype=np.float64)
    axis = np.cross(a, b)
    if np.linalg.norm(axis) < 1e-9:  # colinear: usa um eixo ⊥ arbitrário
        axis = np.cross(a, [1.0, 0.0, 0.0])
        if np.linalg.norm(axis) < 1e-9:
            axis = np.cross(a, [0.0, 1.0, 0.0])
    axis = axis / np.linalg.norm(axis)
    rot = _axis_angle_matrix(axis, clamped - interior)
    return mid + rot @ b
