"""
nexus_editor.py — STEP 3 (Matching Semântico) + STEP 4 (Render)
===============================================================

Orquestrador principal do NEXUS-ÔMEGA. Une os dois "cérebros":

  STEP 3 — Motor de Matching (vetores):
    Calcula a similaridade do cosseno entre o SIGNIFICADO das frases cantadas
    (embeddings de texto do CLIP, derivados da transcrição do Whisper) e o
    conteúdo visual das cenas (embeddings de imagem do CLIP). Para cada janela
    da música — delimitada pelas batidas do librosa — escolhe a cena que melhor
    representa a letra cantada naquele instante, alinhando o corte ao BPM.

  STEP 4 — Render (MoviePy/FFmpeg):
    Compõe a timeline final dos subclipes escolhidos e exporta o .mp4 com o
    áudio original sobreposto.

Uso:
    python nexus_editor.py --audio musica.mp3 --videos a.mp4 b.mp4 \
        --out videoclipe_final.mp4 --whisper small --beats-per-cut 2
"""

from __future__ import annotations

import argparse
from dataclasses import dataclass
from typing import List, Optional, Sequence

import numpy as np

import audio_brain as ab
import vision_brain as vb

# --- compat MoviePy (carregado sob demanda, só no STEP 4) --------------------
# v2: `from moviepy import ...`  ·  v1: `from moviepy.editor import ...`
# O import é lazy para que o STEP 3 (matching) rode sem MoviePy instalado.
AudioFileClip = VideoFileClip = concatenate_videoclips = vfx = None  # type: ignore
_MOVIEPY_V2: Optional[bool] = None


def _ensure_moviepy() -> None:
    global AudioFileClip, VideoFileClip, concatenate_videoclips, vfx, _MOVIEPY_V2
    if _MOVIEPY_V2 is not None:
        return
    try:  # MoviePy 2.x
        from moviepy import (
            AudioFileClip as _A, VideoFileClip as _V,
            concatenate_videoclips as _C, vfx as _F,
        )
        _MOVIEPY_V2 = True
    except ImportError:  # MoviePy 1.x
        from moviepy.editor import (  # type: ignore
            AudioFileClip as _A, VideoFileClip as _V,
            concatenate_videoclips as _C,
        )
        import moviepy.video.fx.all as _F  # type: ignore
        _MOVIEPY_V2 = False
    AudioFileClip, VideoFileClip, concatenate_videoclips, vfx = _A, _V, _C, _F


@dataclass
class Cut:
    """Um corte da timeline final: um trecho de uma cena, casado à letra."""

    t_start: float          # posição na música (s)
    t_end: float
    video_path: str
    src_in: float           # ponto de entrada na cena (s)
    src_out: float
    score: float            # similaridade semântica (cosine)
    lyric: str

    @property
    def duration(self) -> float:
        return self.t_end - self.t_start


# --------------------------------------------------------------------------- #
# STEP 3 — Matching por similaridade do cosseno
# --------------------------------------------------------------------------- #
def build_windows(brain: "ab.AudioBrain", beats_per_cut: int) -> List[tuple]:
    """
    Constrói as janelas de corte a partir das batidas (alinhadas ao BPM).
    Agrupa `beats_per_cut` batidas por corte. Nos drops, força um corte.
    """
    beats = list(brain.beats)
    if not beats:
        # sem batidas: divide a música em janelas fixas de 1.5s
        n = max(1, int(brain.duration / 1.5))
        edges = list(np.linspace(0, brain.duration, n + 1))
        return list(zip(edges[:-1], edges[1:]))

    edges = beats[::max(1, beats_per_cut)]
    if edges[0] > 0.05:
        edges = [0.0] + edges
    if edges[-1] < brain.duration - 0.05:
        edges.append(brain.duration)
    # injeta drops como fronteiras de corte garantidas
    for d in brain.drops:
        edges.append(brain.nearest_beat(d))
    edges = sorted(set(round(e, 3) for e in edges))
    return [(a, b) for a, b in zip(edges[:-1], edges[1:]) if b - a > 0.15]


