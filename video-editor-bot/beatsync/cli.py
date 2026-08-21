"""
cli.py
======

Interface de linha de comando do beatsync.

Exemplos:

    # render direto com preset de rede social vertical
    beatsync -a musica.mp3 -c ./clipes -o clipe_final.mp4 --preset reels

    # videoclipe cinematográfico, cortes só nos compassos, com crossfade
    beatsync -a musica.mp3 -c ./clipes -o out.mp4 --preset cinematic

    # controle fino (sobrescreve o preset)
    beatsync -a musica.mp3 -c ./clipes -o out.mp4 \\
        --cut-mode hybrid --subdivision 2 --min-cut 0.25 --lyrics

    # apenas inspecionar as batidas/cortes, sem renderizar
    beatsync -a musica.mp3 -c ./clipes --dry-run
"""

from __future__ import annotations

import argparse
import sys
from typing import Optional

from .config import PRESETS, RenderConfig, get_preset

if False:  # apenas para type hints; import real é lazy em main()
    from .editor import VideoEditor


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="beatsync",
        description="Bot de edição de vídeo sincronizada com a batida da música.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    p.add_argument("-a", "--audio", required=True, help="arquivo de música (mp3/wav/...)")
    p.add_argument("-c", "--clips", required=True, help="diretório com os clipes brutos")
    p.add_argument("-o", "--output", default="beatsync_output.mp4", help="MP4 de saída")

    p.add_argument("--preset", choices=sorted(PRESETS), default=None,
                   help="preset de estética (reels/cinematic/hype/clean)")

    # overrides finos
    p.add_argument("--width", type=int)
    p.add_argument("--height", type=int)
    p.add_argument("--fps", type=int)
    p.add_argument("--cut-mode", choices=["beat", "downbeat", "onset", "hybrid"])
    p.add_argument("--subdivision", type=int)
    p.add_argument("--min-cut", type=float)
    p.add_argument("--crossfade", type=float)
    p.add_argument("--fade", type=float)
    p.add_argument("--zoom-punch", dest="zoom_punch", action="store_true")
    p.add_argument("--no-zoom-punch", dest="zoom_punch", action="store_false")
    p.add_argument("--speed-ramp", dest="beat_speed_ramp", action="store_true",
                   help="acelera levemente nos picos de energia")
    p.set_defaults(zoom_punch=None, beat_speed_ramp=None)

    p.add_argument("--lyrics", action="store_true",
                   help="usa Whisper para reforçar cortes na cadência da letra")
    p.add_argument("--whisper-model", default=None,
                   help="tamanho do modelo Whisper (tiny/base/small/medium/large)")

    p.add_argument("--seed", type=int, help="semente para escolha reprodutível de clipes")
    p.add_argument("--bitrate", help="ex: 8M")
    p.add_argument("--preset-x264", dest="x264_preset",
                   help="preset do x264 (ultrafast..veryslow)")
    p.add_argument("--threads", type=int)

    p.add_argument("--dry-run", action="store_true",
                   help="analisa e imprime o plano de cortes sem renderizar")
    p.add_argument("-q", "--quiet", action="store_true", help="silencia logs")
    return p


def _apply_overrides(cfg: RenderConfig, args: argparse.Namespace) -> RenderConfig:
    mapping = {
        "width": "width", "height": "height", "fps": "fps",
        "cut_mode": "cut_mode", "subdivision": "subdivision", "min_cut": "min_cut",
        "crossfade": "crossfade", "fade": "fade", "seed": "seed",
        "bitrate": "bitrate", "threads": "threads",
    }
    for arg_name, cfg_name in mapping.items():
        val = getattr(args, arg_name, None)
        if val is not None:
            setattr(cfg, cfg_name, val)
    if args.zoom_punch is not None:
        cfg.zoom_punch = args.zoom_punch
    if args.beat_speed_ramp is not None:
        cfg.beat_speed_ramp = args.beat_speed_ramp
    if args.lyrics:
        cfg.use_lyrics = True
    if args.whisper_model:
        cfg.whisper_model = args.whisper_model
    if args.x264_preset:
        cfg.preset = args.x264_preset
    return cfg


def _print_plan(editor: VideoEditor) -> None:
    a = editor.analysis
    print("\n=== PLANO DE EDIÇÃO (dry-run) ===")
    print(f"BPM≈{a.tempo:.1f}  duração={a.duration:.1f}s  batidas={len(a.beats)}")
    pts = editor.resolve_cut_points()
    print(f"cortes: {len(pts)}  (modo={editor.cfg.cut_mode}, "
          f"subdiv={editor.cfg.subdivision})")
    editor.build_timeline()
    print(f"clipes brutos: {len(editor.sources)}  "
          f"segmentos na timeline: {len(editor.timeline)}")
    print("\n  #   t_ini    dur    veloc  clipe")
    for i, e in enumerate(editor.timeline[:40]):
        import os
        print(f" {i:3d}  {e.t_start:6.2f}  {e.duration:5.2f}  "
              f"{e.speed:4.2f}x  {os.path.basename(e.src_path)} "
              f"[{e.src_in:.2f}-{e.src_out:.2f}]")
    if len(editor.timeline) > 40:
        print(f"  ... (+{len(editor.timeline) - 40} cortes)")
    print("\n(nenhum arquivo foi renderizado — remova --dry-run para gerar o vídeo)")


def main(argv: Optional[list] = None) -> int:
    args = build_parser().parse_args(argv)

    cfg = get_preset(args.preset) if args.preset else RenderConfig()
    cfg = _apply_overrides(cfg, args)

    log = (lambda m: None) if args.quiet else print

    try:
        from .editor import VideoEditor  # import lazy (puxa MoviePy/FFmpeg)
    except ImportError as exc:
        print(f"erro: {exc}", file=sys.stderr)
        return 1

    editor = VideoEditor(args.audio, args.clips, cfg, log=log)

    try:
        editor.analyze()
        if args.dry_run:
            _print_plan(editor)
            return 0
        editor.render(args.output)
    except (FileNotFoundError, RuntimeError, ValueError) as exc:
        print(f"erro: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
