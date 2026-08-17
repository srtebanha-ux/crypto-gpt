"""CLI do cenário procedural (palco). Reaproveita o motor de render do Módulo 5.

Roda num Python com ``bpy`` (MacBook/Apple Silicon). Exemplos::

    # Palco vazio (beauty shot da iluminação), PNG horizontal
    python -m genesis.stage.cli --out renders/ --orientation horizontal

    # Palco COM o personagem no centro + névoa volumétrica (god-rays)
    python -m genesis.stage.cli --subject exports/zane.obj --out renders/ --volumetric

    # Sem asset real: coloca um placeholder (Suzanne) no palco
    python -m genesis.stage.cli --subject exports/zane.obj --placeholder
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

from ..render.headless_engine import (
    HeadlessRenderEngine,
    RenderConfig,
    RenderEngineError,
    configure_logging,
)
from .stage import StageBuilder, StageConfig

_RESOLUTIONS = {"vertical": (1080, 1920), "horizontal": (1920, 1080)}


def _build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="genesis.stage.cli",
        description="Pipeline Genesis — Cenario procedural (palco) + render Cycles/Metal.",
    )
    p.add_argument("--subject", help="malha do personagem (.obj/.fbx) a colocar no palco")
    p.add_argument("--out", default="renders", help="pasta de saida")
    p.add_argument("--orientation", choices=list(_RESOLUTIONS), default="horizontal")
    p.add_argument("--format", choices=["PNG", "MP4"], default="PNG")
    p.add_argument("--samples", type=int, default=128)
    p.add_argument("--exposure", type=float, default=0.0, help="exposicao em stops (EV)")
    p.add_argument("--volumetric", action="store_true", help="ativa nevoa volumetrica (god-rays)")
    p.add_argument("--spots", type=int, default=5, help="numero de spots na trelica")
    p.add_argument("--placeholder", action="store_true", help="usa Suzanne se o asset faltar")
    p.add_argument("--quiet", action="store_true")
    return p


def main(argv: list[str] | None = None) -> int:
    args = _build_parser().parse_args(argv)
    configure_logging(verbose=not args.quiet)

    subject = Path(args.subject) if args.subject else None
    render_cfg = RenderConfig(
        input_mesh=subject if subject else Path("__none__"),
        output_dir=Path(args.out),
        resolution=_RESOLUTIONS[args.orientation],
        samples=args.samples,
        output_format=args.format,
        exposure=args.exposure,
        subject_name="MoonSilver_Stage",
        allow_placeholder=args.placeholder,
    )
    stage_cfg = StageConfig(
        subject_mesh=subject,
        output_dir=Path(args.out),
        truss_count=args.spots,
        volumetric=args.volumetric,
    )

    try:
        engine = HeadlessRenderEngine(render_cfg)
        engine.configure_device()
        engine.reset_scene()
        if subject is not None:
            engine.import_subject()  # coloca o personagem na origem
        camera = StageBuilder(stage_cfg).build()  # monta palco + luzes + camera
        engine._camera = camera  # a camera do palco assume o render
        engine.configure_render_settings()
        output = engine.render()
        print(f"[NEXUS-STAGE] Palco renderizado: {output}")
    except RenderEngineError as exc:
        print(f"[NEXUS-STAGE] ERRO: {exc}", file=sys.stderr)
        return 1
    except ValueError as exc:
        print(f"[NEXUS-STAGE] CONFIG INVÁLIDA: {exc}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
