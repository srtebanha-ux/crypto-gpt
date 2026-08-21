"""
Teste do renderizador leve (FFmpeg segmento-a-segmento).

Gera clipes e áudio sintéticos com o próprio FFmpeg (via imageio-ffmpeg, que
acompanha o MoviePy), renderiza e valida que sai um MP4 com a duração esperada
(soma dos slots) — provando o corte no ritmo e o padding de fontes curtas.
"""

import os
import subprocess

import numpy as np
import pytest

pytest.importorskip("soundfile")
import soundfile as sf  # noqa: E402


def _ffmpeg():
    try:
        import imageio_ffmpeg
        return imageio_ffmpeg.get_ffmpeg_exe()
    except Exception:
        import shutil
        return shutil.which("ffmpeg")


FF = _ffmpeg()
pytestmark = pytest.mark.skipif(FF is None, reason="FFmpeg indisponível")


@pytest.fixture()
def media(tmp_path, monkeypatch):
    monkeypatch.setenv("BEATSYNC_FFMPEG", FF)  # garante que o util ache o binário
    a = tmp_path / "a.mp4"
    b = tmp_path / "b.mp4"
    song = tmp_path / "song.wav"
    subprocess.run([FF, "-y", "-f", "lavfi", "-i",
                    "testsrc=size=320x240:rate=30:duration=6",
                    "-pix_fmt", "yuv420p", str(a)], check=True, capture_output=True)
    subprocess.run([FF, "-y", "-f", "lavfi", "-i",
                    "testsrc2=size=320x240:rate=30:duration=6",
                    "-pix_fmt", "yuv420p", str(b)], check=True, capture_output=True)
    sr = 22050
    y = 0.2 * np.sin(2 * np.pi * 220 * np.arange(sr * 5) / sr)
    sf.write(str(song), y, sr)
    return str(a), str(b), str(song)


def _duration(path):
    import json
    out = subprocess.run(
        [FF, "-y", "-i", path, "-f", "null", "-"],
        capture_output=True, text=True).stderr
    # extrai "Duration: HH:MM:SS.xx"
    import re
    m = re.search(r"Duration: (\d+):(\d+):(\d+\.\d+)", out)
    if not m:
        return None
    h, mm, ss = m.groups()
    return int(h) * 3600 + int(mm) * 60 + float(ss)


def test_lite_render_produces_valid_mp4(media, tmp_path):
    a, b, song = media
    # limpa o cache do localizador para pegar o BEATSYNC_FFMPEG do monkeypatch
    from beatsync import ffmpeg_util
    ffmpeg_util.ffmpeg_exe.cache_clear()

    from beatsync import render_ffmpeg as rf
    cuts = [
        rf.Cut(a, 0.0, 0.5, avail=6.0),
        rf.Cut(b, 1.0, 0.5, avail=6.0),
        rf.Cut(a, 2.0, 0.4, avail=6.0),
        rf.Cut(b, 0.5, 1.0, avail=0.6),  # slot > fonte → exige padding
    ]
    total = sum(c.duration for c in cuts)  # 2.4s

    out = tmp_path / "out.mp4"
    progress = []
    rf.render(cuts, song, str(out), width=640, height=360, fps=30,
              threads=1, on_progress=lambda p: progress.append(p))

    assert out.exists() and out.stat().st_size > 0
    assert progress and progress[-1] == 100.0
    dur = _duration(str(out))
    assert dur is not None
    assert abs(dur - total) < 0.35  # duração ≈ soma dos slots (corte no ritmo)


def test_cuts_from_timeline_maps_durations():
    from beatsync import render_ffmpeg as rf
    from dataclasses import dataclass

    @dataclass
    class E:
        src_path: str
        src_in: float
        src_out: float
        t_start: float
        t_end: float

    tl = [E("x.mp4", 1.0, 3.0, 0.0, 0.5), E("y.mp4", 0.0, 0.2, 0.5, 1.0)]
    cuts = rf.cuts_from_timeline(tl)
    assert [round(c.duration, 2) for c in cuts] == [0.5, 0.5]
    assert [round(c.avail, 2) for c in cuts] == [2.0, 0.2]
    assert cuts[0].src_in == 1.0
