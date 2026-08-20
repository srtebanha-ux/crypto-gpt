"""
editor.py
=========

O motor de corte: junta a análise de áudio, (opcional) a análise de letra e o
pool de clipes para produzir a timeline final e renderizá-la.

Fluxo:
  1. analyze_audio(música)                -> batidas, downbeats, onsets, RMS
  2. (opcional) transcribe(música)        -> timestamps de palavras/frases
  3. resolve_cut_points()                 -> lista final de instantes de corte
  4. build_timeline()                     -> [(path, in, out)] por segmento
  5. render()                             -> escreve o MP4 final
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Callable, List, Optional, Tuple

import numpy as np

from . import video as vid
from .audio import AudioAnalysis, analyze_audio
from .config import RenderConfig


@dataclass
class TimelineEntry:
    src_path: str
    src_in: float
    src_out: float
    t_start: float   # posição na música
    t_end: float
    zoom_punch: bool
    speed: float

    @property
    def duration(self) -> float:
        return self.t_end - self.t_start


class VideoEditor:
    def __init__(
        self,
        audio_path: str,
        clips_dir: str,
        config: Optional[RenderConfig] = None,
        log: Optional[Callable[[str], None]] = None,
    ):
        self.audio_path = audio_path
        self.clips_dir = clips_dir
        self.cfg = config or RenderConfig()
        self.log = log or (lambda m: None)

        self.analysis: Optional[AudioAnalysis] = None
        self.lyrics = None
        self.cut_points: Optional[np.ndarray] = None
        self.timeline: List[TimelineEntry] = []
        self.sources: List[vid.SourceClip] = []

    # ------------------------------------------------------------------ #
    def analyze(self) -> "VideoEditor":
        self.log(f"Analisando áudio: {self.audio_path}")
        self.analysis = analyze_audio(self.audio_path)
        a = self.analysis
        self.log(
            f"  BPM≈{a.tempo:.1f} | {len(a.beats)} batidas | "
            f"{len(a.downbeats)} downbeats | {len(a.onsets)} onsets | "
            f"dur={a.duration:.1f}s"
        )
        if self.cfg.use_lyrics:
            self._analyze_lyrics()
        return self

    def _analyze_lyrics(self):
        from .lyrics import transcribe
        self.log("Transcrevendo letra com Whisper...")
        self.lyrics = transcribe(self.audio_path, self.cfg.whisper_model)
        if self.lyrics is None:
            self.log("  Whisper indisponível — seguindo sem análise de letra.")
        else:
            self.log(
                f"  letra: {len(self.lyrics.words)} palavras, "
                f"{len(self.lyrics.segments)} frases "
                f"(idioma={self.lyrics.language})"
            )

    # ------------------------------------------------------------------ #
    def resolve_cut_points(self) -> np.ndarray:
        assert self.analysis is not None, "chame analyze() primeiro"
        pts = self.analysis.cut_points(
            mode=self.cfg.cut_mode,
            subdivision=self.cfg.subdivision,
            min_gap=max(self.cfg.min_gap, self.cfg.min_cut * 0.6),
        )

        # reforça cortes na cadência da letra
        if self.lyrics is not None and self.cfg.lyric_weight > 0:
            pts = self._snap_to_lyrics(pts)

        # garante duração mínima por corte
        pts = self._enforce_min_cut(pts)
        self.cut_points = pts
        self.log(f"Pontos de corte definidos: {len(pts)}")
        return pts

    def _snap_to_lyrics(self, pts: np.ndarray) -> np.ndarray:
        """Empurra cortes próximos ao início de palavras para caírem na letra."""
        word_starts = self.lyrics.onset_times()
        if word_starts.size == 0:
            return pts
        w = float(self.cfg.lyric_weight)
        tol = 0.18  # janela de atração (s)
        snapped = []
        for t in pts:
            j = int(np.argmin(np.abs(word_starts - t)))
            nearest = word_starts[j]
            if abs(nearest - t) <= tol:
                snapped.append(t + (nearest - t) * w)
            else:
                snapped.append(t)
        # injeta inícios de frase como cortes garantidos
        phrases = self.lyrics.phrase_boundaries()
        merged = np.union1d(np.array(snapped), phrases)
        return np.sort(np.unique(merged))

    def _enforce_min_cut(self, pts: np.ndarray) -> np.ndarray:
        if pts.size == 0:
            return pts
        kept = [pts[0]]
        for t in pts[1:]:
            if t - kept[-1] >= self.cfg.min_cut:
                kept.append(t)
        return np.array(kept)

    # ------------------------------------------------------------------ #
    def build_timeline(self) -> List[TimelineEntry]:
        assert self.analysis is not None
        if self.cut_points is None:
            self.resolve_cut_points()

        self.log(f"Sondando clipes em: {self.clips_dir}")
        paths = vid.discover_clips(self.clips_dir)
        self.sources = vid.probe_all(paths)
        if not self.sources:
            raise RuntimeError(
                f"Nenhum vídeo utilizável em {self.clips_dir!r} "
                f"(formatos: {', '.join(vid.VIDEO_EXTS)})"
            )
        self.log(f"  {len(self.sources)} clipes brutos válidos.")

        pool = vid.ClipPool(self.sources, seed=self.cfg.seed,
                            shuffle=self.cfg.shuffle)
        segments = self.analysis.segments(self.cut_points)

        timeline: List[TimelineEntry] = []
        for (t0, t1) in segments:
            need = t1 - t0
            if need < self.cfg.min_cut * 0.5:
                continue
            path, s_in, s_out = pool.take(need, min_take=self.cfg.min_cut * 0.5)

            speed = 1.0
            if self.cfg.beat_speed_ramp:
                speed = self._energy_speed(t0)

            # se o trecho do clipe é mais curto que o slot, ajusta a velocidade
            src_dur = s_out - s_in
            if src_dur < need * 0.95 and src_dur > 0.05:
                speed *= max(0.5, src_dur / need)

            timeline.append(TimelineEntry(
                src_path=path, src_in=s_in, src_out=s_out,
                t_start=t0, t_end=t1,
                zoom_punch=self.cfg.zoom_punch and need < 1.2,
                speed=speed,
            ))

        self.timeline = timeline
        self.log(f"Timeline: {len(timeline)} cortes.")
        return timeline

    def _energy_speed(self, t: float) -> float:
        """Mais energia (RMS) => corte levemente acelerado (0.95x..1.25x)."""
        a = self.analysis
        e = float(np.interp(t, a.rms_times, a.rms)) if a.rms.size else 0.5
        return 0.95 + 0.30 * e

    # ------------------------------------------------------------------ #
    def render(self, output_path: str) -> str:
        if not self.timeline:
            self.build_timeline()
        self.log("Construindo subclipes...")

        subclips = []
        for i, e in enumerate(self.timeline):
            clip = vid.build_subclip(
                e.src_path, e.src_in, e.src_out,
                target_size=self.cfg.size,
                fps=self.cfg.fps,
                fade=self.cfg.fade,
                speed=e.speed,
                zoom_punch=e.zoom_punch,
            )
            # força a duração exata do slot para manter a sincronia rígida
            slot = e.duration
            if clip.duration > slot:
                clip = clip.subclipped(0, slot)
            subclips.append(clip)

        self.log(f"Renderizando {len(subclips)} cortes -> {output_path}")
        out = vid.assemble_and_render(
            subclips,
            audio_path=self.audio_path,
            output_path=output_path,
            fps=self.cfg.fps,
            crossfade=self.cfg.crossfade,
            codec=self.cfg.codec,
            audio_codec=self.cfg.audio_codec,
            bitrate=self.cfg.bitrate,
            threads=self.cfg.threads,
            preset=self.cfg.preset,
        )
        self.log(f"✓ Concluído: {out}")
        return out

    # ------------------------------------------------------------------ #
    def run(self, output_path: str) -> str:
        """Pipeline completo: análise -> cortes -> timeline -> render."""
        self.analyze()
        self.resolve_cut_points()
        self.build_timeline()
        return self.render(output_path)


def make_video(
    audio_path: str,
    clips_dir: str,
    output_path: str,
    config: Optional[RenderConfig] = None,
    log: Optional[Callable[[str], None]] = None,
) -> str:
    """Atalho de alto nível para uso programático."""
    return VideoEditor(audio_path, clips_dir, config, log).run(output_path)
