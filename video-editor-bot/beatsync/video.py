"""
video.py
========

Camada de vídeo: descoberta e sondagem de clipes brutos, seleção de trechos,
aplicação de transições/efeitos e renderização final via MoviePy (+ FFmpeg).

O motor de corte (editor.py) decide *quando* cortar; este módulo sabe *como*
transformar cada segmento em um pedaço de clipe pronto para concatenar.
"""

from __future__ import annotations

import os
import random
import subprocess
from dataclasses import dataclass
from glob import glob
from typing import List, Optional, Tuple

try:
    from moviepy import (
        VideoFileClip,
        concatenate_videoclips,
        vfx,
        afx,
    )
    from moviepy.audio.io.AudioFileClip import AudioFileClip
except ImportError as exc:  # pragma: no cover
    raise ImportError(
        "moviepy>=2.0 é necessário para o processamento de vídeo. "
        "Instale com: pip install moviepy"
    ) from exc


VIDEO_EXTS = (".mp4", ".mov", ".mkv", ".avi", ".webm", ".m4v", ".mpg", ".mpeg")


@dataclass
class SourceClip:
    """Metadados sondados de um clipe bruto (sem decodificar o vídeo todo)."""

    path: str
    duration: float
    width: int
    height: int
    fps: float

    @property
    def aspect(self) -> float:
        return self.width / self.height if self.height else 1.0


# ---------------------------------------------------------------------------- #
# Descoberta e sondagem
# ---------------------------------------------------------------------------- #
def discover_clips(directory: str, recursive: bool = True) -> List[str]:
    """Lista todos os arquivos de vídeo de um diretório."""
    paths: List[str] = []
    pattern = "**/*" if recursive else "*"
    for p in glob(os.path.join(directory, pattern), recursive=recursive):
        if p.lower().endswith(VIDEO_EXTS):
            paths.append(p)
    return sorted(paths)


def probe_clip(path: str) -> Optional[SourceClip]:
    """Sonda dimensões/duração/fps com ffprobe (rápido, sem decodificar)."""
    try:
        out = subprocess.run(
            [
                "ffprobe", "-v", "error",
                "-select_streams", "v:0",
                "-show_entries",
                "stream=width,height,avg_frame_rate:format=duration",
                "-of", "default=noprint_wrappers=1:nokey=0",
                path,
            ],
            capture_output=True, text=True, check=True,
        ).stdout
    except (subprocess.CalledProcessError, FileNotFoundError):
        return _probe_with_moviepy(path)

    info = {}
    for line in out.strip().splitlines():
        if "=" in line:
            k, v = line.split("=", 1)
            info[k.strip()] = v.strip()
    try:
        num, den = (info.get("avg_frame_rate", "30/1").split("/") + ["1"])[:2]
        fps = float(num) / float(den) if float(den) else 30.0
        return SourceClip(
            path=path,
            duration=float(info.get("duration", 0) or 0),
            width=int(info.get("width", 0) or 0),
            height=int(info.get("height", 0) or 0),
            fps=fps or 30.0,
        )
    except (ValueError, ZeroDivisionError):
        return _probe_with_moviepy(path)


def _probe_with_moviepy(path: str) -> Optional[SourceClip]:
    try:
        with VideoFileClip(path) as c:
            return SourceClip(path, c.duration, c.w, c.h, c.fps or 30.0)
    except Exception:
        return None


def probe_all(paths: List[str]) -> List[SourceClip]:
    clips = [probe_clip(p) for p in paths]
    return [c for c in clips if c and c.duration and c.duration > 0.1]


# ---------------------------------------------------------------------------- #
# Seleção de trechos dentro dos clipes brutos
# ---------------------------------------------------------------------------- #
class ClipPool:
    """
    Gerencia a extração de subtrechos dos clipes brutos, evitando reutilizar
    sempre o mesmo pedaço e distribuindo o uso entre todos os arquivos.
    """

    def __init__(self, sources: List[SourceClip], seed: Optional[int] = None,
                 shuffle: bool = True):
        if not sources:
            raise ValueError("Nenhum clipe de vídeo válido foi encontrado.")
        self.sources = list(sources)
        self.rng = random.Random(seed)
        self._order: List[int] = []
        self._cursor = {i: 0.0 for i in range(len(self.sources))}
        self._shuffle = shuffle

    def _next_source_index(self) -> int:
        if not self._order:
            self._order = list(range(len(self.sources)))
            if self._shuffle:
                self.rng.shuffle(self._order)
        return self._order.pop()

    def take(self, need: float, min_take: float = 0.3) -> Tuple[str, float, float]:
        """
        Retorna (path, start, end) de um trecho com ~`need` segundos de duração,
        avançando um cursor por clipe para não repetir o mesmo pedaço.
        """
        need = max(need, min_take)
        for _ in range(len(self.sources) * 2):
            idx = self._next_source_index()
            src = self.sources[idx]
            start = self._cursor[idx]
            if start + need > src.duration:
                # reinicia do começo com um pequeno offset aleatório
                if src.duration <= need:
                    start = 0.0
                    end = min(src.duration, need)
                    return src.path, start, end
                start = self.rng.uniform(0, max(0.0, src.duration - need))
            end = min(start + need, src.duration)
            self._cursor[idx] = end + 0.05
            if end - start >= min_take:
                return src.path, start, end
        # fallback: primeiro clipe
        src = self.sources[0]
        return src.path, 0.0, min(need, src.duration)


