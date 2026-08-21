"""
audio_brain.py — STEP 1: Extração Semântica do Áudio
====================================================

Ouve/lê a música e devolve:
  * transcrição com WORD-LEVEL timestamps (openai-whisper);
  * frases agrupadas (segmentos) com início/fim exatos;
  * array de tempos de batida e BPM (librosa);
  * "drops" — picos abruptos de energia (onset + RMS).

Saída serializável em JSON, consumida pelo nexus_editor.

Uso:
    python audio_brain.py musica.mp3 --model small --out audio_brain.json
"""

from __future__ import annotations

import argparse
import json
from dataclasses import asdict, dataclass, field
from typing import List, Optional

import numpy as np


# --------------------------------------------------------------------------- #
# Estruturas de dados
# --------------------------------------------------------------------------- #
@dataclass
class Word:
    start: float
    end: float
    text: str


@dataclass
class Phrase:
    start: float
    end: float
    text: str
    words: List[Word] = field(default_factory=list)

    @property
    def mid(self) -> float:
        return (self.start + self.end) / 2.0


@dataclass
class AudioBrain:
    audio_path: str
    language: Optional[str]
    duration: float
    tempo: float                 # BPM
    beats: List[float]           # tempos de batida (s)
    drops: List[float]           # tempos de "drop" (s)
    phrases: List[Phrase]
    words: List[Word]

    # ---- consulta usada no matching ------------------------------------ #
    def phrase_at(self, t: float) -> Optional[Phrase]:
        """Frase sendo cantada no instante t (ou a mais próxima)."""
        for p in self.phrases:
            if p.start <= t <= p.end:
                return p
        if not self.phrases:
            return None
        return min(self.phrases, key=lambda p: abs(p.mid - t))

    def nearest_beat(self, t: float) -> float:
        """Batida mais próxima de t (para alinhar o corte ao ritmo)."""
        if not self.beats:
            return t
        arr = np.asarray(self.beats)
        return float(arr[int(np.argmin(np.abs(arr - t)))])

    def to_json(self) -> str:
        d = asdict(self)
        return json.dumps(d, ensure_ascii=False, indent=2)


# --------------------------------------------------------------------------- #
# Step 1a — Whisper (transcrição + word timestamps)
# --------------------------------------------------------------------------- #
def transcribe_lyrics(
    audio_path: str, model_size: str = "small", language: Optional[str] = None
) -> tuple[Optional[str], List[Phrase], List[Word]]:
    import whisper

    model = whisper.load_model(model_size)
    result = model.transcribe(
        audio_path,
        language=language,
        word_timestamps=True,
        verbose=False,
    )

    phrases: List[Phrase] = []
    all_words: List[Word] = []
    for seg in result.get("segments", []):
        words = [
            Word(float(w["start"]), float(w["end"]), str(w.get("word", "")).strip())
            for w in seg.get("words", [])
            if w.get("word", "").strip()
        ]
        all_words.extend(words)
        phrases.append(
            Phrase(
                start=float(seg["start"]),
                end=float(seg["end"]),
                text=str(seg["text"]).strip(),
                words=words,
            )
        )
    return result.get("language"), phrases, all_words


# --------------------------------------------------------------------------- #
# Step 1b — Librosa (BPM, batidas, drops)
# --------------------------------------------------------------------------- #
def analyze_rhythm(
    audio_path: str, sr: int = 22050, hop_length: int = 512
) -> tuple[float, float, List[float], List[float]]:
    import librosa

    y, sr = librosa.load(audio_path, sr=sr, mono=True)
    duration = float(librosa.get_duration(y=y, sr=sr))

    tempo, beat_frames = librosa.beat.beat_track(
        y=y, sr=sr, hop_length=hop_length, units="frames"
    )
    tempo = float(np.atleast_1d(tempo)[0])
    beats = librosa.frames_to_time(beat_frames, sr=sr, hop_length=hop_length)

    # drops: picos abruptos combinando onset strength + variação de RMS
    onset_env = librosa.onset.onset_strength(y=y, sr=sr, hop_length=hop_length)
    rms = librosa.feature.rms(y=y, hop_length=hop_length)[0]
    rms_delta = np.diff(rms, prepend=rms[:1])
    score = _norm(onset_env) + _norm(np.clip(rms_delta, 0, None))
    if score.size:
        thresh = np.percentile(score, 96)
        peak_frames = np.where(score >= thresh)[0]
        drop_times = librosa.frames_to_time(peak_frames, sr=sr, hop_length=hop_length)
        drops = _dedup(drop_times, min_gap=1.5)
    else:
        drops = []

    return duration, tempo, [float(b) for b in beats], [float(d) for d in drops]


def _norm(x: np.ndarray) -> np.ndarray:
    if x.size == 0:
        return x
    lo, hi = float(x.min()), float(x.max())
    return (x - lo) / (hi - lo) if hi - lo > 1e-9 else np.zeros_like(x)


def _dedup(times: np.ndarray, min_gap: float) -> List[float]:
    out: List[float] = []
    for t in np.sort(times):
        if not out or t - out[-1] >= min_gap:
            out.append(float(t))
    return out


# --------------------------------------------------------------------------- #
# Orquestração do Step 1
# --------------------------------------------------------------------------- #
def run(audio_path: str, model_size: str = "small",
        language: Optional[str] = None) -> AudioBrain:
    lang, phrases, words = transcribe_lyrics(audio_path, model_size, language)
    duration, tempo, beats, drops = analyze_rhythm(audio_path)
    # se o whisper não deu duração, usa a do librosa
    if phrases:
        duration = max(duration, phrases[-1].end)
    return AudioBrain(
        audio_path=audio_path,
        language=lang,
        duration=duration,
        tempo=tempo,
        beats=beats,
        drops=drops,
        phrases=phrases,
        words=words,
    )


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="STEP 1 — extração semântica do áudio")
    ap.add_argument("audio")
    ap.add_argument("--model", default="small",
                    help="tamanho do Whisper: tiny/base/small/medium/large")
    ap.add_argument("--language", default=None)
    ap.add_argument("--out", "-o", default="audio_brain.json")
    args = ap.parse_args(argv)

    brain = run(args.audio, args.model, args.language)
    with open(args.out, "w", encoding="utf-8") as f:
        f.write(brain.to_json())
    print(
        f"[audio_brain] BPM≈{brain.tempo:.1f} | {len(brain.beats)} batidas | "
        f"{len(brain.drops)} drops | {len(brain.phrases)} frases | "
        f"{len(brain.words)} palavras → {args.out}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
