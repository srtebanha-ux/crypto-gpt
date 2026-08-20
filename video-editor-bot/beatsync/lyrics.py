"""
lyrics.py
=========

Transcrição de letras com timestamps via Whisper (opcional).

Usada para dois fins:
  1. Priorizar cortes em fronteiras de frases/palavras (cadência da letra).
  2. Opcionalmente queimar legendas sincronizadas no vídeo final.

Whisper é uma dependência pesada e opcional. Se não estiver instalado, o
resto do pipeline continua funcionando normalmente (apenas sem letras).
Suporta tanto `openai-whisper` quanto `faster-whisper`.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import List, Optional

import numpy as np


@dataclass
class WordStamp:
    start: float
    end: float
    text: str


@dataclass
class LyricAnalysis:
    language: Optional[str]
    words: List[WordStamp]
    segments: List[WordStamp]  # frases inteiras

    def onset_times(self) -> np.ndarray:
        """Início de cada palavra — bons candidatos a corte 'na letra'."""
        return np.array([w.start for w in self.words], dtype=float)

    def phrase_boundaries(self) -> np.ndarray:
        """Início de cada frase — cortes mais 'respirados', por verso."""
        return np.array([s.start for s in self.segments], dtype=float)


def _which_backend() -> Optional[str]:
    try:
        import faster_whisper  # noqa: F401
        return "faster_whisper"
    except ImportError:
        pass
    try:
        import whisper  # noqa: F401
        return "whisper"
    except ImportError:
        return None


def transcribe(
    audio_path: str,
    model_size: str = "small",
    language: Optional[str] = None,
) -> Optional[LyricAnalysis]:
    """
    Transcreve o áudio retornando timestamps de palavras e frases.

    Retorna None se nenhum backend Whisper estiver disponível — o chamador
    deve tratar isso como "sem análise de letra".
    """
    backend = _which_backend()
    if backend is None:
        return None
    if backend == "faster_whisper":
        return _transcribe_faster(audio_path, model_size, language)
    return _transcribe_openai(audio_path, model_size, language)


def _transcribe_faster(audio_path, model_size, language) -> LyricAnalysis:
    from faster_whisper import WhisperModel

    model = WhisperModel(model_size, device="auto", compute_type="int8")
    segments_it, info = model.transcribe(
        audio_path, language=language, word_timestamps=True
    )
    words: List[WordStamp] = []
    phrases: List[WordStamp] = []
    for seg in segments_it:
        phrases.append(WordStamp(seg.start, seg.end, seg.text.strip()))
        for w in (seg.words or []):
            words.append(WordStamp(w.start, w.end, w.word.strip()))
    return LyricAnalysis(language=info.language, words=words, segments=phrases)


def _transcribe_openai(audio_path, model_size, language) -> LyricAnalysis:
    import whisper

    model = whisper.load_model(model_size)
    result = model.transcribe(
        audio_path, language=language, word_timestamps=True, verbose=False
    )
    words: List[WordStamp] = []
    phrases: List[WordStamp] = []
    for seg in result.get("segments", []):
        phrases.append(WordStamp(seg["start"], seg["end"], seg["text"].strip()))
        for w in seg.get("words", []):
            words.append(
                WordStamp(w["start"], w["end"], str(w.get("word", "")).strip())
            )
    return LyricAnalysis(
        language=result.get("language"), words=words, segments=phrases
    )
