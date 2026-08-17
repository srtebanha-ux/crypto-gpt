"""CLI de rig+pose: aplica um esqueleto humanoide a uma malha e a posa.

Exemplos::

    # lista as poses disponíveis
    python -m genesis.rig.pose_cli --input exports/zane.obj --list

    # posa o Zane acenando e exporta a malha deformada
    python -m genesis.rig.pose_cli --input exports/zane.obj --pose wave \
        --out exports/zane_wave.obj

    # pose de tocar violão, com LBS em vez de DQS (para comparar)
    python -m genesis.rig.pose_cli --input exports/zane.obj --pose guitar \
        --method lbs --out exports/zane_guitar.obj
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

from ..mesh import Mesh
from .autorig import POSES, build_rig, pose


def _build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="genesis.rig.pose_cli",
        description="Auto-rig humanoide + posagem (esqueleto, skinning DQS) sem Blender.",
    )
    p.add_argument("--input", required=True, help="malha .obj do personagem")
    p.add_argument("--pose", help=f"pose a aplicar: {', '.join(POSES)}")
    p.add_argument("--out", help="malha .obj de saida (posada)")
    p.add_argument("--method", choices=["dqs", "lbs"], default="dqs", help="skinning (default dqs)")
    p.add_argument("--list", action="store_true", help="lista as poses e sai")
    return p


def main(argv: list[str] | None = None) -> int:
    args = _build_parser().parse_args(argv)

    if args.list:
        print("poses disponíveis:", ", ".join(POSES))
        return 0
    if not args.pose or not args.out:
        print("erro: informe --pose e --out (ou --list)", file=sys.stderr)
        return 2
    if args.pose not in POSES:
        print(f"erro: pose '{args.pose}' inválida. Opções: {', '.join(POSES)}", file=sys.stderr)
        return 2
    if not Path(args.input).exists():
        print(f"erro: arquivo não encontrado: {args.input}", file=sys.stderr)
        return 2

    mesh = Mesh.load_obj(args.input)
    rig = build_rig(mesh)
    print(f"[AUTO-RIG] esqueleto ajustado: {len(rig.names)} ossos, altura {rig.height:.2f} m")
    print(f"[AUTO-RIG] pesos de skinning: {mesh.vertices.shape[0]} vértices")

    posed = pose(rig, mesh, POSES[args.pose], method=args.method)
    moved = float(
        (((posed.vertices - mesh.vertices) ** 2).sum(axis=1) ** 0.5).max()
    )
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    posed.save_obj(out, header=[f"pose={args.pose} skinning={args.method}"])
    print(f"[AUTO-RIG] pose '{args.pose}' aplicada ({args.method}); "
          f"maior deslocamento de vértice = {moved:.3f} m")
    print(f">> gravado: {out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
