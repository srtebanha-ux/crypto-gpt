"""
Testes de integração do Studio: banco de dados + serviço + API web.

Usa um banco SQLite temporário e um WAV sintético. Não requer MoviePy/FFmpeg
(apenas a etapa de render precisa deles — aqui exercitamos até a análise).
"""

import io
import os

import numpy as np
import pytest

pytest.importorskip("librosa")
pytest.importorskip("fastapi")
pytest.importorskip("sqlalchemy")

import librosa
import soundfile as sf
from fastapi.testclient import TestClient


@pytest.fixture()
def client(tmp_path, monkeypatch):
    # isola DB e storage por teste
    monkeypatch.setenv("DATABASE_URL", f"sqlite:///{tmp_path/'test.db'}")
    monkeypatch.setenv("BEATSYNC_STORAGE", str(tmp_path / "storage"))
    # reinicializa o engine para pegar o novo DATABASE_URL
    import beatsync.db as db
    db._ENGINE = None
    db._SessionLocal = None
    import importlib
    import beatsync.service as service
    importlib.reload(service)
    from beatsync.server.app import app
    with TestClient(app) as c:
        yield c


def _wav_bytes(seconds=6.0, bpm=120.0, sr=22050):
    times = np.arange(0, seconds, 60.0 / bpm)
    y = librosa.clicks(times=times, sr=sr, length=int(sr * seconds))
    buf = io.BytesIO()
    sf.write(buf, y, sr, format="WAV")
    return buf.getvalue()


def test_health_and_presets(client):
    h = client.get("/api/health").json()
    assert h["ok"] is True
    assert "capabilities" in h
    presets = client.get("/api/presets").json()
    names = {p["name"] for p in presets}
    assert {"reels", "cinematic", "hype", "clean"} <= names


def test_project_lifecycle(client):
    # cria
    r = client.post("/api/projects", json={"name": "Meu Clipe", "preset": "hype"})
    assert r.status_code == 200
    pid = r.json()["id"]

    # aparece na listagem
    assert any(p["id"] == pid for p in client.get("/api/projects").json())

    # patch
    r = client.patch(f"/api/projects/{pid}", json={"preset": "reels"})
    assert r.json()["preset"] == "reels"

    # upload de áudio
    files = {"file": ("song.wav", _wav_bytes(), "audio/wav")}
    r = client.post(f"/api/projects/{pid}/assets", data={"kind": "audio"}, files=files)
    assert r.status_code == 200 and r.json()["kind"] == "audio"

    # análise
    r = client.post(f"/api/projects/{pid}/analyze", json={"cut_mode": "beat"})
    assert r.status_code == 200
    an = r.json()
    assert an["num_beats"] >= 8
    assert an["num_cuts"] >= 1
    assert len(an["cuts"]) == an["num_cuts"]

    # projeto agora está 'analyzed' e carrega a análise
    proj = client.get(f"/api/projects/{pid}").json()
    assert proj["status"] == "analyzed"
    assert proj["analysis"]["tempo"] > 0

    # render sem clipes -> erro amigável
    r = client.post(f"/api/projects/{pid}/render")
    assert r.status_code == 400

    # exclui
    assert client.delete(f"/api/projects/{pid}").json()["deleted"] is True
    assert client.get(f"/api/projects/{pid}").status_code == 404


def test_analyze_requires_audio(client):
    pid = client.post("/api/projects", json={"name": "x"}).json()["id"]
    r = client.post(f"/api/projects/{pid}/analyze", json={})
    assert r.status_code == 400  # sem áudio


def test_index_served(client):
    r = client.get("/")
    assert r.status_code == 200
    assert "beatsync" in r.text.lower()
