"""CLI autônoma do Módulo 2 (Retopologia Genética).

Exemplos::

    # Cura um asset bruto e grava o resultado
    python -m genesis.cli entrada.obj -o saida.obj --smooth 8 --weld-tol 1e-4

    # Só diagnostica a topologia, sem escrever nada
    python -m genesis.cli entrada.obj --report

    # Autoteste: gera malha suja procedural, cura e compara antes/depois
    python -m genesis.cli --selftest
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

from .mesh import Mesh
from .retopology import HealConfig, heal


def _build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="genesis.cli",
        description="Pipeline Genesis — Modulo 2: Retopologia Genetica (cura de malha .obj).",
    )
    p.add_argument("input", nargs="?", help="malha .obj de entrada")
    p.add_argument("-o", "--output", help="caminho .obj de saida")
    p.add_argument("--weld-tol", type=float, default=1e-5, help="tolerancia de solda de vertices")
    p.add_argument("--smooth", type=int, default=0, metavar="N", help="iteracoes de suavizacao")
    p.add_argument("--lambda", dest="lam", type=float, default=0.5, help="fator lambda da suavizacao")
    p.add_argument("--mu", type=float, default=-0.53, help="fator mu (Taubin, <0)")
    p.add_argument("--no-taubin", action="store_true", help="usa Laplaciano uniforme puro")
    p.add_argument("--no-degenerate-removal", action="store_true", help="mantem faces degeneradas")
    p.add_argument("--report", action="store_true", help="apenas diagnostica, nao escreve")
    p.add_argument("--selftest", action="store_true", help="roda autoteste procedural")
    return p


def _config_from_args(args: argparse.Namespace) -> HealConfig:
    return HealConfig(
        weld_tolerance=args.weld_tol,
        remove_degenerate=not args.no_degenerate_removal,
        smooth_iterations=args.smooth,
        smooth_lambda=args.lam,
        smooth_mu=args.mu,
        use_taubin=not args.no_taubin,
    )


def _run_selftest() -> int:
    from .shapes import dirty_icosphere

    print(">> SELFTEST: gerando icosfera suja procedural (sem assets externos)\n")
    mesh = dirty_icosphere(subdivisions=3, noise=0.03)
    cfg = HealConfig(weld_tolerance=1e-4, smooth_iterations=6, use_taubin=True)
    result = heal(mesh, cfg)

    print("[ANTES]")
    print(result.before.summary())
    print("\n[PASSOS]")
    for s in result.steps:
        print(f"  - {s}")
    print("\n[DEPOIS]")
    print(result.after.summary())

    ok = (
        result.after.num_degenerate_faces == 0
        and result.after.num_vertices < result.before.num_vertices
        and result.after.is_manifold
        and result.after.is_watertight
        and result.after.num_components == 1
    )
    print("\n>> RESULTADO:", "PASS" if ok else "FALHA")
    return 0 if ok else 1


def main(argv: list[str] | None = None) -> int:
    args = _build_parser().parse_args(argv)

    if args.selftest:
        return _run_selftest()

    if not args.input:
        print("erro: informe uma malha .obj de entrada ou use --selftest", file=sys.stderr)
        return 2

    in_path = Path(args.input)
    if not in_path.exists():
        print(f"erro: arquivo nao encontrado: {in_path}", file=sys.stderr)
        return 2

    mesh = Mesh.load_obj(in_path)
    result = heal(mesh, _config_from_args(args))

    print(f"[ANTES]  {in_path}")
    print(result.before.summary())
    print("\n[PASSOS]")
    for s in result.steps:
        print(f"  - {s}")
    print("\n[DEPOIS]")
    print(result.after.summary())

    if args.report:
        return 0

    out_path = Path(args.output) if args.output else in_path.with_name(in_path.stem + "_healed.obj")
    result.mesh.save_obj(out_path, header=result.steps)
    print(f"\n>> gravado: {out_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
