"""CLI autônoma do Módulo 3 (Rigging / IK).

Exemplos::

    python -m genesis.rig.cli --selftest
    python -m genesis.rig.cli --reach 0.6 0.2 0.3    # alvo p/ o braço de Zane
"""

from __future__ import annotations

import argparse
import sys

import numpy as np

from .ik import solve_fabrik, solve_two_bone
from .presets import arm_rest_points, finger_chain, humanoid_arm
from .skinning import dual_quaternion_skinning, linear_blend_skinning, build_test_cylinder
from .quaternion import quat_from_axis_angle


def _demo_two_bone(target: np.ndarray) -> bool:
    print(">> BRAÇO DE ZANE — IK analítica de 2 ossos (ombro→cotovelo→punho)")
    arm = humanoid_arm()
    p = arm_rest_points(arm)
    root, mid, end = p[0], p[1], p[2]
    res = solve_two_bone(root, mid, end, target, pole=np.array([0.0, 0.0, 1.0]))

    err = float(np.linalg.norm(res.end - target)) if res.reached else float("nan")
    bent = res.interior_angle < np.radians(179.0)
    print(f"   alvo={target}  alcançável={res.reached}")
    print(f"   cotovelo agora em ({res.mid[0]:.3f}, {res.mid[1]:.3f}, {res.mid[2]:.3f})")
    print(f"   ângulo do cotovelo = {np.degrees(res.interior_angle):.1f}°  (180°=esticado)")
    print(f"   punho no alvo: erro = {err:.2e}")
    ok = res.reached and err < 1e-9 and bent
    print(f"   -> {'PASS' if ok else 'FALHA'}: quando a mão move, o cotovelo dobrou\n")
    return ok


def _demo_fabrik() -> bool:
    print(">> DEDO DE ZANE — FABRIK numa cadeia de 4 juntas até um traste")
    chain = finger_chain()
    p = arm_rest_points(chain)
    target = np.array([0.12, -0.06, 0.03])  # um traste abaixo/à frente
    solved = solve_fabrik(p, target, iterations=30)
    err = float(np.linalg.norm(solved[-1] - target))
    lengths_before = np.linalg.norm(np.diff(p, axis=0), axis=1)
    lengths_after = np.linalg.norm(np.diff(solved, axis=0), axis=1)
    stretch = float(np.max(np.abs(lengths_after - lengths_before)))
    print(f"   ponta do dedo: erro ao alvo = {err:.2e}")
    print(f"   maior variação de comprimento de osso = {stretch:.2e} (deve ~0)")
    ok = err < 1e-3 and stretch < 1e-9
    print(f"   -> {'PASS' if ok else 'FALHA'}: dedo alcança o traste sem esticar ossos\n")
    return ok


def _demo_skinning() -> bool:
    print(">> ARTICULAÇÃO — Dual Quaternion vs Linear Blend Skinning (candy-wrapper)")
    verts, weights, ring = build_test_cylinder()
    seg = 16
    ring_idx = slice(ring, ring + seg)

    # Osso 0 fica parado; osso 1 dobra 90° em torno de Z, articulando na junta (y=0).
    angle = np.radians(90.0)
    q0 = quat_from_axis_angle([0, 0, 1], 0.0)
    q1 = quat_from_axis_angle([0, 0, 1], angle)
    rotations = np.stack([q0, q1])
    translations = np.zeros((2, 3))  # junta na origem: rotação pura

    rest_radius = float(np.mean(np.linalg.norm(verts[ring_idx][:, [0, 2]], axis=1)))
    lbs = linear_blend_skinning(verts, weights, rotations, translations)
    dqs = dual_quaternion_skinning(verts, weights, rotations, translations)

    def cross_section_radius(deformed: np.ndarray) -> float:
        ring_pts = deformed[ring_idx]
        center = ring_pts.mean(axis=0)
        return float(np.mean(np.linalg.norm(ring_pts - center, axis=1)))

    r_lbs = cross_section_radius(lbs)
    r_dqs = cross_section_radius(dqs)
    print(f"   raio de repouso da seção na junta = {rest_radius:.4f}")
    print(f"   LBS: raio = {r_lbs:.4f}  (perda de volume = {100*(1-r_lbs/rest_radius):.1f}%)")
    print(f"   DQS: raio = {r_dqs:.4f}  (perda de volume = {100*(1-r_dqs/rest_radius):.1f}%)")
    ok = abs(r_dqs - rest_radius) < abs(r_lbs - rest_radius) and r_dqs > r_lbs
    print(f"   -> {'PASS' if ok else 'FALHA'}: DQS preserva a espessura melhor que LBS\n")
    return ok


def _run_selftest() -> int:
    print(">> SELFTEST Módulo 3 (Rigging/IK) — sem assets externos\n")
    results = [
        _demo_two_bone(np.array([0.6, 0.2, 0.3])),
        _demo_fabrik(),
        _demo_skinning(),
    ]
    total = sum(results)
    print(f">> RESULTADO: {total}/{len(results)} demos PASS")
    return 0 if all(results) else 1


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="genesis.rig.cli",
        description="Pipeline Genesis — Modulo 3: Rigging / Cinematica Inversa.",
    )
    parser.add_argument("--selftest", action="store_true", help="roda as demos de autoteste")
    parser.add_argument(
        "--reach", nargs=3, type=float, metavar=("X", "Y", "Z"),
        help="resolve o braço de Zane para alcançar o alvo (x y z)",
    )
    args = parser.parse_args(argv)

    if args.reach is not None:
        return 0 if _demo_two_bone(np.array(args.reach)) else 1
    if args.selftest:
        return _run_selftest()

    parser.print_help(sys.stderr)
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