def cosine_matrix(text_emb: np.ndarray, image_emb: np.ndarray) -> np.ndarray:
    """
    Similaridade do cosseno entre frases (linhas) e cenas (colunas).
    Como os embeddings já vêm L2-normalizados do CLIP, é o produto interno.
    """
    if text_emb.size == 0 or image_emb.size == 0:
        return np.zeros((text_emb.shape[0], image_emb.shape[0]), dtype=np.float32)
    return text_emb @ image_emb.T


def match_timeline(
    brain: "ab.AudioBrain",
    scenes: List["vb.SceneClip"],
    encoder: "vb.ClipEncoder",
    beats_per_cut: int = 2,
    avoid_repeat: bool = True,
) -> List[Cut]:
    """
    Para cada janela [t0,t1] (alinhada às batidas), pega a letra cantada em t0,
    calcula a similaridade com todas as cenas e escolhe a melhor. Evita repetir
    a mesma cena em sequência quando possível.
    """
    if not scenes:
        raise RuntimeError("nenhuma cena disponível (rode o vision_brain antes).")

    windows = build_windows(brain, beats_per_cut)
    scene_emb = np.stack([s.embedding for s in scenes])       # (S, dim)

    # embedding de texto da letra ativa em cada janela (via CLIP text encoder).
    # Usa o MEIO da janela para evitar artefato nas fronteiras de frase.
    lyrics = []
    for (t0, t1) in windows:
        ph = brain.phrase_at((t0 + t1) / 2.0)
        lyrics.append(ph.text if ph and ph.text else "cinematic scene")
    text_emb = encoder.encode_text(lyrics)                    # (W, dim)

    sims = cosine_matrix(text_emb, scene_emb)                 # (W, S)

    cuts: List[Cut] = []
    last_scene = -1
    for i, (t0, t1) in enumerate(windows):
        order = np.argsort(-sims[i])                          # melhores primeiro
        best = int(order[0])
        # só troca para o 2º lugar se ele for competitivo (evita repetir sem
        # sacrificar o casamento semântico quando o melhor é claramente superior)
        if avoid_repeat and best == last_scene and len(order) > 1:
            runner = int(order[1])
            if sims[i, runner] >= sims[i, best] - 0.05:
                best = runner
        last_scene = best
        scene = scenes[best]

        need = t1 - t0
        # escolhe o ponto de entrada dentro da cena (centraliza se sobrar duração)
        span = max(0.0, scene.duration - need)
        src_in = scene.start + (span * 0.5 if span > 0 else 0.0)
        src_out = min(scene.end, src_in + need)

        cuts.append(Cut(
            t_start=t0, t_end=t1,
            video_path=scene.video_path,
            src_in=src_in, src_out=src_out,
            score=float(sims[i, best]),
            lyric=lyrics[i],
        ))
    return cuts


# --------------------------------------------------------------------------- #
# STEP 4 — Render (MoviePy / FFmpeg)
# --------------------------------------------------------------------------- #
def _subclip(clip, a: float, b: float):
    fn = getattr(clip, "subclipped", None) or getattr(clip, "subclip")
    return fn(a, b)


def _resize(clip, size):
    if _MOVIEPY_V2:
        return clip.with_effects([vfx.Resize(size)])
    return clip.resize(newsize=size)


def _crop(clip, x_center, y_center, width, height):
    if _MOVIEPY_V2:
        return clip.with_effects([vfx.Crop(
            x_center=x_center, y_center=y_center, width=width, height=height)])
    return vfx.crop(clip, x_center=x_center, y_center=y_center,
                    width=width, height=height)


def _fit_cover(clip, target):
    """Redimensiona + crop central para preencher exatamente o target."""
    tw, th = target
    scale = max(tw / clip.w, th / clip.h)
    clip = _resize(clip, (round(clip.w * scale), round(clip.h * scale)))
    return _crop(clip, clip.w / 2, clip.h / 2, tw, th)


def _attach_audio(video, audio):
    audio = _subclip(audio, 0, min(video.duration, audio.duration))
    if _MOVIEPY_V2:
        return video.with_audio(audio)
    return video.set_audio(audio)


