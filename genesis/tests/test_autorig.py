"""Testes do auto-rig (esqueleto humanoide, skinning, posagem)."""

from __future__ import annotations

import numpy as np

from genesis.mesh import Mesh
from genesis.rig.autorig import POSES, build_rig, humanoid_skeleton, pose


def _humanoid_cloud(height: float = 1.8, n: int = 3000, seed: int = 0) -> Mesh:
    """Nuvem de pontos com forma vagamente humana (tronco + 4 membros)."""
    rng = np.random.default_rng(seed)
    parts = [
        (np.array([0.0, 0.0, 0.55 * height]), np.array([0.15, 0.10, 0.35 * height])),  # tronco
        (np.array([0.18 * height, 0, 0.60 * height]), np.array([0.05, 0.05, 0.22 * height])),  # braço R
        (np.array([-0.18 * height, 0, 0.60 * height]), np.array([0.05, 0.05, 0.22 * height])),  # braço L
        (np.array([0.09 * height, 0, 0.25 * height]), np.array([0.06, 0.06, 0.25 * height])),  # perna R
        (np.array([-0.09 * height, 0, 0.25 * height]), np.array([0.06, 0.06, 0.25 * height])),  # perna L
        (np.array([0.0, 0, 0.92 * height]), np.array([0.09, 0.09, 0.09])),  # cabeça
    ]
    pts = np.concatenate([c + s * rng.standard_normal((n, 3)) for c, s in parts])
    faces = np.array([[0, 1, 2]], np.int64)  # face dummy (só precisamos de vértices)
    return Mesh(pts, faces)


def test_skeleton_scales_to_height() -> None:
    skel, names = humanoid_skeleton(1.8)
    pos, _ = skel.forward_kinematics()
    assert "head" in names and "wrist_R" in names
    assert np.isclose(pos[names.index("head")][2], 0.94 * 1.8, atol=1e-9)
    assert np.isclose(pos[names.index("ankle_R")][2], 0.04 * 1.8, atol=1e-9)


def test_build_rig_weights_sum_to_one() -> None:
    mesh = _humanoid_cloud()
    rig = build_rig(mesh)
    sums = rig.weights.sum(axis=1)
    assert np.allclose(sums, 1.0, atol=1e-9)
    assert rig.weights.shape == (len(mesh.vertices), len(rig.names))
    assert np.all(rig.weights >= 0.0)


def test_pose_moves_targeted_limb_not_others() -> None:
    mesh = _humanoid_cloud(height=1.8)
    rig = build_rig(mesh, height=1.8)  # fixa a altura (a nuvem tem caudas ruidosas)
    posed = pose(rig, mesh, POSES["wave"], method="dqs")  # levanta braço direito
    disp = np.linalg.norm(posed.vertices - mesh.vertices, axis=1)

    v = mesh.vertices
    right_arm = (v[:, 0] > 0.22) & (v[:, 2] > 0.9)   # região do braço direito
    left_leg = (v[:, 0] < -0.05) & (v[:, 2] < 0.6)   # região da perna esquerda
    assert right_arm.sum() > 0 and left_leg.sum() > 0
    assert disp[right_arm].mean() > 0.05        # braço direito se moveu
    assert disp[left_leg].mean() < 0.02         # perna esquerda ~parada


def test_pose_restores_bind_between_calls() -> None:
    mesh = _humanoid_cloud()
    rig = build_rig(mesh)
    a = pose(rig, mesh, POSES["wave"])
    b = pose(rig, mesh, POSES["wave"])
    assert np.allclose(a.vertices, b.vertices)  # idempotente (bind restaurada)


def test_dqs_and_lbs_both_run() -> None:
    mesh = _humanoid_cloud()
    rig = build_rig(mesh)
    d = pose(rig, mesh, POSES["guitar"], method="dqs")
    l = pose(rig, mesh, POSES["guitar"], method="lbs")
    assert d.vertices.shape == l.vertices.shape == mesh.vertices.shape
    # DQS e LBS diferem nas juntas dobradas
    assert not np.allclose(d.vertices, l.vertices)


def _run_all() -> None:
    fns = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]
    for fn in fns:
        fn()
        print(f"  PASS {fn.__name__}")
    print(f"\n{len(fns)} testes OK")


if __name__ == "__main__":
    _run_all()
