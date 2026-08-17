"""Geradores procedurais de malha — para testes e ``--selftest`` sem assets.

Produz uma icosfera (icosaedro subdividido e projetado na esfera) e uma variante
"suja" com o tipo de dano que reconstruções por IA costumam deixar: vértices
duplicados, faces degeneradas e ruído de alta frequência.
"""

from __future__ import annotations

import numpy as np

from .mesh import Mesh


def icosphere(subdivisions: int = 2, radius: float = 1.0) -> Mesh:
    """Icosfera water-tight: icosaedro subdividido e projetado na esfera."""
    phi = (1.0 + np.sqrt(5.0)) / 2.0
    verts = np.array(
        [
            (-1, phi, 0), (1, phi, 0), (-1, -phi, 0), (1, -phi, 0),
            (0, -1, phi), (0, 1, phi), (0, -1, -phi), (0, 1, -phi),
            (phi, 0, -1), (phi, 0, 1), (-phi, 0, -1), (-phi, 0, 1),
        ],
        dtype=np.float64,
    )
    faces = np.array(
        [
            (0, 11, 5), (0, 5, 1), (0, 1, 7), (0, 7, 10), (0, 10, 11),
            (1, 5, 9), (5, 11, 4), (11, 10, 2), (10, 7, 6), (7, 1, 8),
            (3, 9, 4), (3, 4, 2), (3, 2, 6), (3, 6, 8), (3, 8, 9),
            (4, 9, 5), (2, 4, 11), (6, 2, 10), (8, 6, 7), (9, 8, 1),
        ],
        dtype=np.int64,
    )

    for _ in range(subdivisions):
        verts, faces = _subdivide(verts, faces)

    verts = radius * verts / np.linalg.norm(verts, axis=1, keepdims=True)
    return Mesh(verts, faces)


def _subdivide(verts: np.ndarray, faces: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Subdivisão 1→4 com cache de pontos médios (aresta → novo vértice)."""
    verts_list = [tuple(v) for v in verts]
    midpoint: dict[tuple[int, int], int] = {}

    def mid(a: int, b: int) -> int:
        key = (a, b) if a < b else (b, a)
        if key not in midpoint:
            m = (verts[a] + verts[b]) / 2.0
            verts_list.append(tuple(m))
            midpoint[key] = len(verts_list) - 1
        return midpoint[key]

    new_faces: list[tuple[int, int, int]] = []
    for a, b, c in faces:
        ab, bc, ca = mid(a, b), mid(b, c), mid(c, a)
        new_faces += [(a, ab, ca), (b, bc, ab), (c, ca, bc), (ab, bc, ca)]

    return np.array(verts_list, dtype=np.float64), np.array(new_faces, dtype=np.int64)


def dirty_icosphere(
    subdivisions: int = 3, radius: float = 1.0, noise: float = 0.03, seed: int = 7
) -> Mesh:
    """Icosfera danificada: vértices não-compartilhados, ruído e faces degeneradas.

    Simula a saída "caótica" de um motor generativo — cada face fica com seus
    próprios 3 vértices (soldas perdidas), a superfície ganha ruído gaussiano de
    alta frequência, e algumas faces de área nula são injetadas de propósito.
    """
    clean = icosphere(subdivisions, radius)
    rng = np.random.default_rng(seed)

    # Ruído de alta frequência aplicado nos vértices *compartilhados*, antes de
    # explodir — assim as cópias de um mesmo vértice permanecem coincidentes e a
    # solda consegue re-costurar a malha de volta a water-tight.
    noisy = clean.vertices + noise * rng.standard_normal(clean.vertices.shape)

    # "Explode" a indexação: cada face passa a ter vértices próprios (duplicatas).
    exploded_v = noisy[clean.faces].reshape(-1, 3)
    exploded_f = np.arange(len(exploded_v), dtype=np.int64).reshape(-1, 3)

    # Injeta faces degeneradas (área ~0): três cantos praticamente coincidentes.
    n_degenerate = 5
    base = exploded_v[: n_degenerate * 3].reshape(n_degenerate, 3, 3).mean(axis=1)
    deg_v = np.repeat(base, 3, axis=0)
    start = len(exploded_v)
    exploded_v = np.vstack([exploded_v, deg_v])
    deg_f = (start + np.arange(n_degenerate * 3)).reshape(n_degenerate, 3)
    exploded_f = np.vstack([exploded_f, deg_f])

    return Mesh(exploded_v, exploded_f)
