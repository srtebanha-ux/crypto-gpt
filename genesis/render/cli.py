"""CLI autônoma do Módulo 5 (Motor Fantasma / Renderizador Headless).

Exemplos (rodar num Python com `bpy` instalado — MacBook Air/Apple Silicon)::

    python -m genesis.render.cli \
        --input exports/moonsilver_zane_purificado.obj \
        --out renders/ --format PNG --samples 128

    # Valida o pipeline sem o asset real (gera Suzanne como placeholder):
    python -m genesis.render.cli --input exports/zane.obj --out renders/ --placeholder

    # Sequência renderizada como MP4 vertical:
    python -m genesis.render.cli --input exports/zane.obj --out renders/ \
        --format MP4 --frame-start 1 --frame-end 48
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

from .headless_engine import (
    HeadlessRenderEngine,
    RenderConfig,
    RenderEngineError,
    configure_logging,
)

_RESOLUTIONS = {
    "vertical": (1080, 1920),  # Reels/TikTok
    "horizontal": (1920, 1080),  # YouTube/cinema
}


def _build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="genesis.render.cli",
        description="Pipeline Genesis — Modulo 5: Motor Fantasma (Cycles/Metal, headless).",
    )
    p.add_argument("--input", required=True, help="malha do sujeito (.obj/.fbx) em exports/")
    p.add_argument("--out", default="renders", help="pasta de saida (default: renders/)")
    p.add_argument("--format", choices=["PNG", "MP4"], default="PNG", help="formato de saida")
    p.add_argument("--samples", type=int, default=128, help="samples do Cycles (default: 128)")
    p.add_argument("--no-denoise", action="store_true", help="desativa o denoise")
    p.add_argument(
        "--orientation", choices=list(_RESOLUTIONS), default="vertical",
        help="vertical=1080x1920 (default), horizontal=1920x1080",
    )
    p.add_argument("--frame-start", type=int, default=1, help="frame inicial")
    p.add_argument("--frame-end", type=int, default=1, help="frame final (>start habilita sequencia)")
    p.add_argument("--fps", type=int, default=24, help="frames por segundo (MP4)")
    p.add_argument("--fov", type=float, default=32.0, help="FOV vertical da camera (graus)")
    p.add_argument(
        "--frame-fraction", type=float, default=0.45,
        help="fracao da altura do sujeito no enquadramento (busto ~0.45)",
    )
    p.add_argument("--transparent", action="store_true", help="fundo transparente (film transparent)")
    p.add_argument(
        "--placeholder", action="store_true",
        help="se o asset nao existir, gera Suzanne para validar o pipeline",
    )
    p.add_argument("--quiet", action="store_true", help="reduz o logging de telemetria")
    return p


def _config_from_args(args: argparse.Namespace) -> RenderConfig:
    return RenderConfig(
        input_mesh=Path(args.input),
        output_dir=Path(args.out),
        resolution=_RESOLUTIONS[args.orientation],
        samples=args.samples,
        use_denoise=not args.no_denoise,
        output_format=args.format,
        frame_start=args.frame_start,
        frame_end=args.frame_end,
        fps=args.fps,
        film_transparent=args.transparent,
        camera_vertical_fov_deg=args.fov,
        frame_height_fraction=args.frame_fraction,
        allow_placeholder=args.placeholder,
    )


def main(argv: list[str] | None = None) -> int:
    args = _build_parser().parse_args(argv)
    configure_logging(verbose=not args.quiet)
    try:
        config = _config_from_args(args)
        engine = HeadlessRenderEngine(config)
        engine.run()
    except RenderEngineError as exc:
        print(f"[NEXUS-RENDER] ERRO: {exc}", file=sys.stderr)
        return 1
    except ValueError as exc:  # configuração inválida (RenderConfig.__post_init__)
        print(f"[NEXUS-RENDER] CONFIG INVÁLIDA: {exc}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
