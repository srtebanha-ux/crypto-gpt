"""Particionamento espacial para consultas de vizinhança em ``O(log n)``.

Fornece um KD-tree balanceado em ``numpy`` puro (mediana por eixo, construção
``O(n log n)``) e usa ``scipy.spatial.cKDTree`` como acelerador quando presente.
Consumido por passos que precisam de vizinhança exata (ex.: transferência de
atributos), diferente da solda por quantização, que usa hashing de grade.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from .mesh import FloatArray


def _try_scipy_kdtree(points: FloatArray):
    try:
        from scipy.spatial import cKDTree  # type: ignore

        return cKDTree(points)
    except ImportError:
        return None


@dataclass
class _Node:
    axis: int
    split: float
    index: int  # índice do ponto guardado neste nó
    left: "_Node | None"
    right: "_Node | None"


class KDTree:
    """KD-tree 3D. Usa ``scipy`` se disponível; senão, implementação em numpy."""

    def __init__(self, points: FloatArray) -> None:
        self._points = np.asarray(points, dtype=np.float64)
        if self._points.ndim != 2 or self._points.shape[1] != 3:
            raise ValueError("points deve ter forma (N,3)")
        self._scipy = _try_scipy_kdtree(self._points)
        self._root = (
            None if self._scipy is not None else self._build(np.arange(len(self._points)), 0)
        )

    def _build(self, idx: np.ndarray, depth: int) -> _Node | None:
        if idx.size == 0:
            return None
        axis = depth % 3
        order = idx[np.argsort(self._points[idx, axis], kind="stable")]
        mid = len(order) // 2
        pivot = order[mid]
        return _Node(
            axis=axis,
            split=float(self._points[pivot, axis]),
            index=int(pivot),
            left=self._build(order[:mid], depth + 1),
            right=self._build(order[mid + 1 :], depth + 1),
        )

    def query(self, point: FloatArray) -> tuple[float, int]:
        """Vizinho mais próximo: retorna ``(distância, índice)``."""
        p = np.asarray(point, dtype=np.float64)
        if self._scipy is not None:
            dist, index = self._scipy.query(p)
            return float(dist), int(index)
        best = {"dist2": np.inf, "index": -1}
        self._descend(self._root, p, best)
        return float(np.sqrt(best["dist2"])), int(best["index"])

    def _descend(self, node: _Node | None, p: FloatArray, best: dict) -> None:
        if node is None:
            return
        d2 = float(np.sum((self._points[node.index] - p) ** 2))
        if d2 < best["dist2"]:
            best["dist2"], best["index"] = d2, node.index
        diff = p[node.axis] - node.split
        near, far = (node.left, node.right) if diff < 0 else (node.right, node.left)
        self._descend(near, p, best)
        # Só cruza o hiperplano se a esfera do melhor atual o alcança.
        if diff * diff < best["dist2"]:
            self._descend(far, p, best)
