"""Testes da Fábrica de Atores (normalização). Só numpy, sem trimesh/rede."""

from __future__ import annotations

import numpy as np

from genesis.actor_factory.normalize import (
    convert_up_axis,
    normalize_actor,
    recenter_and_floor,
    scale_to_height,
)
from genesis.mesh import Mesh
from genesis.shapes import icosphere


def _box(center=(0, 0, 0), size=1.0) -> Mesh:
    c = np.asarray(center, float)
    h = size / 2
    v = c + h * np.array(
        [[-1, -1, -1], [1, -1, -1], [1, 1, -1], [-1, 1, -1],
         [-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1]], float
    )
    f = np.array(
        [[0, 1, 2], [0, 2, 3], [4, 6, 5], [4, 7, 6], [0, 4, 5], [0, 5, 1],
         [1, 5, 6], [1, 6, 2], [2, 6, 7], [2, 7, 3], [3, 7, 4], [3, 4, 0]], np.int64
    )
    return Mesh(v, f)


def test_convert_y_up_to_z_up() -> None:
    # um ponto "acima" em Y (0,1,0) deve virar "acima" em Z (0,0,1)
    m = Mesh(np.array([[0.0, 1.0, 0.0]]), np.empty((0, 3), np.int64))
    out = convert_up_axis(m, from_up="y")
    assert np.allclose(out.vertices[0], [0.0, 0.0, 1.0], atol=1e-9)


def test_convert_preserves_handedness() -> None:
    # a conversão é uma rotação pura (det = +1), sem espelhar o modelo
    from genesis.actor_factory.normalize import _UP_TO_Z
    assert np.isclose(np.linalg.det(_UP_TO_Z["y"]), 1.0)


def test_recenter_puts_feet_on_floor_and_centers_xy() -> None:
    box = _box(center=(3.0, -2.0, 5.0), size=2.0)
    out = recenter_and_floor(box)
    v = out.vertices
    assert np.isclose(v[:, 2].min(), 0.0)                  # pé no chão
    assert np.isclose((v[:, 0].min() + v[:, 0].max()) / 2, 0.0)  # centro X
    assert np.isclose((v[:, 1].min() + v[:, 1].max()) / 2, 0.0)  # centro Y


def test_scale_to_height() -> None:
    box = _box(size=0.5)
    out = scale_to_height(box, target_height=1.8, axis=2)
    h = out.vertices[:, 2].max() - out.vertices[:, 2].min()
    assert np.isclose(h, 1.8, atol=1e-9)


def test_normalize_actor_end_to_end() -> None:
    # esfera Y-up deslocada e fora de escala → normalizada
    sphere = icosphere(subdivisions=2, radius=3.0)
    sphere = Mesh(sphere.vertices + np.array([10.0, 5.0, -7.0]), sphere.faces)
    out = normalize_actor(sphere, from_up="y", target_height=1.8)
    v = out.vertices
    assert np.isclose(v[:, 2].max() - v[:, 2].min(), 1.8, atol=1e-6)  # altura
    assert np.isclose(v[:, 2].min(), 0.0, atol=1e-9)                  # chão
    assert np.isclose((v[:, 0].min() + v[:, 0].max()) / 2, 0.0, atol=1e-9)


def _run_all() -> None:
    fns = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]
    for fn in fns:
        fn()
        print(f"  PASS {fn.__name__}")
    print(f"\n{len(fns)} testes OK")


if __name__ == "__main__":
    _run_all()
