"""
Testes do núcleo de análise de áudio e da lógica de cortes.

Gera um sinal sintético com batidas conhecidas (clicks a um BPM fixo) e
verifica que o pipeline detecta o tempo e produz pontos de corte coerentes.
Não requer FFmpeg nem arquivos externos.
"""

import numpy as np
import pytest

librosa = pytest.importorskip("librosa")

from beatsync.audio import analyze_audio, AudioAnalysis, _normalize, _estimate_downbeats


@pytest.fixture(scope="module")
def click_wav(tmp_path_factory):
    """Cria um WAV de 8s com clicks a 120 BPM (2 batidas por segundo)."""
    sr = 22050
    bpm = 120.0
    duration = 8.0
    times = np.arange(0, duration, 60.0 / bpm)
    y = librosa.clicks(times=times, sr=sr, click_duration=0.05,
                       length=int(sr * duration))
    # adiciona um tom grave pulsante para dar energia às batidas
    t = np.arange(len(y)) / sr
    y = y + 0.2 * np.sin(2 * np.pi * 80 * t) * (librosa.clicks(
        times=times, sr=sr, click_duration=0.1, length=len(y)) > 0)

    import soundfile as sf
    path = tmp_path_factory.mktemp("audio") / "clicks.wav"
    sf.write(str(path), y, sr)
    return str(path), bpm, duration, times


def test_analyze_detects_tempo(click_wav):
    path, bpm, duration, times = click_wav
    a = analyze_audio(path)
    assert isinstance(a, AudioAnalysis)
    # tempo detectado dentro de 8% (ou múltiplo/submúltiplo comum)
    ratios = [a.tempo / bpm, a.tempo / (bpm / 2), a.tempo / (bpm * 2)]
    assert any(abs(r - 1.0) < 0.08 for r in ratios), f"tempo={a.tempo}"
    assert abs(a.duration - duration) < 0.2
    assert a.beats.size >= 8


def test_cut_points_respect_min_gap(click_wav):
    path, *_ = click_wav
    a = analyze_audio(path)
    pts = a.cut_points(mode="beat", min_gap=0.3)
    diffs = np.diff(pts)
    assert np.all(diffs >= 0.3 - 1e-6)


def test_segments_cover_full_duration(click_wav):
    path, _, duration, _ = click_wav
    a = analyze_audio(path)
    segs = a.segments()
    assert segs[0][0] == 0.0
    assert abs(segs[-1][1] - duration) < 0.2
    # segmentos contíguos e crescentes
    for (a0, a1), (b0, b1) in zip(segs, segs[1:]):
        assert a1 <= b0 + 1e-6
        assert a1 > a0


def test_subdivision_increases_density(click_wav):
    path, *_ = click_wav
    a = analyze_audio(path)
    base = a.cut_points(mode="beat", subdivision=1, min_gap=0.0)
    dense = a.cut_points(mode="beat", subdivision=2, min_gap=0.0)
    assert dense.size >= base.size


def test_normalize_bounds():
    x = np.array([2.0, 4.0, 6.0])
    n = _normalize(x)
    assert n.min() == 0.0 and n.max() == 1.0
    assert _normalize(np.array([])).size == 0
    assert np.all(_normalize(np.array([5.0, 5.0])) == 0.0)


def test_downbeats_are_subset_of_beats(click_wav):
    path, *_ = click_wav
    a = analyze_audio(path)
    db = _estimate_downbeats(a.beats, a.beat_strength, beats_per_bar=4)
    assert db.size <= a.beats.size
    assert np.all(np.isin(db, a.beats))