def render(
    cuts: List[Cut],
    audio_path: str,
    out_path: str,
    size=(1920, 1080),
    fps: int = 30,
    codec: str = "libx264",
    audio_codec: str = "aac",
) -> str:
    _ensure_moviepy()
    subclips = []
    for c in cuts:
        try:
            base = VideoFileClip(c.video_path)
            piece = _subclip(base, c.src_in, min(c.src_out, base.duration))
            piece = piece.without_audio() if hasattr(piece, "without_audio") else piece
            piece = _fit_cover(piece, size)
            # garante a duração exata do slot (sincronia rígida com o BPM)
            if piece.duration > c.duration:
                piece = _subclip(piece, 0, c.duration)
            subclips.append(piece)
        except Exception as exc:  # pula cenas ilegíveis sem quebrar o render
            print(f"[nexus] aviso: cena ignorada ({c.video_path}): {exc}")

    if not subclips:
        raise RuntimeError("nenhum subclipe válido para renderizar.")

    method = "chain" if _MOVIEPY_V2 else "chain"
    video = concatenate_videoclips(subclips, method=method)

    audio = AudioFileClip(audio_path)
    video = _attach_audio(video, audio)

    video.write_videofile(
        out_path, fps=fps, codec=codec, audio_codec=audio_codec,
        threads=4, preset="medium",
    )
    for c in subclips:
        try:
            c.close()
        except Exception:
            pass
    return out_path


# --------------------------------------------------------------------------- #
# Orquestração completa (Step 1 → 4)
# --------------------------------------------------------------------------- #
def run(
    audio_path: str,
    video_paths: Sequence[str],
    out_path: str = "nexus_output.mp4",
    whisper_model: str = "small",
    language: Optional[str] = None,
    beats_per_cut: int = 2,
    size=(1920, 1080),
    fps: int = 30,
    scene_threshold: float = 27.0,
) -> List[Cut]:
    print("[nexus] STEP 1 — extração semântica do áudio (Whisper + Librosa)…")
    brain = ab.run(audio_path, whisper_model, language)
    print(f"        BPM≈{brain.tempo:.1f} | {len(brain.beats)} batidas | "
          f"{len(brain.phrases)} frases | {len(brain.drops)} drops")

    print("[nexus] STEP 2 — cenas + visão computacional (SceneDetect + CLIP)…")
    scenes, encoder = vb.analyze_videos(video_paths, threshold=scene_threshold)
    print(f"        {len(scenes)} cenas embedadas de {len(video_paths)} vídeo(s)")

    print("[nexus] STEP 3 — matching semântico (cosine similarity)…")
    cuts = match_timeline(brain, scenes, encoder, beats_per_cut=beats_per_cut)
    avg = float(np.mean([c.score for c in cuts])) if cuts else 0.0
    print(f"        {len(cuts)} cortes | similaridade média={avg:.3f}")

    print("[nexus] STEP 4 — render final (MoviePy/FFmpeg)…")
    render(cuts, audio_path, out_path, size=size, fps=fps)
    print(f"[nexus] ✓ concluído → {out_path}")
    return cuts


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(
        description="NEXUS-ÔMEGA — editor semântico cognitivo (Whisper+CLIP+BPM)")
    ap.add_argument("--audio", required=True)
    ap.add_argument("--videos", required=True, nargs="+")
    ap.add_argument("--out", default="nexus_output.mp4")
    ap.add_argument("--whisper", default="small")
    ap.add_argument("--language", default=None)
    ap.add_argument("--beats-per-cut", type=int, default=2)
    ap.add_argument("--width", type=int, default=1920)
    ap.add_argument("--height", type=int, default=1080)
    ap.add_argument("--fps", type=int, default=30)
    ap.add_argument("--scene-threshold", type=float, default=27.0)
    args = ap.parse_args(argv)

    run(
        audio_path=args.audio,
        video_paths=args.videos,
        out_path=args.out,
        whisper_model=args.whisper,
        language=args.language,
        beats_per_cut=args.beats_per_cut,
        size=(args.width, args.height),
        fps=args.fps,
        scene_threshold=args.scene_threshold,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
