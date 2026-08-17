"""CLI do Acoplador Matemático (Etapa 3 do pipeline — sem Blender).

Exemplos::

    # Cola guitarra.obj na mão de zane.obj e exporta a malha unida
    python -m genesis.coupler.cli \
        --character exports/zane.obj --prop exports/guitarra.obj \
        --hand 0.35 -0.10 1.05 --axis-angle 0 0 1 25 \
        --grip 0 0 0 --scale 1.0 --out exports/zane_com_guitarra.obj

    # Autoteste: gera dois cubos procedurais, acopla e verifica
    python -m genesis.coupler.cli --selftest
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

import numpy as np

from ..mesh import Mesh
from ..rig.quaternion import quat_from_axis_angle
from .coupler import couple, grip_anchor_matrix, transform_points


def _resolve_quat(args: argparse.Namespace) -> np.ndarray:
    """Quatérnion a partir de ``--quat`` (w x y z) ou ``--axis-angle`` (x y z graus)."""
    if args.quat is not None:
        return np.array(args.quat, dtype=np.float64)
    if args.axis_angle is not None:
        ax, ay, az, deg = args.axis_angle
        return quat_from_axis_angle([ax, ay, az], np.radians(deg))
    return np.array([1.0, 0.0, 0.0, 0.0])  # identidade


def _unit_box(center=(0.0, 0.0, 0.0), size=1.0) -> Mesh:
    """Cubo triangulado (12 faces) — stand-in procedural para o autoteste."""
    c = np.asarray(center, dtype=np.float64)
    h = size / 2.0
    v = c + h * np.array(
        [
            [-1, -1, -1], [1, -1, -1], [1, 1, -1], [-1, 1, -1],
            [-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1],
        ],
        dtype=np.float64,
    )
    f = np.array(
        [
            [0, 1, 2], [0, 2, 3], [4, 6, 5], [4, 7, 6],
            [0, 4, 5], [0, 5, 1], [1, 5, 6], [1, 6, 2],
            [2, 6, 7], [2, 7, 3], [3, 7, 4], [3, 4, 0],
        ],
        dtype=np.int64,
    )
    return Mesh(v, f)


def _run_selftest() -> int:
    print(">> SELFTEST Acoplador — dois cubos procedurais (sem assets externos)\n")
    character = _unit_box(center=(0.0, 0.0, 0.0), size=1.0)     # "personagem"
    prop = _unit_box(center=(0.0, 0.0, 0.0), size=0.2)          # "guitarra" na origem
    hand = np.array([0.6, 0.1, 0.4])
    quat = quat_from_axis_angle([0, 0, 1], np.radians(30.0))

    matrix = grip_anchor_matrix(hand, quat, grip_point=(0.0, 0.0, 0.0), scale=1.0)
    moved = transform_points(matrix, prop.vertices)
    centroid = moved.mean(axis=0)

    from .coupler import attach_prop

    unified = attach_prop(character, prop, matrix)

    ok_count = len(unified.vertices) == len(character.vertices) + len(prop.vertices)
    ok_faces = len(unified.faces) == len(character.faces) + len(prop.faces)
    ok_moved = np.allclose(centroid, hand, atol=1e-9)  # grip na origem → centro vai p/ a mão
    # topologia de cada componente preservada (o prop continua um cubo fechado)
    report = unified.analyze()

    print(f"   personagem: {len(character.vertices)} v | prop: {len(prop.vertices)} v")
    print(f"   unido: {len(unified.vertices)} v, {len(unified.faces)} f")
    print(f"   centro do prop após acoplar = {tuple(round(float(x),3) for x in centroid)} (mão={tuple(float(x) for x in hand)})")
    print(f"   componentes conexas no resultado = {report.num_components} (esperado 2)")
    print(f"   -> concatenação preserva contagem: {ok_count and ok_faces}")
    print(f"   -> prop ancorado na mão: {ok_moved}")
    ok = ok_count and ok_faces and ok_moved and report.num_components == 2
    print(f"\n>> RESULTADO: {'PASS' if ok else 'FALHA'}")
    return 0 if ok else 1


def _build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="genesis.coupler.cli",
        description="Acoplador Matematico — cola um prop na mao via matriz afim (sem Blender).",
    )
    p.add_argument("--character", help="malha do personagem (.obj)")
    p.add_argument("--prop", help="malha do prop/guitarra (.obj)")
    p.add_argument("--hand", nargs=3, type=float, metavar=("X", "Y", "Z"), help="posicao da mao")
    p.add_argument("--quat", nargs=4, type=float, metavar=("W", "X", "Y", "Z"), help="rotacao (quaternion)")
    p.add_argument(
        "--axis-angle", nargs=4, type=float, metavar=("AX", "AY", "AZ", "DEG"),
        help="rotacao por eixo+angulo (graus)",
    )
    p.add_argument(
        "--grip", nargs=3, type=float, default=[0.0, 0.0, 0.0], metavar=("X", "Y", "Z"),
        help="ponto de empunhadura no espaco local do prop (default: origem)",
    )
    p.add_argument("--scale", type=float, default=1.0, help="escala do prop")
    p.add_argument("--out", help="caminho .obj de saida (default: <character>_com_prop.obj)")
    p.add_argument("--selftest", action="store_true", help="roda o autoteste procedural")
    return p


def main(argv: list[str] | None = None) -> int:
    args = _build_parser().parse_args(argv)

    if args.selftest:
        return _run_selftest()

    missing = [n for n in ("character", "prop", "hand") if getattr(args, n) is None]
    if missing:
        print(f"erro: faltam argumentos: {', '.join('--' + m for m in missing)}", file=sys.stderr)
        return 2
    for label, path in (("character", args.character), ("prop", args.prop)):
        if not Path(path).exists():
            print(f"erro: {label} não encontrado: {path}", file=sys.stderr)
            return 2

    quat = _resolve_quat(args)
    out = Path(args.out) if args.out else Path(args.character).with_name(
        Path(args.character).stem + "_com_prop.obj"
    )
    result = couple(
        character_path=args.character,
        prop_path=args.prop,
        hand_position=tuple(args.hand),
        quat=tuple(quat),
        grip_point=tuple(args.grip),
        scale=args.scale,
        output_path=out,
    )
    print(
        f"[ACOPLADOR] {result.character_vertices} + {result.prop_vertices} vértices "
        f"→ {len(result.mesh.vertices)} | gravado: {out}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
