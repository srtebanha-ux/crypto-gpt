"""
ffmpeg_util.py
==============

Utilitários compartilhados de FFmpeg: localização robusta do binário e
execução com baixa prioridade (nice) para não saturar a máquina.

A localização tenta, nesta ordem:
  1. variável de ambiente BEATSYNC_FFMPEG (se apontar para um binário válido);
  2. o FFmpeg do sistema no PATH;
  3. o binário embutido do imageio-ffmpeg (dependência do MoviePy) — garante
     funcionamento mesmo quando o FFmpeg do sistema não está no PATH (comum
     no macOS quando o servidor roda com um PATH diferente do terminal).
"""

from __future__ import annotations

import os
import shutil
import subprocess
from functools import lru_cache
from typing import List, Optional


@lru_cache(maxsize=1)
def ffmpeg_exe() -> Optional[str]:
    env = os.environ.get("BEATSYNC_FFMPEG")
    if env and os.path.exists(env):
        return env
    found = shutil.which("ffmpeg")
    if found:
        return found
    try:
        import imageio_ffmpeg
        return imageio_ffmpeg.get_ffmpeg_exe()
    except Exception:
        return None


@lru_cache(maxsize=1)
def ffprobe_exe() -> Optional[str]:
    env = os.environ.get("BEATSYNC_FFPROBE")
    if env and os.path.exists(env):
        return env
    return shutil.which("ffprobe")


def _low_priority():
    """preexec_fn para POSIX: roda o subprocesso com prioridade reduzida."""
    try:
        os.nice(int(os.environ.get("BEATSYNC_NICE", "10")))
    except Exception:
        pass


def run_ffmpeg(args: List[str], timeout: Optional[float] = None) -> subprocess.CompletedProcess:
    """
    Executa o FFmpeg com prioridade baixa (nice) e saída capturada.
    `args` NÃO deve incluir o binário — ele é resolvido aqui.
    """
    exe = ffmpeg_exe()
    if exe is None:
        raise RuntimeError(
            "FFmpeg não encontrado. Instale com 'brew install ffmpeg' "
            "ou 'pip install imageio-ffmpeg'."
        )
    kwargs = {}
    if os.name == "posix":
        kwargs["preexec_fn"] = _low_priority
    return subprocess.run(
        [exe, *args], capture_output=True, timeout=timeout, **kwargs
    )
