"""
audio.py
========

Análise de áudio para sincronização de cortes de vídeo.

Extrai do arquivo de música:
  * BPM (tempo global e curva de tempo dinâmica)
  * Timestamps das batidas (beat tracking)
  * Downbeats / início de compassos (quando possível)
  * Picos de energia / onsets (transientes fortes — bumbos, viradas)
  * Envelope de energia RMS (para escolher trechos "intensos" do clipe)

Backbone: librosa. Tudo aqui é puro processamento de sinal, sem dependência
de vídeo, para poder ser testado isoladamente.
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from typing import List, Optional

import numpy as np

try:
    import librosa
except ImportError as exc:  # pragma: no cover - dependência externa
    raise ImportError(
        "librosa é necessário para a análise de áudio. "
        "Instale com: pip install librosa soundfile"
    ) from exc


@dataclass
class AudioAnalysis:
    """Resultado completo da análise de áudio."""

    path: str
    sr: int
    duration: float
    tempo: float                      # BPM global estimado
    beats: np.ndarray                 # timestamps (s) de todas as batidas
    downbeats: np.ndarray             # timestamps (s) de inícios de compasso
    onsets: np.ndarray                # timestamps (s) de transientes fortes
    beat_strength: np.ndarray         # força relativa de cada beat (0..1)
    rms_times: np.ndarray             # eixo de tempo do envelope RMS
    rms: np.ndarray                   # envelope de energia RMS normalizado
    _y: np.ndarray = field(repr=False, default=None)

    # ------------------------------------------------------------------ #
    # Consultas úteis para o motor de corte
    # ------------------------------------------------------------------ #
    def cut_points(
        self,
        mode: str = "beat",
        subdivision: int = 1,
        min_gap: float = 0.20,
    ) -> np.ndarray:
        """
        Retorna os pontos de corte (em segundos) segundo a estratégia escolhida.

        mode:
            "beat"     -> corta em cada batida
            "downbeat" -> corta apenas no início dos compassos (cortes mais longos)
            "onset"    -> corta nos transientes de energia (mais agressivo)
            "hybrid"   -> downbeats + onsets fortes intercalados
        subdivision:
            multiplica a densidade de cortes. 2 = corta em meias-batidas,
            4 = semicolcheias. Só se aplica a "beat"/"downbeat".
        min_gap:
            distância mínima (s) entre dois cortes consecutivos.
        """
        if mode == "beat":
            pts = self._subdivide(self.beats, subdivision)
        elif mode == "downbeat":
            base = self.downbeats if self.downbeats.size else self.beats
            pts = self._subdivide(base, subdivision)
        elif mode == "onset":
            pts = self.onsets
        elif mode == "hybrid":
            base = self.downbeats if self.downbeats.size else self.beats
            strong = self.onsets[self._interp_strength(self.onsets) > 0.55]
            pts = np.union1d(base, strong)
        else:
            raise ValueError(f"modo de corte desconhecido: {mode!r}")

        pts = np.sort(np.unique(pts))
        return self._enforce_min_gap(pts, min_gap)

    def segments(self, cut_points: Optional[np.ndarray] = None) -> List[tuple]:
        """
        Converte pontos de corte em segmentos (start, end) que cobrem a música.
        Sempre inclui 0.0 no início e a duração total no fim.
        """
        if cut_points is None:
            cut_points = self.cut_points()
        edges = np.concatenate(([0.0], cut_points, [self.duration]))
        edges = np.sort(np.unique(np.clip(edges, 0.0, self.duration)))
        return [(float(a), float(b)) for a, b in zip(edges[:-1], edges[1:]) if b - a > 1e-3]

    # ------------------------------------------------------------------ #
    # Internos
    # ------------------------------------------------------------------ #
    @staticmethod
    def _subdivide(times: np.ndarray, factor: int) -> np.ndarray:
        if factor <= 1 or times.size < 2:
            return times
        out = [times]
        for i in range(1, factor):
            frac = i / factor
            mids = times[:-1] + (times[1:] - times[:-1]) * frac
            out.append(mids)
        return np.sort(np.concatenate(out))

    @staticmethod
    def _enforce_min_gap(pts: np.ndarray, min_gap: float) -> np.ndarray:
        if pts.size == 0:
            return pts
        kept = [pts[0]]
        for t in pts[1:]:
            if t - kept[-1] >= min_gap:
                kept.append(t)
        return np.array(kept)

    def _interp_strength(self, times: np.ndarray) -> np.ndarray:
        """Interpola a força de beat/energia nos tempos dados (0..1)."""
        if self.beats.size == 0:
            return np.ones_like(times)
        return np.interp(times, self.beats, self.beat_strength,
                         left=self.beat_strength[0], right=self.beat_strength[-1])


def analyze_audio(
    path: str,
    sr: int = 22050,
    hop_length: int = 512,
    onset_percentile: float = 82.0,
) -> AudioAnalysis:
    """
    Executa a análise completa de um arquivo de áudio.

    Parameters
    ----------
    path : caminho do arquivo (mp3/wav/flac/m4a...).
    sr : taxa de amostragem de trabalho.
    hop_length : granularidade temporal da análise.
    onset_percentile : só onsets acima deste percentil de força viram picos.
    """
    y, sr = _robust_load(path, sr=sr)
    duration = float(librosa.get_duration(y=y, sr=sr))

    # --- Tempo + beat tracking ------------------------------------------------
    tempo, beat_frames = librosa.beat.beat_track(
        y=y, sr=sr, hop_length=hop_length, units="frames"
    )
    tempo = float(np.atleast_1d(tempo)[0])
    beats = librosa.frames_to_time(beat_frames, sr=sr, hop_length=hop_length)

    # --- Força de cada batida via onset envelope ------------------------------
    onset_env = librosa.onset.onset_strength(y=y, sr=sr, hop_length=hop_length)
    if beat_frames.size:
        raw_strength = onset_env[np.clip(beat_frames, 0, len(onset_env) - 1)]
        beat_strength = _normalize(raw_strength)
    else:
        beat_strength = np.array([])

    # --- Onsets fortes (picos de energia) -------------------------------------
    onset_frames = librosa.onset.onset_detect(
        onset_envelope=onset_env, sr=sr, hop_length=hop_length, backtrack=True
    )
    onset_times = librosa.frames_to_time(onset_frames, sr=sr, hop_length=hop_length)
    if onset_frames.size:
        onset_vals = onset_env[np.clip(onset_frames, 0, len(onset_env) - 1)]
        thresh = np.percentile(onset_vals, onset_percentile) if onset_vals.size else 0
        onset_times = onset_times[onset_vals >= thresh]

    # --- Downbeats (inícios de compasso) --------------------------------------
    downbeats = _estimate_downbeats(beats, beat_strength)

    # --- Envelope RMS (energia ao longo do tempo) -----------------------------
    rms = librosa.feature.rms(y=y, hop_length=hop_length)[0]
    rms_times = librosa.frames_to_time(np.arange(len(rms)), sr=sr, hop_length=hop_length)
    rms = _normalize(rms)

    return AudioAnalysis(
        path=path,
        sr=sr,
        duration=duration,
        tempo=tempo,
        beats=beats,
        downbeats=downbeats,
        onsets=onset_times,
        beat_strength=beat_strength,
        rms_times=rms_times,
        rms=rms,
        _y=y,
    )


def _robust_load(path: str, sr: int):
    """
    Carrega áudio de forma robusta a formatos/codecs.

    Tenta o carregamento normal do librosa (soundfile). Se falhar — comum no
    macOS com MP3/M4A quando o libsndfile não decodifica o codec — cai para o
    FFmpeg, convertendo para WAV PCM temporário e recarregando. Requer FFmpeg
    no PATH (é uma dependência do projeto de qualquer forma).
    """
    try:
        return librosa.load(path, sr=sr, mono=True)
    except Exception as exc:  # noqa: BLE001 — degrada para o fallback via FFmpeg
        wav = _ffmpeg_to_wav(path, sr)
        if wav is None:
            raise RuntimeError(
                f"não foi possível ler o áudio {path!r}. "
                f"Instale o FFmpeg (brew install ffmpeg) e tente de novo. "
                f"Causa original: {exc}"
            ) from exc
        try:
            return librosa.load(wav, sr=sr, mono=True)
        finally:
            try:
                os.remove(wav)
            except OSError:
                pass


def _ffmpeg_to_wav(path: str, sr: int):
    """Converte qualquer arquivo de áudio para WAV PCM mono via FFmpeg."""
    import shutil
    import subprocess
    import tempfile

    if shutil.which("ffmpeg") is None:
        return None
    fd, out = tempfile.mkstemp(suffix=".wav")
    os.close(fd)
    try:
        subprocess.run(
            ["ffmpeg", "-y", "-i", path, "-ac", "1", "-ar", str(sr),
             "-vn", "-f", "wav", out],
            check=True, capture_output=True,
        )
        return out
    except (subprocess.CalledProcessError, FileNotFoundError):
        try:
            os.remove(out)
        except OSError:
            pass
        return None


def _normalize(x: np.ndarray) -> np.ndarray:
    if x.size == 0:
        return x
    lo, hi = float(np.min(x)), float(np.max(x))
    if hi - lo < 1e-9:
        return np.zeros_like(x)
    return (x - lo) / (hi - lo)


def _estimate_downbeats(beats: np.ndarray, strength: np.ndarray,
                        beats_per_bar: int = 4) -> np.ndarray:
    """
    Estimativa simples de downbeats: escolhe, entre as `beats_per_bar` fases
    possíveis, aquela cuja soma de força de batida é máxima (compasso 4/4).
    """
    if beats.size < beats_per_bar:
        return beats.copy()
    best_phase, best_score = 0, -np.inf
    for phase in range(beats_per_bar):
        idx = np.arange(phase, beats.size, beats_per_bar)
        score = float(np.sum(strength[idx])) if strength.size else float(idx.size)
        if score > best_score:
            best_score, best_phase = score, phase
    return beats[np.arange(best_phase, beats.size, beats_per_bar)]
