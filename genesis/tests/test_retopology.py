"""Testes do Módulo 2. Roda com pytest OU direto: ``python -m genesis.tests.test_retopology``."""

from __future__ import annotations

import numpy as np

from genesis.mesh import Mesh
from genesis.retopology import (
    HealConfig,
    heal,
    laplacian_smooth,
    remove_degenerate_faces,
    remove_duplicate_faces,
    weld_vertices,
)
from genesis.shapes import dirty_icosphere, icosphere
from genesis.spatial import KDTree


def test_icosphere_is_watertight() -> None:
    r = icosphere(subdivisions=2).analyze()
    assert r.is_watertight and r.is_manifold
    assert r.num_boundary_edges == 0
    assert r.estimated_genus == 0.0  # esfera: gênero 0


def test_weld_collapses_duplicates() -> None:
    dirty = dirty_icosphere(subdivisions=2)
    welded = weld_vertices(dirty, tolerance=1e-3)
    assert len(welded.vertices) < len(dirty.vertices)


def test_remove_degenerate_faces() -> None:
    dirty = dirty_icosphere(subdivisions=2)
    before = np.count_nonzero(dirty.face_areas() <= 1e-12)
    assert before > 0
    cleaned = remove_degenerate_faces(dirty)
    assert np.count_nonzero(cleaned.face_areas() <= 1e-12) == 0


def test_remove_duplicate_faces() -> None:
    v = np.array([[0, 0, 0], [1, 0, 0], [0, 1, 0]], dtype=float)
    f = np.array([[0, 1, 2], [2, 0, 1], [0, 1, 2]], dtype=int)  # 3× a mesma face
    out = remove_duplicate_faces(Mesh(v, f))
    assert len(out.faces) == 1


def test_taubin_preserves_volume_better_than_uniform() -> None:
    sphere = icosphere(subdivisions=3)
    radius = lambda m: float(np.mean(np.linalg.norm(m.vertices, axis=1)))  # noqa: E731
    r0 = radius(sphere)
    uniform = laplacian_smooth(sphere, iterations=20, lam=0.5, taubin=False)
    taubin = laplacian_smooth(sphere, iterations=20, lam=0.5, mu=-0.53, taubin=True)
    # Laplaciano puro encolhe; Taubin preserva o raio muito melhor.
    assert radius(uniform) < radius(taubin)
    assert abs(radius(taubin) - r0) < abs(radius(uniform) - r0)


def test_heal_pipeline_end_to_end() -> None:
    dirty = dirty_icosphere(subdivisions=3, noise=0.03)
    result = heal(dirty, HealConfig(weld_tolerance=1e-4, smooth_iterations=6))
    assert result.after.num_degenerate_faces == 0
    assert result.after.num_vertices < result.before.num_vertices
    assert result.after.is_manifold
    assert result.after.is_watertight  # solda re-costura a malha
    assert result.after.num_components == 1


def test_obj_roundtrip(tmp_path=None) -> None:
    import tempfile
    from pathlib import Path

    sphere = icosphere(subdivisions=1)
    d = Path(tempfile.mkdtemp())
    sphere.save_obj(d / "s.obj")
    back = Mesh.load_obj(d / "s.obj")
    assert len(back.vertices) == len(sphere.vertices)
    assert len(back.faces) == len(sphere.faces)


def test_kdtree_matches_bruteforce() -> None:
    rng = np.random.default_rng(0)
    pts = rng.standard_normal((200, 3))
    tree = KDTree(pts)
    q = rng.standard_normal(3)
    dist, idx = tree.query(q)
    brute = int(np.argmin(np.linalg.norm(pts - q, axis=1)))
    assert idx == brute


def _run_all() -> None:
    fns = [v for k, v in sorted(globals().items()) if k.startswith("test_")]
    for fn in fns:
        fn()
        print(f"  PASS {fn.__name__}")
    print(f"\n{len(fns)} testes OK")


if __name__ == "__main__":
    _run_all()
