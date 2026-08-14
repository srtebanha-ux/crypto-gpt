"""Testes do Módulo 3 (Rigging/IK). Roda com pytest OU ``python -m genesis.tests.test_rig``."""

from __future__ import annotations

import numpy as np

from genesis.rig.ik import (
    apply_hinge_limit,
    bone_lengths,
    solve_ccd,
    solve_fabrik,
    solve_two_bone,
)
from genesis.rig.presets import arm_rest_points, finger_chain, humanoid_arm
from genesis.rig.quaternion import (
    dq_from_rotation_translation,
    dq_transform_point,
    quat_from_axis_angle,
    quat_mul,
    quat_rotate,
)
from genesis.rig.skeleton import Joint, Skeleton
from genesis.rig.skinning import (
    dual_quaternion_skinning,
    linear_blend_skinning,
    build_test_cylinder,
)


# ------------------------------------------------------------- quatérnions ---
def test_quat_rotation_90_about_z() -> None:
    q = quat_from_axis_angle([0, 0, 1], np.pi / 2)
    out = quat_rotate(q, np.array([1.0, 0.0, 0.0]))
    assert np.allclose(out, [0.0, 1.0, 0.0], atol=1e-9)


def test_quat_composition_matches_sequential() -> None:
    qz = quat_from_axis_angle([0, 0, 1], 0.4)
    qy = quat_from_axis_angle([0, 1, 0], 0.7)
    v = np.array([0.3, -0.2, 0.5])
    seq = quat_rotate(qz, quat_rotate(qy, v))
    comp = quat_rotate(quat_mul(qz, qy), v)
    assert np.allclose(seq, comp, atol=1e-12)


def test_dual_quaternion_rigid_motion() -> None:
    q = quat_from_axis_angle([0, 0, 1], np.pi / 2)
    t = np.array([1.0, 2.0, 3.0])
    dq = dq_from_rotation_translation(q, t)
    p = np.array([1.0, 0.0, 0.0])
    expected = quat_rotate(q, p) + t
    assert np.allclose(dq_transform_point(dq, p), expected, atol=1e-9)


# --------------------------------------------------------------------- FK -----
def test_forward_kinematics_arm() -> None:
    arm = humanoid_arm(upper=0.55, fore=0.5)
    pos = arm_rest_points(arm)
    assert np.allclose(pos[0], [0, 0, 0])
    assert np.allclose(pos[1], [0.55, 0, 0])
    assert np.allclose(pos[2], [1.05, 0, 0])  # esticado ao longo de +X


def test_skeleton_rejects_forward_parent() -> None:
    try:
        Skeleton([Joint("a", parent=1, rest_offset=[0, 0, 0])])
    except ValueError:
        return
    raise AssertionError("Skeleton deveria rejeitar pai a frente do filho")


# --------------------------------------------------------------------- IK -----
def test_two_bone_reaches_and_bends() -> None:
    arm = humanoid_arm()
    p = arm_rest_points(arm)
    target = np.array([0.6, 0.2, 0.3])
    res = solve_two_bone(p[0], p[1], p[2], target, pole=np.array([0, 0, 1]))
    assert res.reached
    assert np.linalg.norm(res.end - target) < 1e-9      # alcança exatamente
    assert res.interior_angle < np.radians(179.0)       # cotovelo dobrou
    # comprimentos de osso preservados
    assert abs(np.linalg.norm(res.mid - res.root) - 0.55) < 1e-9
    assert abs(np.linalg.norm(res.end - res.mid) - 0.50) < 1e-9


def test_two_bone_unreachable_stretches_straight() -> None:
    arm = humanoid_arm()
    p = arm_rest_points(arm)
    far = np.array([10.0, 0.0, 0.0])
    res = solve_two_bone(p[0], p[1], p[2], far)
    assert not res.reached
    assert res.interior_angle > np.radians(179.0)  # quase esticado


def test_fabrik_converges_without_stretch() -> None:
    chain = finger_chain()
    p = arm_rest_points(chain)
    target = np.array([0.12, -0.06, 0.03])
    before = bone_lengths(p)
    solved = solve_fabrik(p, target, iterations=40)
    assert np.linalg.norm(solved[-1] - target) < 1e-3
    assert np.allclose(bone_lengths(solved), before, atol=1e-9)


def test_ccd_converges() -> None:
    chain = finger_chain((0.1, 0.1, 0.1, 0.1))
    p = arm_rest_points(chain)
    target = np.array([0.2, 0.2, 0.0])
    solved = solve_ccd(p, target, iterations=100)
    assert np.linalg.norm(solved[-1] - target) < 1e-2
    assert np.allclose(bone_lengths(solved), bone_lengths(p), atol=1e-6)


def test_hinge_limit_clamps() -> None:
    root = np.array([0.0, 0.0, 0.0])
    mid = np.array([1.0, 0.0, 0.0])
    end = np.array([2.0, 0.0, 0.0])  # esticado: ângulo interno = 180°
    limited = apply_hinge_limit(root, mid, end, min_angle=0.2, max_angle=np.radians(150))
    a = mid - root
    b = limited - mid
    interior = np.arccos(np.clip(np.dot(-a, b) / (np.linalg.norm(a) * np.linalg.norm(b)), -1, 1))
    assert interior <= np.radians(150) + 1e-6
    assert abs(np.linalg.norm(limited - mid) - 1.0) < 1e-9  # comprimento mantido


# ---------------------------------------------------------------- skinning ---
def test_dqs_preserves_volume_better_than_lbs() -> None:
    verts, weights, ring = build_test_cylinder()
    seg = 16
    ring_idx = slice(ring, ring + seg)
    rotations = np.stack(
        [quat_from_axis_angle([0, 0, 1], 0.0), quat_from_axis_angle([0, 0, 1], np.pi / 2)]
    )
    translations = np.zeros((2, 3))
    rest_r = np.mean(np.linalg.norm(verts[ring_idx][:, [0, 2]], axis=1))

    def cs_radius(d: np.ndarray) -> float:
        pts = d[ring_idx]
        return float(np.mean(np.linalg.norm(pts - pts.mean(axis=0), axis=1)))

    r_lbs = cs_radius(linear_blend_skinning(verts, weights, rotations, translations))
    r_dqs = cs_radius(dual_quaternion_skinning(verts, weights, rotations, translations))
    assert r_lbs < rest_r - 1e-3          # LBS colapsa (candy-wrapper)
    assert abs(r_dqs - rest_r) < abs(r_lbs - rest_r)  # DQS preserva melhor


def _run_all() -> None:
    fns = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]
    for fn in fns:
        fn()
        print(f"  PASS {fn.__name__}")
    print(f"\n{len(fns)} testes OK")


if __name__ == "__main__":
    _run_all()
