"""Testes do Visual Hull (código bruto): escultura, mesher e silhueta."""

from __future__ import annotations

import tempfile
from pathlib import Path

import numpy as np

from genesis.actor_factory.visual_hull import (
    build_actor_from_images,
    carve,
    extract_silhouette,
    voxels_to_mesh,
)


def test_single_voxel_is_closed_cube() -> None:
    occ = np.zeros((1, 1, 1), bool)
    occ[0, 0, 0] = True
    m = voxels_to_mesh(occ)
    r = m.analyze()
    assert len(m.vertices) == 8 and len(m.faces) == 12
    assert r.is_watertight and r.estimated_genus == 0.0


def test_solid_block_is_watertight_single_component() -> None:
    m = voxels_to_mesh(np.ones((4, 4, 4), bool))
    r = m.analyze()
    assert r.is_watertight and r.num_components == 1


def test_carve_full_masks_fill_cube() -> None:
    full = np.ones((40, 40), bool)
    occ = carve(full, full, full, resolution=24)
    assert occ.all()  # silhuetas cheias em todas as vistas ⇒ cubo cheio


def test_carve_removes_voxels_outside_a_silhouette() -> None:
    full = np.ones((60, 60), bool)
    yy, xx = np.mgrid[0:60, 0:60]
    disk = ((yy - 30) ** 2 + (xx - 30) ** 2) < 28 ** 2  # côncavo dentro da bbox
    # a vista de costas (disco) escava os cantos de (X,Z) que o full não corta
    occ = carve(full, full, disk, resolution=24)
    assert not occ.all() and occ.any()  # cantos escavados, miolo sobra


def test_carve_sphere_silhouettes_gives_watertight_blob() -> None:
    yy, xx = np.mgrid[0:100, 0:100]
    disk = ((yy - 50) ** 2 + (xx - 50) ** 2) < 40 ** 2
    occ = carve(disk, disk, disk, resolution=48)
    m = voxels_to_mesh(occ)
    r = m.analyze()
    assert occ.sum() > 0
    assert r.is_watertight and r.num_components == 1


def _write_char_png(path: Path, shape: str = "bar") -> None:
    from PIL import Image

    h, w = 200, 120
    img = np.full((h, w, 3), 205, dtype=np.uint8)  # fundo neutro claro
    yy, xx = np.mgrid[0:h, 0:w]
    if shape == "bar":
        body = (xx > 45) & (xx < 75) & (yy > 20) & (yy < 180)
    else:  # disk
        body = ((yy - 100) ** 2 + (xx - 60) ** 2) < 45 ** 2
    img[body] = (40, 40, 45)
    img[2, 2] = (10, 10, 10)  # ruído: um pixel de "logo" no canto
    Image.fromarray(img).save(path)


def test_extract_silhouette_isolates_character() -> None:
    d = Path(tempfile.mkdtemp())
    _write_char_png(d / "c.png", "bar")
    mask = extract_silhouette(d / "c.png", threshold=0.18)
    assert mask.sum() > 0
    assert not mask[2, 2]  # o pixel-logo do canto foi descartado (maior componente)
    assert mask[100, 60]   # centro do corpo é frente


def test_build_actor_end_to_end_from_pngs() -> None:
    d = Path(tempfile.mkdtemp())
    for name in ("front", "side", "back"):
        _write_char_png(d / f"{name}.png", "bar")
    out = d / "actor.obj"
    mesh = build_actor_from_images(
        d / "front.png", d / "side.png", d / "back.png",
        resolution=48, smooth_iterations=4, target_height=1.8, output_path=out,
    )
    assert out.exists()
    v = mesh.vertices
    assert np.isclose(v[:, 2].max() - v[:, 2].min(), 1.8, atol=0.05)  # altura-alvo
    assert np.isclose(v[:, 2].min(), 0.0, atol=1e-6)                  # pé no chão
    assert len(mesh.faces) > 0


def _run_all() -> None:
    fns = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]
    for fn in fns:
        fn()
        print(f"  PASS {fn.__name__}")
    print(f"\n{len(fns)} testes OK")


if __name__ == "__main__":
    _run_all()
