"""CLI da Fábrica de Atores — ingere um modelo 3D bruto e o deixa pronto.

Fluxo: carrega (.obj nativo; .glb/.ply/.fbx via trimesh) → normaliza (Z-up,
escala, chão) → cura (Módulo 2) → exporta .obj para o pipeline.

Exemplos::

    # Modelo baixado do Tripo/Meshy (glTF) → ator pronto, 1.8 m de altura
    python -m genesis.actor_factory.cli --input downloads/zane.glb \
        --out exports/zane.obj --height 1.8

    # Se já for .obj Z-up, pule a conversão de eixo
    python -m genesis.actor_factory.cli --input raw/zane.obj \
        --out exports/zane.obj --up z
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

from .ingest import ingest_actor


def _build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="genesis.actor_factory.cli",
        description="Fabrica de Atores — normaliza e cura um modelo 3D bruto (imagem->3D).",
    )
    p.add_argument("--input", required=True, help="modelo bruto (.obj/.glb/.gltf/.ply/.fbx)")
    p.add_argument("--out", required=True, help="caminho .obj de saida (ator pronto)")
    p.add_argument(
        "--up", default="y", choices=["y", "z", "-z"],
        help="eixo 'para cima' do modelo de origem (glTF costuma ser 'y'; default 'y')",
    )
    p.add_argument("--height", type=float, default=1.8, help="altura-alvo em metros (default 1.8)")
    p.add_argument("--no-heal", action="store_true", help="pula a cura do Modulo 2")
    return p


def main(argv: list[str] | None = None) -> int:
    args = _build_parser().parse_args(argv)
    if not Path(args.input).exists():
        print(f"erro: arquivo não encontrado: {args.input}", file=sys.stderr)
        return 2
    try:
        result = ingest_actor(
            input_path=args.input,
            output_path=args.out,
            from_up=args.up,
            target_height=args.height,
            do_heal=not args.no_heal,
        )
    except (RuntimeError, ValueError) as exc:
        print(f"[FABRICA-ATOR] ERRO: {exc}", file=sys.stderr)
        return 1

    print(f"[FABRICA-ATOR] ingerido: {args.input}")
    print("[ANTES]")
    print(result.before.summary())
    print("\n[DEPOIS] (normalizado + curado)")
    print(result.after.summary())
    print(f"\n>> ator pronto: {result.output_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
