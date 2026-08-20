"""
Testes do motor de matching semântico do NEXUS (Step 3).

Exercita a lógica de vetores (cosine similarity + alinhamento ao BPM) com um
encoder e cenas sintéticos — sem baixar Whisper/CLIP nem exigir MoviePy
(o import de vídeo é lazy). Valida que a letra casa com a cena correta.
"""

import os
import sys

import numpy as np
import pytest

# torna o pacote `nexus/` importável a partir do diretório de testes
NEXUS_DIR = os.path.join(os.path.dirname(os.path.dirname(__file__)), "nexus")
sys.path.insert(0, NEXUS_DIR)

import audio_brain as ab  # noqa: E402
import nexus_editor as nx  # noqa: E402
import vision_brain as vb  # noqa: E402


def _unit(v):
    v = np.array(v, dtype=np.float32)
    return v / np.linalg.norm(v)


class FakeEncoder:
    """Simula o CLIP text encoder mapeando palavras-chave para eixos fixos."""

    def encode_text(self, texts):
        out = []
        for t in texts:
            if "chuva" in t or "caminhando" in t:
                out.append(_unit([1, 0, 0, 0]))
            elif "carro" in t or "cidade" in t:
                out.append(_unit([0, 1, 0, 0]))
            else:
                out.append(_unit([0, 0, 1, 0]))
        return np.stack(out)


@pytest.fixture()
def brain():
    beats = [round(0.5 * i, 3) for i in range(16)]  # 120 BPM, 8s
    phrases = [
        ab.Phrase(0.0, 4.0, "pessoa caminhando na chuva"),
        ab.Phrase(4.0, 8.0, "carro em alta velocidade na cidade"),
    ]
    return ab.AudioBrain("m.mp3", "pt", 8.0, 120.0, beats, [4.0], phrases, [])


@pytest.fixture()
def scenes():
    return [
        vb.SceneClip("rain.mp4", 0, 0.0, 3.0, _unit([1, 0, 0, 0])),
        vb.SceneClip("car.mp4", 1, 0.0, 3.0, _unit([0, 1, 0, 0])),
    ]


def test_cosine_matrix_identity():
    a = _unit([1, 0, 0, 0]).reshape(1, -1)
    b = np.stack([_unit([1, 0, 0, 0]), _unit([0, 1, 0, 0])])
    m = nx.cosine_matrix(a, b)
    assert m.shape == (1, 2)
    assert m[0, 0] == pytest.approx(1.0, abs=1e-5)
    assert m[0, 1] == pytest.approx(0.0, abs=1e-5)


def test_windows_aligned_to_beats(brain):
    w = nx.build_windows(brain, beats_per_cut=4)  # corte a cada 4 batidas = 2s
    assert w[0][0] == 0.0
    assert w[-1][1] == pytest.approx(8.0, abs=0.1)
    durs = [round(b - a, 2) for a, b in w]
    assert all(d > 0.15 for d in durs)


def test_semantic_matching(brain, scenes):
    cuts = nx.match_timeline(brain, scenes, FakeEncoder(), beats_per_cut=4)
    assert len(cuts) >= 2
    first = [c for c in cuts if c.t_end <= 4.0]
    second = [c for c in cuts if c.t_start >= 4.0]
    assert first and second
    assert all(c.video_path == "rain.mp4" for c in first)
    assert all(c.video_path == "car.mp4" for c in second)
    assert all(0.0 <= c.score <= 1.0001 for c in cuts)


def test_cut_durations_match_windows(brain, scenes):
    cuts = nx.match_timeline(brain, scenes, FakeEncoder(), beats_per_cut=2)
    for c in cuts:
        assert c.duration == pytest.approx(c.t_end - c.t_start)
        assert c.src_out - c.src_in <= c.duration + 1e-6


def test_phrase_and_beat_helpers(brain):
    assert brain.phrase_at(1.0).text.startswith("pessoa")
    assert brain.phrase_at(6.0).text.startswith("carro")
    assert brain.nearest_beat(4.03) == pytest.approx(4.0, abs=1e-6)
