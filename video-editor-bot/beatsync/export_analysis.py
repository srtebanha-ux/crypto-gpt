"""
export_analysis.py
==================

Exporta a análise de áudio do beatsync em JSON, para consumo pelo orquestrador
Node.js e pela composição Remotion (React/TypeScript).

Uso:
    python -m beatsync.export_analysis musica.mp3 \
        --out analysis.json --fps 30 --cut-mode hybrid --subdivision 1

Saída (JSON): tempo/BPM, duração, fps, e listas de eventos tanto em segundos
quanto já convertidas para número de frame (para o Remotion posicionar Sequences).
"""

from __future__ import annotations

import argparse
import json
import sys
from typing import List

import numpy as np

from .audio import analyze_audio


def _events(times: np.ndarray, strength: np.ndarray, fps: int) -> List[dict]:
    out = []
    for i, t in enumerate(times):
        s = float(strength[i]) if strength is not None and i < len(strength) else 1.0
        out.append({"time": round(float(t), 4), "frame": int(round(float(t) * fps)),
                    "strength": round(s, 4)})
    return out


def build_payload(audio_path: str, fps: int, cut_mode: str, subdivision: int,
                  min_gap: float, rms_samples: int) -> dict:
    a = analyze_audio(audio_path)
    cuts = a.cut_points(mode=cut_mode, subdivision=subdivision, min_gap=min_gap)

    # segmentos (start,end) — cada corte vira uma Sequence no Remotion
    segments = a.segments(cuts)
    seg_out = []
    for i, (t0, t1) in enumerate(segments):
        f0, f1 = int(round(t0 * fps)), int(round(t1 * fps))
        seg_out.append({
            "index": i,
            "start": round(t0, 4), "end": round(t1, 4),
            "startFrame": f0, "endFrame": f1,
            "durationInFrames": max(1, f1 - f0),
            "energy": round(float(np.interp(t0, a.rms_times, a.rms)) if a.rms.size else 0.5, 4),
        })

    # envelope RMS reamostrado (para efeitos reativos à energia no Remotion)
    if a.rms.size:
        xs = np.linspace(0, a.duration, rms_samples)
        rms = np.interp(xs, a.rms_times, a.rms)
        rms_env = [round(float(v), 4) for v in rms]
    else:
        rms_env = []

    # interpola força nos onsets
    onset_strength = a._interp_strength(a.onsets) if a.onsets.size else np.array([])

    return {
        "audioPath": audio_path,
        "fps": fps,
        "tempo": round(float(a.tempo), 3),
        "duration": round(float(a.duration), 4),
        "durationInFrames": int(round(a.duration * fps)),
        "cutMode": cut_mode,
        "subdivision": subdivision,
        "counts": {
            "beats": int(a.beats.size),
            "downbeats": int(a.downbeats.size),
            "onsets": int(a.onsets.size),
            "cuts": int(cuts.size),
            "segments": len(seg_out),
        },
        "beats": _events(a.beats, a.beat_strength, fps),
        "downbeats": _events(a.downbeats, None, fps),
        "onsets": _events(a.onsets, onset_strength, fps),
        "cuts": [round(float(t), 4) for t in cuts],
        "cutFrames": [int(round(float(t) * fps)) for t in cuts],
        "segments": seg_out,
        "rmsEnvelope": rms_env,
    }


def main(argv=None) -> int:
    p = argparse.ArgumentParser(
        prog="beatsync.export_analysis",
        description="Exporta a análise de áudio do beatsync em JSON (para Remotion/Node).",
    )
    p.add_argument("audio", help="arquivo de música")
    p.add_argument("--out", "-o", default="-", help="arquivo de saída (padrão: stdout)")
    p.add_argument("--fps", type=int, default=30)
    p.add_argument("--cut-mode", default="hybrid",
                   choices=["beat", "downbeat", "onset", "hybrid"])
    p.add_argument("--subdivision", type=int, default=1)
    p.add_argument("--min-gap", type=float, default=0.2)
    p.add_argument("--rms-samples", type=int, default=600)
    args = p.parse_args(argv)

    payload = build_payload(args.audio, args.fps, args.cut_mode,
                            args.subdivision, args.min_gap, args.rms_samples)
    text = json.dumps(payload, ensure_ascii=False, indent=2)
    if args.out == "-":
        sys.stdout.write(text + "\n")
    else:
        with open(args.out, "w", encoding="utf-8") as f:
            f.write(text)
        sys.stderr.write(f"análise exportada: {args.out} "
                         f"({payload['counts']['cuts']} cortes)\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
