"""Estrutura de malha e análise topológica.

Uma malha triangular é representada por dois arrays ``numpy``:

* ``vertices`` — ``float64`` de forma ``(V, 3)``, as posições dos vértices.
* ``faces``    — ``int64``   de forma ``(F, 3)``, índices dos vértices por face.

Toda a "verdade" topológica deriva da relação **aresta → faces incidentes**.
Uma aresta não-orientada ``(a, b)`` (com ``a < b``) é:

* **de borda** (boundary) se incidente a exatamente 1 face;
* **manifold**  se incidente a exatamente 2 faces;
* **não-manifold** se incidente a 3 ou mais faces.

Uma malha é *water-tight* (fechada) e *manifold* quando não possui arestas de
borda nem arestas não-manifold. A característica de Euler ``χ = V - E + F`` então
relaciona-se ao gênero ``g`` da superfície por ``χ = 2 - 2g`` (superfície
fechada, orientável), o que nos dá uma estimativa de "quantas alças" a topologia
tem — útil para detectar buracos que a IA generativa costuma deixar.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Iterable

import numpy as np
from numpy.typing import NDArray

FloatArray = NDArray[np.float64]
IntArray = NDArray[np.int64]


@dataclass(frozen=True)
class TopologyReport:
    """Diagnóstico imutável do estado topológico de uma malha."""

    num_vertices: int
    num_faces: int
    num_edges: int
    num_boundary_edges: int
    num_nonmanifold_edges: int
    num_degenerate_faces: int
    num_isolated_vertices: int
    num_components: int
    euler_characteristic: int
    estimated_genus: float
    is_watertight: bool
    is_manifold: bool

    def summary(self) -> str:
        """Bloco de texto legível para terminal/log."""
        flag = lambda ok: "OK " if ok else "!! "  # noqa: E731
        return (
            f"  V={self.num_vertices}  F={self.num_faces}  E={self.num_edges}\n"
            f"  {flag(self.num_boundary_edges == 0)}arestas de borda:      {self.num_boundary_edges}\n"
            f"  {flag(self.num_nonmanifold_edges == 0)}arestas não-manifold:  {self.num_nonmanifold_edges}\n"
            f"  {flag(self.num_degenerate_faces == 0)}faces degeneradas:     {self.num_degenerate_faces}\n"
            f"  {flag(self.num_isolated_vertices == 0)}vértices isolados:     {self.num_isolated_vertices}\n"
            f"     componentes conexas:   {self.num_components}\n"
            f"     χ (Euler) = {self.euler_characteristic}  →  gênero ≈ {self.estimated_genus:.1f}\n"
            f"  {flag(self.is_manifold)}manifold:   {self.is_manifold}\n"
            f"  {flag(self.is_watertight)}water-tight: {self.is_watertight}"
        )


class Mesh:
    """Malha triangular indexada, com utilidades topológicas em ``numpy`` puro."""

    __slots__ = ("vertices", "faces")

    def __init__(self, vertices: FloatArray, faces: IntArray) -> None:
        v = np.asarray(vertices, dtype=np.float64)
        f = np.asarray(faces, dtype=np.int64)
        if v.ndim != 2 or v.shape[1] != 3:
            raise ValueError(f"vertices deve ter forma (V,3), recebido {v.shape}")
        if f.size and (f.ndim != 2 or f.shape[1] != 3):
            raise ValueError(f"faces deve ter forma (F,3), recebido {f.shape}")
        if f.size and (f.min() < 0 or f.max() >= len(v)):
            raise ValueError("faces referenciam índices de vértice fora do intervalo")
        self.vertices: FloatArray = v
        self.faces: IntArray = f.reshape(-1, 3) if f.size else np.empty((0, 3), np.int64)

    # ------------------------------------------------------------------ IO ---
    @classmethod
    def load_obj(cls, path: str | Path) -> "Mesh":
        """Lê um ``.obj``, triangulando polígonos em leque (fan triangulation).

        Ignora normais/UVs (``vn``/``vt``); apenas ``v`` e ``f`` importam para a
        topologia. Índices ``.obj`` são 1-based e podem ser negativos (relativos
        ao fim), ambos os casos são normalizados aqui.
        """
        verts: list[tuple[float, float, float]] = []
        faces: list[tuple[int, int, int]] = []
        with open(path, "r", encoding="utf-8", errors="replace") as fh:
            for line in fh:
                if not line or line[0] not in "vf":
                    continue
                parts = line.split()
                if not parts:
                    continue
                tag = parts[0]
                if tag == "v":
                    verts.append((float(parts[1]), float(parts[2]), float(parts[3])))
                elif tag == "f":
                    idx = [cls._parse_face_token(tok, len(verts)) for tok in parts[1:]]
                    # Triangulação em leque: (0,1,2), (0,2,3), ...
                    for k in range(1, len(idx) - 1):
                        faces.append((idx[0], idx[k], idx[k + 1]))
        v = np.array(verts, dtype=np.float64) if verts else np.empty((0, 3), np.float64)
        f = np.array(faces, dtype=np.int64) if faces else np.empty((0, 3), np.int64)
        return cls(v, f)

    @staticmethod
    def _parse_face_token(token: str, vert_count: int) -> int:
        """Converte ``'12/3/4'`` ou ``'-1'`` no índice 0-based do vértice."""
        raw = int(token.split("/", 1)[0])
        return raw - 1 if raw > 0 else vert_count + raw

    def save_obj(self, path: str | Path, header: Iterable[str] | None = None) -> None:
        """Escreve a malha em ``.obj`` (índices 1-based)."""
        lines: list[str] = ["# Pipeline Genesis — Modulo 2 (Retopologia Genetica)"]
        if header:
            lines.extend(f"# {h}" for h in header)
        v = self.vertices
        f = self.faces + 1  # .obj é 1-based
        lines.extend(f"v {x:.6f} {y:.6f} {z:.6f}" for x, y, z in v)
        lines.extend(f"f {a} {b} {c}" for a, b, c in f)
        Path(path).write_text("\n".join(lines) + "\n", encoding="utf-8")

    # ------------------------------------------------------------- geometria -
    def copy(self) -> "Mesh":
        return Mesh(self.vertices.copy(), self.faces.copy())

    def face_areas(self) -> FloatArray:
        """Área de cada triângulo via metade da norma do produto vetorial.

        ``A = ½ ‖(v1 - v0) × (v2 - v0)‖`` — zero indica face degenerada
        (colinear ou de área nula), que corrompe normais e o rigging posterior.
        """
        if len(self.faces) == 0:
            return np.empty(0, np.float64)
        v = self.vertices[self.faces]
        cross = np.cross(v[:, 1] - v[:, 0], v[:, 2] - v[:, 0])
        return 0.5 * np.linalg.norm(cross, axis=1)

    def edges_unique(self) -> tuple[IntArray, IntArray]:
        """Arestas não-orientadas únicas e a contagem de faces incidentes.

        Retorna ``(edges, counts)`` onde ``edges`` tem forma ``(E, 2)`` com
        ``a < b`` e ``counts[i]`` é o número de faces incidentes à aresta ``i``.
        Complexidade ``O(F log F)`` (dominada pelo ``np.unique``).
        """
        f = self.faces
        if len(f) == 0:
            return np.empty((0, 2), np.int64), np.empty(0, np.int64)
        e = np.concatenate([f[:, [0, 1]], f[:, [1, 2]], f[:, [2, 0]]], axis=0)
        e.sort(axis=1)  # não-orientada: (a,b) com a < b
        edges, counts = np.unique(e, axis=0, return_counts=True)
        return edges, counts

    def analyze(self) -> TopologyReport:
        """Computa o :class:`TopologyReport` completo da malha."""
        v_count = len(self.vertices)
        f_count = len(self.faces)
        edges, counts = self.edges_unique()
        e_count = len(edges)
        boundary = int(np.count_nonzero(counts == 1))
        nonmanifold = int(np.count_nonzero(counts > 2))
        degenerate = int(np.count_nonzero(self.face_areas() <= 1e-14)) if f_count else 0

        referenced = np.unique(self.faces) if f_count else np.empty(0, np.int64)
        isolated = v_count - len(referenced)

        components = self._count_components(v_count)
        euler = v_count - e_count + f_count
        genus = (2 - euler) / 2.0
        watertight = boundary == 0 and nonmanifold == 0 and f_count > 0
        manifold = nonmanifold == 0

        return TopologyReport(
            num_vertices=v_count,
            num_faces=f_count,
            num_edges=e_count,
            num_boundary_edges=boundary,
            num_nonmanifold_edges=nonmanifold,
            num_degenerate_faces=degenerate,
            num_isolated_vertices=isolated,
            num_components=components,
            euler_characteristic=euler,
            estimated_genus=genus,
            is_watertight=watertight,
            is_manifold=manifold,
        )

    def _count_components(self, v_count: int) -> int:
        """Conta componentes conexas por union-find sobre as arestas das faces."""
        if v_count == 0:
            return 0
        parent = np.arange(v_count, dtype=np.int64)

        def find(x: int) -> int:
            root = x
            while parent[root] != root:
                root = parent[root]
            while parent[x] != root:  # compressão de caminho
                parent[x], x = root, parent[x]
            return root

        for a, b, c in self.faces:
            for u, w in ((a, b), (b, c), (c, a)):
                ru, rw = find(int(u)), find(int(w))
                if ru != rw:
                    parent[ru] = rw
        roots = {find(i) for i in range(v_count)}
        return len(roots)

    def __repr__(self) -> str:  # pragma: no cover - conveniência
        return f"Mesh(V={len(self.vertices)}, F={len(self.faces)})"
