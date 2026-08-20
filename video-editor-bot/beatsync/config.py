"""
config.py
=========

Configuração declarativa do render. Presets prontos para os cenários mais
comuns (clipe vertical de rede social, videoclipe cinematográfico, etc.).
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Optional, Tuple


@dataclass
class RenderConfig:
    # --- Resolução / saída ---------------------------------------------------
    width: int = 1920
    height: int = 1080
    fps: int = 30

    # --- Estratégia de corte -------------------------------------------------
    cut_mode: str = "hybrid"       # beat | downbeat | onset | hybrid
    subdivision: int = 1           # densidade extra de cortes (1,2,4...)
    min_cut: float = 0.35          # duração mínima de um corte (s)
    min_gap: float = 0.20          # distância mínima entre cortes (s)

    # --- Sincronia com a letra ----------------------------------------------
    use_lyrics: bool = False       # usa Whisper para reforçar cortes na letra
    whisper_model: str = "small"
    lyric_weight: float = 0.5      # o quanto a letra "puxa" os cortes

    # --- Estética / transições ----------------------------------------------
    crossfade: float = 0.0         # duração do crossfade entre cortes (s)
    fade: float = 0.0              # fade in/out por corte (s)
    zoom_punch: bool = True        # "soco" de zoom na batida
    beat_speed_ramp: bool = False  # acelera levemente em picos de energia

    # --- Codificação ---------------------------------------------------------
    codec: str = "libx264"
    audio_codec: str = "aac"
    bitrate: Optional[str] = None
    preset: str = "medium"
    threads: int = 4

    # --- Reprodutibilidade ---------------------------------------------------
    seed: Optional[int] = None
    shuffle: bool = True

    @property
    def size(self) -> Tuple[int, int]:
        return (self.width, self.height)


PRESETS = {
    "reels": RenderConfig(
        width=1080, height=1920, fps=30,
        cut_mode="beat", subdivision=1, min_cut=0.28,
        crossfade=0.0, zoom_punch=True, preset="fast",
    ),
    "cinematic": RenderConfig(
        width=1920, height=1080, fps=24,
        cut_mode="downbeat", subdivision=1, min_cut=0.8,
        crossfade=0.35, fade=0.05, zoom_punch=False, preset="slow",
    ),
    "hype": RenderConfig(
        width=1920, height=1080, fps=30,
        cut_mode="hybrid", subdivision=2, min_cut=0.22,
        crossfade=0.0, zoom_punch=True, beat_speed_ramp=True, preset="medium",
    ),
    "clean": RenderConfig(
        width=1920, height=1080, fps=30,
        cut_mode="beat", subdivision=1, min_cut=0.5,
        crossfade=0.12, zoom_punch=False, preset="medium",
    ),
}


def get_preset(name: str) -> RenderConfig:
    if name not in PRESETS:
        raise KeyError(
            f"preset '{name}' inexistente. Opções: {', '.join(PRESETS)}"
        )
    # devolve uma cópia para permitir overrides sem mutar o preset global
    import copy
    return copy.deepcopy(PRESETS[name])
