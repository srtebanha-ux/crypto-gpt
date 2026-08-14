"""CLI do Motor de Luz Puro (Mitsuba 3). Path-tracing sem Blender.

Exemplos::

    python -m genesis.pathtracer.cli \
        --input exports/zane_com_guitarra.obj \
        --out renders/zane.png --samples 128

    python -m genesis.pathtracer.cli --input exports/zane.obj \
        --out renders/zane.png --orientation horizontal --exposure -1.0
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

from .engine import (
    MitsubaRenderError,
    MitsubaRenderer,
    RenderConfig,
    configure_logging,
)

_RESOLUTIONS = {"vertical": (1080, 1920), "horizontal": (1920, 1080)}


def _build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="genesis.pathtracer.cli",
        description="Pipeline Genesis — Etapa 4: render Mitsuba 3 (path-tracing puro).",
    )
    p.add_argument("--input", required=True, help="malha .obj de entrada")
    p.add_argument("--out", default="renders/mitsuba_out.png", help="PNG de saida")
    p.add_argument("--orientation", choices=list(_RESOLUTIONS), default="vertical")
    p.add_argument("--samples", type=int, default=128, help="amostras por pixel (spp)")
    p.add_argument("--max-depth", type=int, default=8, help="profundidade do path-tracing")
    p.add_argument("--fov", type=float, default=32.0, help="FOV vertical (graus)")
    p.add_argument("--exposure", type=float, default=0.0, help="exposicao em stops (EV)")
    p.add_argument("--frame-fraction", type=float, default=0.9, help="fracao da altura enquadrada")
    p.add_argument("--no-floor", action="store_true", help="nao adiciona o piso")
    p.add_argument("--quiet", action="store_true")
    return p


def main(argv: list[str] | None = None) -> int:
    args = _build_parser().parse_args(argv)
    configure_logging(verbose=not args.quiet)

    if not Path(args.input).exists():
        print(f"erro: arquivo não encontrado: {args.input}", file=sys.stderr)
        return 2

    try:
        config = RenderConfig(
            input_mesh=Path(args.input),
            output_path=Path(args.out),
            resolution=_RESOLUTIONS[args.orientation],
            samples=args.samples,
            max_depth=args.max_depth,
            fov_deg=args.fov,
            exposure=args.exposure,
            frame_height_fraction=args.frame_fraction,
            add_floor=not args.no_floor,
        )
        out = MitsubaRenderer(config).render()
        print(f"[NEXUS-MITSUBA] render concluído: {out}")
    except MitsubaRenderError as exc:
        print(f"[NEXUS-MITSUBA] ERRO: {exc}", file=sys.stderr)
        return 1
    except ValueError as exc:
        print(f"[NEXUS-MITSUBA] CONFIG INVÁLIDA: {exc}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
