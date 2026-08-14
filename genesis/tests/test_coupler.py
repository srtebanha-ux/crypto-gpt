"""Testes do Acoplador Matemático (Etapa 3). Só numpy, sem Blender."""

from __future__ import annotations

import numpy as np

from genesis.coupler import (
    affine_matrix,
    attach_prop,
    grip_anchor_matrix,
    quat_to_matrix,
    transform_points,
)
from genesis.mesh import Mesh
from genesis.rig.quaternion import quat_from_axis_angle


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


def test_quat_to_matrix_is_rotation() -> None:
    q = quat_from_axis_angle([0, 0, 1], np.pi / 2)
    R = quat_to_matrix(q)
    assert np.allclose(R.T @ R, np.eye(3), atol=1e-9)      # ortonormal
    assert np.isclose(np.linalg.det(R), 1.0, atol=1e-9)    # sem reflexão
    assert np.allclose(R @ [1, 0, 0], [0, 1, 0], atol=1e-9)  # 90° em Z


def test_affine_applies_scale_rotation_translation() -> None:
    q = quat_from_axis_angle([0, 0, 1], np.pi / 2)
    M = affine_matrix(translation=[1, 2, 3], quat=q, scale=2.0)
    out = transform_points(M, np.array([[1.0, 0.0, 0.0]]))
    # 2·R·(1,0,0) + t = 2·(0,1,0) + (1,2,3) = (1,4,3)
    assert np.allclose(out[0], [1.0, 4.0, 3.0], atol=1e-9)


def test_grip_anchor_lands_grip_on_hand() -> None:
    hand = np.array([0.6, 0.1, 0.4])
    grip = np.array([0.05, 0.0, -0.2])
    q = quat_from_axis_angle([1, 0, 0], 0.7)
    M = grip_anchor_matrix(hand, q, grip_point=grip, scale=1.3)
    landed = transform_points(M, grip[None, :])[0]
    assert np.allclose(landed, hand, atol=1e-9)  # a empunhadura cai exatamente na mão


def test_attach_concatenates_and_preserves_components() -> None:
    character = _box(size=1.0)
    prop = _box(size=0.2)
    M = grip_anchor_matrix([2.0, 0, 0], quat_from_axis_angle([0, 0, 1], 0.3), (0, 0, 0))
    unified = attach_prop(character, prop, M)
    assert len(unified.vertices) == 16
    assert len(unified.faces) == 24
    # duas malhas separadas => duas componentes conexas; cada cubo é water-tight
    report = unified.analyze()
    assert report.num_components == 2
    assert report.num_degenerate_faces == 0


def test_prop_faces_reindexed_within_bounds() -> None:
    character = _box(size=1.0)
    prop = _box(size=0.5)
    M = affine_matrix(translation=[1, 1, 1])
    unified = attach_prop(character, prop, M)
    assert unified.faces.min() >= 0
    assert unified.faces.max() == len(unified.vertices) - 1
    # as faces do prop referenciam só os vértices deslocados
    prop_faces = unified.faces[len(character.faces):]
    assert prop_faces.min() >= len(character.vertices)


def test_couple_end_to_end_obj_roundtrip() -> None:
    import tempfile
    from pathlib import Path

    from genesis.coupler import couple

    d = Path(tempfile.mkdtemp())
    _box(size=1.0).save_obj(d / "char.obj")
    _box(size=0.3).save_obj(d / "prop.obj")
    out = d / "char_com_prop.obj"
    result = couple(
        d / "char.obj", d / "prop.obj",
        hand_position=(0.5, 0.0, 0.3),
        quat=tuple(quat_from_axis_angle([0, 1, 0], 0.5)),
        output_path=out,
    )
    assert out.exists()
    back = Mesh.load_obj(out)
    assert len(back.vertices) == result.character_vertices + result.prop_vertices == 16
    assert back.analyze().num_components == 2


def _run_all() -> None:
    fns = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]
    for fn in fns:
        fn()
        print(f"  PASS {fn.__name__}")
    print(f"\n{len(fns)} testes OK")


if __name__ == "__main__":
    _run_all()