# ---------------------------------------------------------------------------- #
# Construção dos subclipes com efeitos/transições
# ---------------------------------------------------------------------------- #
def build_subclip(
    path: str,
    start: float,
    end: float,
    target_size: Tuple[int, int],
    fps: int,
    fade: float = 0.0,
    speed: float = 1.0,
    zoom_punch: bool = False,
) -> "VideoFileClip":
    """
    Extrai [start, end] do clipe, normaliza para `target_size`/`fps` e aplica
    efeitos. Retorna um clipe MoviePy (sem áudio — o áudio vem da música).
    """
    clip = VideoFileClip(path).subclipped(start, end)
    clip = clip.without_audio()

    # normaliza resolução preservando enquadramento (crop central + resize)
    clip = _fit_to(clip, target_size)

    if speed and abs(speed - 1.0) > 1e-3:
        clip = clip.with_effects([vfx.MultiplySpeed(speed)])

    if zoom_punch:
        # leve "soco" de zoom no início do corte, dá impacto na batida
        clip = clip.with_effects([vfx.Resize(lambda t: 1.06 - 0.06 * min(t / 0.18, 1))])

    effects = []
    if fade > 0:
        effects += [vfx.FadeIn(fade), vfx.FadeOut(fade)]
    if effects:
        clip = clip.with_effects(effects)

    return clip.with_fps(fps)


def _fit_to(clip, target_size: Tuple[int, int]):
    """Redimensiona + crop central para preencher exatamente target_size."""
    tw, th = target_size
    cw, ch = clip.w, clip.h
    scale = max(tw / cw, th / ch)
    clip = clip.with_effects([vfx.Resize(scale)])
    # crop central
    clip = clip.with_effects([vfx.Crop(
        x_center=clip.w / 2, y_center=clip.h / 2, width=tw, height=th
    )])
    return clip


# ---------------------------------------------------------------------------- #
# Montagem + render final
# ---------------------------------------------------------------------------- #
def assemble_and_render(
    subclips: List["VideoFileClip"],
    audio_path: str,
    output_path: str,
    fps: int = 30,
    crossfade: float = 0.0,
    codec: str = "libx264",
    audio_codec: str = "aac",
    bitrate: Optional[str] = None,
    threads: int = 4,
    preset: str = "medium",
    logger=None,
) -> str:
    """
    Concatena os subclipes, casa a trilha de áudio e renderiza o MP4 final.
    """
    if crossfade > 0 and len(subclips) > 1:
        faded = [subclips[0]]
        for c in subclips[1:]:
            faded.append(c.with_effects([vfx.CrossFadeIn(crossfade)]))
        video = concatenate_videoclips(faded, method="compose", padding=-crossfade)
    else:
        video = concatenate_videoclips(subclips, method="chain")

    audio = AudioFileClip(audio_path)
    # casa a duração: nunca deixa o vídeo passar do fim da música
    final_dur = min(video.duration, audio.duration)
    video = video.subclipped(0, final_dur)
    audio = audio.subclipped(0, final_dur).with_effects([afx.AudioFadeOut(0.4)])
    video = video.with_audio(audio)

    os.makedirs(os.path.dirname(os.path.abspath(output_path)) or ".", exist_ok=True)
    video.write_videofile(
        output_path,
        fps=fps,
        codec=codec,
        audio_codec=audio_codec,
        bitrate=bitrate,
        threads=threads,
        preset=preset,
        logger=logger if logger is not None else "bar",
        temp_audiofile=os.path.join(
            os.path.dirname(os.path.abspath(output_path)) or ".", "_temp_audio.m4a"
        ),
        remove_temp=True,
    )

    for c in subclips:
        try:
            c.close()
        except Exception:
            pass
    try:
        video.close()
        audio.close()
    except Exception:
        pass
    return output_path
