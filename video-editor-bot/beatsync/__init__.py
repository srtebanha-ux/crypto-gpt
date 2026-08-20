"""
beatsync — bot de edição de vídeo sincronizada com a batida da música.

Uso programático rápido:

    from beatsync import make_video, get_preset

    cfg = get_preset("hype")
    make_video("musica.mp3", "clipes/", "saida.mp4", cfg, log=print)

Nota: os símbolos que dependem de MoviePy/FFmpeg (VideoEditor, make_video,
TimelineEntry) são importados de forma preguiçosa, para que a análise de
áudio (`beatsync.audio`) funcione mesmo sem MoviePy instalado.
"""

from .audio import AudioAnalysis, analyze_audio
from .config import PRESETS, RenderConfig, get_preset

__version__ = "0.1.0"

__all__ = [
    "AudioAnalysis",
    "analyze_audio",
    "RenderConfig",
    "PRESETS",
    "get_preset",
    "VideoEditor",
    "TimelineEntry",
    "make_video",
    "__version__",
]

_LAZY = {"VideoEditor", "TimelineEntry", "make_video"}


def __getattr__(name):  # PEP 562 — importa editor só quando necessário
    if name in _LAZY:
        from . import editor
        return getattr(editor, name)
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")


def __dir__():
    return sorted(__all__)
