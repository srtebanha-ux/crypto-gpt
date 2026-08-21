"""
vision_brain.py — STEP 2: Segmentação + Visão Computacional
===========================================================

"Assiste" aos vídeos:
  * PySceneDetect fatia vídeos longos em cenas automaticamente;
  * OpenCV extrai frames representativos de cada cena;
  * CLIP (transformers, openai/clip-vit-base-patch32) gera o embedding
    vetorial visual de cada cena.

O mesmo encoder CLIP também expõe encode_text(), usado no Step 3 para casar
o SIGNIFICADO da letra com o conteúdo visual (espaço multimodal compartilhado).

Uso:
    python vision_brain.py video1.mp4 video2.mp4 --out vision_brain.npz
"""

from __future__ import annotations

import argparse
import os
from dataclasses import dataclass
from typing import List, Optional, Sequence

import numpy as np


CLIP_MODEL = "openai/clip-vit-base-patch32"


@dataclass
class SceneClip:
    """Uma cena detectada, com seu embedding visual CLIP (normalizado)."""

    video_path: str
    index: int
    start: float          # s
    end: float            # s
    embedding: np.ndarray  # shape (dim,), L2-normalizado

    @property
    def duration(self) -> float:
        return self.end - self.start


# --------------------------------------------------------------------------- #
# Encoder CLIP (imagem + texto no mesmo espaço)
# --------------------------------------------------------------------------- #
class ClipEncoder:
    def __init__(self, model_name: str = CLIP_MODEL, device: Optional[str] = None):
        import torch
        from transformers import CLIPModel, CLIPProcessor

        self.torch = torch
        self.device = device or ("cuda" if torch.cuda.is_available() else "cpu")
        self.model = CLIPModel.from_pretrained(model_name).to(self.device).eval()
        self.processor = CLIPProcessor.from_pretrained(model_name)

    @staticmethod
    def _l2(x: np.ndarray) -> np.ndarray:
        n = np.linalg.norm(x, axis=-1, keepdims=True)
        return x / np.clip(n, 1e-8, None)

    def encode_images(self, images: Sequence["object"]) -> np.ndarray:
        """images: lista de PIL.Image → matriz (N, dim) normalizada."""
        if not images:
            return np.zeros((0, 512), dtype=np.float32)
        with self.torch.no_grad():
            inputs = self.processor(images=list(images), return_tensors="pt").to(
                self.device
            )
            feats = self.model.get_image_features(**inputs)
        return self._l2(feats.cpu().numpy().astype(np.float32))

    def encode_text(self, texts: Sequence[str]) -> np.ndarray:
        """texts: lista de frases → matriz (N, dim) normalizada."""
        texts = [t if t.strip() else "." for t in texts]
        if not texts:
            return np.zeros((0, 512), dtype=np.float32)
        with self.torch.no_grad():
            inputs = self.processor(
                text=list(texts), return_tensors="pt", padding=True, truncation=True
            ).to(self.device)
            feats = self.model.get_text_features(**inputs)
        return self._l2(feats.cpu().numpy().astype(np.float32))


# --------------------------------------------------------------------------- #
# Step 2a — segmentação por cenas (PySceneDetect)
# --------------------------------------------------------------------------- #
def detect_scenes(video_path: str, threshold: float = 27.0,
                  min_scene_len: float = 0.6) -> List[tuple]:
    """Retorna [(start_s, end_s), ...]. Fallback: uma única cena = vídeo inteiro."""
    try:
        from scenedetect import ContentDetector, SceneManager, open_video
    except ImportError:
        return _whole_video(video_path)

    try:
        video = open_video(video_path)
        fps = video.frame_rate or 30.0
        sm = SceneManager()
        sm.add_detector(
            ContentDetector(threshold=threshold,
                            min_scene_len=int(max(1, min_scene_len * fps)))
        )
        sm.detect_scenes(video)
        scenes = sm.get_scene_list()
    except Exception:
        return _whole_video(video_path)

    if not scenes:
        return _whole_video(video_path)
    return [(s.get_seconds(), e.get_seconds()) for s, e in scenes]


def _whole_video(video_path: str) -> List[tuple]:
    import cv2

    cap = cv2.VideoCapture(video_path)
    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    n = cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0
    cap.release()
    dur = (n / fps) if fps else 0.0
    return [(0.0, float(dur) if dur > 0 else 1e9)]


# --------------------------------------------------------------------------- #
# Step 2b — frames representativos (OpenCV)
# --------------------------------------------------------------------------- #
def extract_frames(video_path: str, scenes: List[tuple],
                   samples_per_scene: int = 2) -> List[List["object"]]:
    """Para cada cena, extrai `samples_per_scene` frames (PIL) bem distribuídos."""
    import cv2
    from PIL import Image

    cap = cv2.VideoCapture(video_path)
    out: List[List[object]] = []
    for (s, e) in scenes:
        frames: List[object] = []
        span = max(1e-3, e - s)
        for k in range(samples_per_scene):
            t = s + span * (k + 1) / (samples_per_scene + 1)
            cap.set(cv2.CAP_PROP_POS_MSEC, t * 1000.0)
            ok, frame = cap.read()
            if not ok or frame is None:
                continue
            rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
            frames.append(Image.fromarray(rgb))
        out.append(frames)
    cap.release()
    return out


# --------------------------------------------------------------------------- #
# Orquestração do Step 2
# --------------------------------------------------------------------------- #
def analyze_videos(
    video_paths: Sequence[str],
    encoder: Optional[ClipEncoder] = None,
    threshold: float = 27.0,
    samples_per_scene: int = 2,
    min_scene_len: float = 0.6,
) -> tuple[List[SceneClip], ClipEncoder]:
    encoder = encoder or ClipEncoder()
    clips: List[SceneClip] = []

    for path in video_paths:
        if not os.path.exists(path):
            continue
        scenes = detect_scenes(path, threshold, min_scene_len)
        frame_sets = extract_frames(path, scenes, samples_per_scene)
        for idx, ((s, e), frames) in enumerate(zip(scenes, frame_sets)):
            if not frames:
                continue
            embs = encoder.encode_images(frames)          # (k, dim)
            emb = embs.mean(axis=0)                        # média da cena
            emb = emb / max(np.linalg.norm(emb), 1e-8)
            clips.append(SceneClip(path, idx, float(s), float(e), emb.astype(np.float32)))

    return clips, encoder


def save_scenes(clips: List[SceneClip], out_path: str) -> None:
    np.savez(
        out_path,
        paths=np.array([c.video_path for c in clips]),
        idx=np.array([c.index for c in clips]),
        starts=np.array([c.start for c in clips]),
        ends=np.array([c.end for c in clips]),
        embeddings=np.stack([c.embedding for c in clips]) if clips else np.zeros((0, 512)),
    )


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="STEP 2 — cenas + embeddings CLIP")
    ap.add_argument("videos", nargs="+")
    ap.add_argument("--threshold", type=float, default=27.0)
    ap.add_argument("--samples", type=int, default=2)
    ap.add_argument("--out", "-o", default="vision_brain.npz")
    args = ap.parse_args(argv)

    clips, _ = analyze_videos(args.videos, threshold=args.threshold,
                              samples_per_scene=args.samples)
    save_scenes(clips, args.out)
    print(f"[vision_brain] {len(clips)} cenas embedadas de "
          f"{len(args.videos)} vídeo(s) → {args.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
