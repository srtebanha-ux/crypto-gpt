"""
render_ffmpeg.py
================

Renderizador LEVE, baseado em FFmpeg direto — projetado para não travar
máquinas modestas (ex.: MacBook Air).

Diferença crucial para o caminho MoviePy: em vez de abrir TODOS os cortes na
memória e recompor tudo em RAM, aqui cada corte é processado por um processo
FFmpeg independente, **um de cada vez** (uso de memória constante e baixo), com
prioridade reduzida (nice). No fim, os cortes — todos com os mesmos parâmetros
de codec — são unidos pelo demuxer `concat` SEM recompressão, e o áudio
original é multiplexado.

Custo: os efeitos sofisticados (zoom-punch/crossfade do MoviePy) não se aplicam
aqui; o foco é o corte seco sincronizado à batida, que é o essencial — e o que
roda liso em qualquer notebook.
"""

from __future__ import annotations

import os
import shutil
import tempfile
from dataclasses import dataclass
from typing import Callable, List, Optional, Sequence

from .ffmpeg_util import run_ffmpeg


@dataclass
class Cut:
    """Um corte a renderizar: trecho [src_in, src_in+duration) de um clipe."""
    src_path: str
    src_in: float
    duration: float
    avail: Optional[float] = None  # duração disponível na fonte (para padding)

    def available(self) -> float:
        return self.avail if self.avail is not None else self.duration


def _segment_filter(width: int, height: int, fps: int, pad: float) -> str:
    """
    Filtro de vídeo: escala preservando proporção, corta no centro para
    preencher WxH, força fps constante e SAR 1. Se o trecho da fonte for mais
    curto que o slot, `tpad` segura o último frame para completar a duração
    (mantém o corte alinhado à batida, sem drift).
    """
    f = (
        f"scale={width}:{height}:force_original_aspect_ratio=increase,"
        f"crop={width}:{height},fps={fps},setsar=1,format=yuv420p"
    )
    if pad > 0.02:
        f += f",tpad=stop_mode=clone:stop_duration={pad:.3f}"
    return f


def _encode_segment(cut: Cut, out_path: str, width: int, height: int,
                    fps: int, threads: int, crf: int) -> None:
    avail = max(0.05, cut.available())
    dur = max(0.05, cut.duration)
    pad = max(0.0, dur - avail)
    vf = _segment_filter(width, height, fps, pad)
    args = [
        "-y",
        "-ss", f"{cut.src_in:.3f}",      # seek de entrada (rápido e leve)
        "-i", cut.src_path,
        "-t", f"{dur:.3f}",              # duração exata do slot (corte no ritmo)
        "-an",                            # sem áudio nos segmentos
        "-vf", vf,
        "-r", str(fps),
        "-c:v", "libx264",
        "-preset", "ultrafast",
        "-crf", str(crf),
        "-pix_fmt", "yuv420p",
        "-threads", str(max(1, threads)),
        out_path,
    ]
    proc = run_ffmpeg(args)
    if proc.returncode != 0 or not os.path.exists(out_path) or os.path.getsize(out_path) == 0:
        tail = (proc.stderr or b"").decode("utf-8", "replace").strip().splitlines()
        raise RuntimeError(
            f"falha ao renderizar segmento de {os.path.basename(cut.src_path)}: "
            + (tail[-1] if tail else "erro desconhecido")
        )


def render(
    cuts: Sequence[Cut],
    audio_path: str,
    out_path: str,
    width: int = 1280,
    height: int = 720,
    fps: int = 30,
    threads: int = 2,
    crf: int = 23,
    audio_bitrate: str = "192k",
    on_progress: Optional[Callable[[float], None]] = None,
    log: Optional[Callable[[str], None]] = None,
) -> str:
    """
    Renderiza a lista de cortes para `out_path`, sobrepondo o áudio original.
    Progresso reportado em 0..100 via `on_progress`.
    """
    log = log or (lambda m: None)
    if not cuts:
        raise RuntimeError("nenhum corte para renderizar.")

    workdir = tempfile.mkdtemp(prefix="beatsync_seg_")
    seg_paths: List[str] = []
    try:
        n = len(cuts)
        for i, cut in enumerate(cuts):
            seg = os.path.join(workdir, f"seg_{i:05d}.mp4")
            _encode_segment(cut, seg, width, height, fps, threads, crf)
            seg_paths.append(seg)
            if on_progress:
                on_progress(90.0 * (i + 1) / n)  # 0..90% na fase de segmentos
            if (i + 1) % 10 == 0 or i + 1 == n:
                log(f"segmentos: {i + 1}/{n}")

        # lista para o demuxer concat
        list_file = os.path.join(workdir, "concat.txt")
        with open(list_file, "w", encoding="utf-8") as f:
            for p in seg_paths:
                f.write(f"file '{p}'\n")

        os.makedirs(os.path.dirname(os.path.abspath(out_path)) or ".", exist_ok=True)
        log("juntando segmentos + áudio…")
        args = [
            "-y",
            "-f", "concat", "-safe", "0", "-i", list_file,
            "-i", audio_path,
            "-map", "0:v:0", "-map", "1:a:0",
            "-c:v", "copy",                 # segmentos já uniformes: sem recompressão
            "-c:a", "aac", "-b:a", audio_bitrate,
            "-shortest",
            "-movflags", "+faststart",
            out_path,
        ]
        proc = run_ffmpeg(args)
        if proc.returncode != 0 or not os.path.exists(out_path):
            tail = (proc.stderr or b"").decode("utf-8", "replace").strip().splitlines()
            raise RuntimeError("falha ao juntar segmentos: "
                               + (tail[-1] if tail else "erro desconhecido"))
        if on_progress:
            on_progress(100.0)
        return out_path
    finally:
        shutil.rmtree(workdir, ignore_errors=True)


def cuts_from_timeline(timeline) -> List[Cut]:
    """
    Converte a timeline do editor (lista de TimelineEntry) em cortes leves.
    Guarda a duração disponível na fonte (_avail) para o cálculo de padding.
    """
    out: List[Cut] = []
    for e in timeline:
        out.append(Cut(
            src_path=e.src_path,
            src_in=float(e.src_in),
            duration=float(e.t_end - e.t_start),
            avail=max(0.05, float(e.src_out - e.src_in)),
        ))
    return out
