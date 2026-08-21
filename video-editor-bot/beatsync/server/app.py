"""
app.py
======

API web do beatsync Studio (FastAPI) + serve o frontend estático.

Rode com:
    beatsync-studio                 # console script
    python -m beatsync.server       # equivalente
    uvicorn beatsync.server.app:app --reload

Endpoints principais (JSON):
    GET    /api/health
    GET    /api/presets
    GET    /api/projects
    POST   /api/projects
    GET    /api/projects/{id}
    PATCH  /api/projects/{id}
    DELETE /api/projects/{id}
    POST   /api/projects/{id}/assets        (multipart: kind, file)
    DELETE /api/projects/{id}/assets/{aid}
    POST   /api/projects/{id}/analyze       (body: {cut_mode?})
    POST   /api/projects/{id}/render
    GET    /api/jobs/{id}
    POST   /api/jobs/{id}/cancel
    GET    /api/jobs/{id}/download
"""

from __future__ import annotations

import json
import os

from contextlib import asynccontextmanager

from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, HTMLResponse
from fastapi.staticfiles import StaticFiles

from .. import db, service

STATIC_DIR = os.path.join(os.path.dirname(__file__), "static")


@asynccontextmanager
async def _lifespan(app: FastAPI):
    db.init_engine()
    os.makedirs(service.STORAGE_ROOT, exist_ok=True)
    yield


app = FastAPI(title="beatsync Studio", version="0.1.0", lifespan=_lifespan)


# --------------------------------------------------------------------------- #
# Frontend
# --------------------------------------------------------------------------- #
@app.get("/", response_class=HTMLResponse)
def index() -> HTMLResponse:
    path = os.path.join(STATIC_DIR, "index.html")
    with open(path, encoding="utf-8") as f:
        return HTMLResponse(f.read())


# --------------------------------------------------------------------------- #
# Health / presets
# --------------------------------------------------------------------------- #
@app.get("/api/health")
def health() -> dict:
    caps = {"librosa": _has("librosa"), "moviepy": _has("moviepy"),
            "whisper": _has("faster_whisper") or _has("whisper"),
            "ffmpeg": _has_ffmpeg()}
    return {"ok": True, "version": app.version, "capabilities": caps}


@app.get("/api/presets")
def presets() -> list:
    order = {"leve": 0, "clean": 1, "hype": 2, "reels": 3, "cinematic": 4}
    with db.get_session() as s:
        items = [p.to_dict() for p in s.query(db.Preset).all()]
    return sorted(items, key=lambda p: order.get(p["name"], 99))


# --------------------------------------------------------------------------- #
# Projetos
# --------------------------------------------------------------------------- #
@app.get("/api/projects")
def projects_list() -> list:
    return service.list_projects()


@app.post("/api/projects")
async def projects_create(request: Request) -> dict:
    body = await _json(request)
    name = (body.get("name") or "").strip()
    if not name:
        raise HTTPException(422, "nome do projeto é obrigatório")
    return service.create_project(
        name=name,
        description=body.get("description", ""),
        preset=body.get("preset", "leve"),
    )


@app.get("/api/projects/{project_id}")
def projects_get(project_id: int) -> dict:
    p = service.get_project(project_id)
    if not p:
        raise HTTPException(404, "projeto não encontrado")
    return p


@app.patch("/api/projects/{project_id}")
async def projects_update(project_id: int, request: Request) -> dict:
    body = await _json(request)
    p = service.update_project(project_id, **body)
    if not p:
        raise HTTPException(404, "projeto não encontrado")
    return p


@app.delete("/api/projects/{project_id}")
def projects_delete(project_id: int) -> dict:
    if not service.delete_project(project_id):
        raise HTTPException(404, "projeto não encontrado")
    return {"deleted": True}


# --------------------------------------------------------------------------- #
# Assets
# --------------------------------------------------------------------------- #
@app.post("/api/projects/{project_id}/assets")
async def asset_upload(
    project_id: int,
    kind: str = Form(...),
    file: UploadFile = File(...),
) -> dict:
    if kind not in ("audio", "video"):
        raise HTTPException(422, "kind deve ser 'audio' ou 'video'")
    try:
        # streaming: grava em disco em pedaços (não carrega o vídeo todo na RAM)
        return service.add_asset_stream(
            project_id, kind, file.filename or "arquivo", file.file)
    except ValueError as exc:
        raise HTTPException(400, str(exc))


@app.delete("/api/projects/{project_id}/assets/{asset_id}")
def asset_delete(project_id: int, asset_id: int) -> dict:
    if not service.delete_asset(project_id, asset_id):
        raise HTTPException(404, "asset não encontrado")
    return {"deleted": True}


# --------------------------------------------------------------------------- #
# Análise + render
# --------------------------------------------------------------------------- #
@app.post("/api/projects/{project_id}/analyze")
async def analyze(project_id: int, request: Request) -> dict:
    body = await _json(request, required=False)
    try:
        return service.analyze_project(project_id, cut_mode=body.get("cut_mode"))
    except ValueError as exc:
        raise HTTPException(400, str(exc))
    except ImportError as exc:
        raise HTTPException(503, str(exc))


@app.post("/api/projects/{project_id}/render")
def render(project_id: int) -> dict:
    try:
        return service.enqueue_render(project_id)
    except ValueError as exc:
        raise HTTPException(400, str(exc))


@app.get("/api/jobs/{job_id}")
def job_get(job_id: int) -> dict:
    j = service.get_job(job_id)
    if not j:
        raise HTTPException(404, "job não encontrado")
    return j


@app.post("/api/jobs/{job_id}/cancel")
def job_cancel(job_id: int) -> dict:
    if not service.cancel_job(job_id):
        raise HTTPException(404, "job não encontrado")
    return {"canceled": True}


@app.get("/api/jobs/{job_id}/download")
def job_download(job_id: int):
    path = service.job_output_path(job_id)
    if not path:
        raise HTTPException(404, "render ainda não disponível")
    return FileResponse(path, media_type="video/mp4",
                        filename=os.path.basename(path))


# --------------------------------------------------------------------------- #
# Helpers
# --------------------------------------------------------------------------- #
async def _json(request: Request, required: bool = True) -> dict:
    try:
        raw = await request.body()
        if not raw:
            if required:
                raise HTTPException(422, "corpo JSON esperado")
            return {}
        return json.loads(raw)
    except json.JSONDecodeError:
        if required:
            raise HTTPException(422, "JSON inválido")
        return {}


def _has(module: str) -> bool:
    import importlib.util
    return importlib.util.find_spec(module) is not None


def _has_ffmpeg() -> bool:
    import shutil
    return shutil.which("ffmpeg") is not None


# monta arquivos estáticos auxiliares (css/js) em /static
if os.path.isdir(STATIC_DIR):
    app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")
