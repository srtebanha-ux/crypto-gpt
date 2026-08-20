"""
service.py
==========

Regras de negócio do Studio: liga o banco de dados (db.py) ao motor de
edição (editor.py / audio.py). Não conhece HTTP — é reutilizável por qualquer
frontend (web, desktop, testes).

Responsabilidades:
  * armazenamento de mídia enviada (áudio/vídeo) no disco + registro no DB
  * análise de áudio + persistência do plano de cortes
  * enfileiramento e execução (em background) de jobs de render, com progresso
"""

from __future__ import annotations

import json
import os
import threading
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
from typing import Optional

from . import db
from .config import RenderConfig
from .db import (
    Analysis,
    Asset,
    AssetKind,
    JobStatus,
    Project,
    ProjectStatus,
    RenderJob,
)

# diretório raiz onde a mídia e os renders são gravados
STORAGE_ROOT = os.environ.get(
    "BEATSYNC_STORAGE", os.path.join(os.getcwd(), "beatsync_data")
)

_EXECUTOR = ThreadPoolExecutor(max_workers=int(os.environ.get("BEATSYNC_WORKERS", "1")))
_CANCEL = set()  # ids de jobs marcados para cancelamento


# --------------------------------------------------------------------------- #
# Utilidades de armazenamento
# --------------------------------------------------------------------------- #
def project_dir(project_id: int) -> str:
    d = os.path.join(STORAGE_ROOT, f"project_{project_id}")
    os.makedirs(os.path.join(d, "clips"), exist_ok=True)
    os.makedirs(os.path.join(d, "renders"), exist_ok=True)
    return d


def _config_from_project(p: Project) -> RenderConfig:
    """Monta o RenderConfig a partir do preset + overrides salvos no projeto."""
    from .config import get_preset
    try:
        cfg = get_preset(p.preset)
    except KeyError:
        cfg = RenderConfig()
    for k, v in (p.config or {}).items():
        if hasattr(cfg, k) and v is not None:
            setattr(cfg, k, v)
    return cfg


# --------------------------------------------------------------------------- #
# Projetos
# --------------------------------------------------------------------------- #
def create_project(name: str, description: str = "", preset: str = "hype") -> dict:
    with db.get_session() as s:
        p = Project(name=name.strip() or "Sem título",
                    description=description, preset=preset)
        s.add(p)
        s.commit()
        project_dir(p.id)
        return p.to_dict(deep=True)


def list_projects() -> list:
    with db.get_session() as s:
        return [p.to_dict() for p in
                s.query(Project).order_by(Project.updated_at.desc()).all()]


def get_project(project_id: int) -> Optional[dict]:
    with db.get_session() as s:
        p = s.get(Project, project_id)
        return p.to_dict(deep=True) if p else None


def update_project(project_id: int, **fields) -> Optional[dict]:
    with db.get_session() as s:
        p = s.get(Project, project_id)
        if not p:
            return None
        for key in ("name", "description", "preset"):
            if key in fields and fields[key] is not None:
                setattr(p, key, fields[key])
        if "config" in fields and fields["config"] is not None:
            p.config = fields["config"]
        s.commit()
        return p.to_dict(deep=True)


def delete_project(project_id: int) -> bool:
    with db.get_session() as s:
        p = s.get(Project, project_id)
        if not p:
            return False
        s.delete(p)
        s.commit()
    import shutil
    shutil.rmtree(project_dir(project_id), ignore_errors=True)
    return True


# --------------------------------------------------------------------------- #
# Assets (upload)
# --------------------------------------------------------------------------- #
def add_asset(project_id: int, kind: str, filename: str, data: bytes) -> dict:
    kind_enum = AssetKind(kind)
    d = project_dir(project_id)
    safe = os.path.basename(filename).replace("/", "_")
    if kind_enum == AssetKind.audio:
        dest = os.path.join(d, safe)
    else:
        dest = os.path.join(d, "clips", safe)
    with open(dest, "wb") as f:
        f.write(data)

    duration = width = height = 0
    fps = 0.0
    try:
        from . import video as vid
        if kind_enum == AssetKind.video:
            probe = vid.probe_clip(dest)
            if probe:
                duration, width, height, fps = (
                    probe.duration, probe.width, probe.height, probe.fps)
    except Exception:
        pass

    with db.get_session() as s:
        p = s.get(Project, project_id)
        if not p:
            raise ValueError("projeto inexistente")
        # substitui o áudio existente (só um por projeto)
        if kind_enum == AssetKind.audio:
            for a in list(p.assets):
                if a.kind == AssetKind.audio:
                    _safe_remove(a.path)
                    s.delete(a)
        asset = Asset(project_id=project_id, kind=kind_enum, filename=safe,
                      path=dest, size_bytes=len(data), duration=duration,
                      width=width, height=height, fps=fps)
        s.add(asset)
        p.status = ProjectStatus.draft
        s.commit()
        return asset.to_dict()


def delete_asset(project_id: int, asset_id: int) -> bool:
    with db.get_session() as s:
        a = s.get(Asset, asset_id)
        if not a or a.project_id != project_id:
            return False
        _safe_remove(a.path)
        s.delete(a)
        s.commit()
    return True


def _safe_remove(path: str) -> None:
    try:
        if path and os.path.exists(path):
            os.remove(path)
    except OSError:
        pass


# --------------------------------------------------------------------------- #
# Análise de áudio
# --------------------------------------------------------------------------- #
def analyze_project(project_id: int, cut_mode: Optional[str] = None,
                    max_points: int = 2000) -> dict:
    """Roda a análise de áudio e persiste o plano de cortes."""
    from .audio import analyze_audio

    with db.get_session() as s:
        p = s.get(Project, project_id)
        if not p:
            raise ValueError("projeto inexistente")
        audio = p.audio_asset()
        if not audio:
            raise ValueError("nenhum áudio enviado para este projeto")
        cfg = _config_from_project(p)
        mode = cut_mode or cfg.cut_mode
        audio_path = audio.path

    a = analyze_audio(audio_path)
    cuts = a.cut_points(mode=mode, subdivision=cfg.subdivision,
                        min_gap=max(cfg.min_gap, cfg.min_cut * 0.6))

    def clip(arr):
        arr = [round(float(x), 3) for x in arr]
        return arr[:max_points]

    with db.get_session() as s:
        p = s.get(Project, project_id)
        an = Analysis(
            project_id=project_id,
            tempo=float(a.tempo),
            duration=float(a.duration),
            cut_mode=mode,
            num_beats=int(a.beats.size),
            num_cuts=int(cuts.size),
            beats_json=json.dumps(clip(a.beats)),
            downbeats_json=json.dumps(clip(a.downbeats)),
            onsets_json=json.dumps(clip(a.onsets)),
            cuts_json=json.dumps(clip(cuts)),
        )
        s.add(an)
        if p.status in (ProjectStatus.draft, ProjectStatus.error):
            p.status = ProjectStatus.analyzed
        s.commit()
        return an.to_dict()


# --------------------------------------------------------------------------- #
# Render jobs
# --------------------------------------------------------------------------- #
def enqueue_render(project_id: int) -> dict:
    with db.get_session() as s:
        p = s.get(Project, project_id)
        if not p:
            raise ValueError("projeto inexistente")
        if not p.audio_asset():
            raise ValueError("envie um áudio antes de renderizar")
        if not p.video_assets():
            raise ValueError("envie ao menos um clipe de vídeo")
        cfg = _config_from_project(p)
        job = RenderJob(project_id=project_id, status=JobStatus.queued,
                        config_json=json.dumps(_cfg_to_dict(cfg)))
        s.add(job)
        p.status = ProjectStatus.rendering
        s.commit()
        job_id = job.id

    _EXECUTOR.submit(_run_render, job_id)
    return get_job(job_id)


def get_job(job_id: int) -> Optional[dict]:
    with db.get_session() as s:
        j = s.get(RenderJob, job_id)
        return j.to_dict() if j else None


def cancel_job(job_id: int) -> bool:
    _CANCEL.add(job_id)
    with db.get_session() as s:
        j = s.get(RenderJob, job_id)
        if not j:
            return False
        if j.status == JobStatus.queued:
            j.status = JobStatus.canceled
            j.finished_at = datetime.utcnow()
            s.commit()
        return True


def job_output_path(job_id: int) -> Optional[str]:
    with db.get_session() as s:
        j = s.get(RenderJob, job_id)
        if j and j.output_path and os.path.exists(j.output_path):
            return j.output_path
    return None


def _cfg_to_dict(cfg: RenderConfig) -> dict:
    from dataclasses import asdict
    return asdict(cfg)


def _set_job(job_id: int, **fields):
    with db.get_session() as s:
        j = s.get(RenderJob, job_id)
        if not j:
            return
        log_line = fields.pop("log_line", None)
        for k, v in fields.items():
            setattr(j, k, v)
        if log_line:
            j.append_log(log_line)
        s.commit()


def _run_render(job_id: int) -> None:
    """Executa um job de render (thread do executor)."""
    if job_id in _CANCEL:
        _CANCEL.discard(job_id)
        return
    try:
        from .editor import VideoEditor
    except ImportError as exc:
        _set_job(job_id, status=JobStatus.error, error=str(exc),
                 finished_at=datetime.utcnow(), log_line=f"ERRO: {exc}")
        _mark_project(job_id, ProjectStatus.error)
        return

    with db.get_session() as s:
        j = s.get(RenderJob, job_id)
        if not j:
            return
        project_id = j.project_id
        cfg_dict = j.config
        p = s.get(Project, project_id)
        audio = p.audio_asset()
        audio_path = audio.path if audio else None
        clips_dir = os.path.join(project_dir(project_id), "clips")
        out_path = os.path.join(
            project_dir(project_id), "renders", f"render_{job_id}.mp4")

    if not audio_path:
        _set_job(job_id, status=JobStatus.error, error="áudio ausente",
                 finished_at=datetime.utcnow())
        return

    cfg = RenderConfig(**{k: v for k, v in cfg_dict.items()
                          if k in RenderConfig.__dataclass_fields__})

    _set_job(job_id, status=JobStatus.running, stage="analisando áudio",
             progress=5.0, started_at=datetime.utcnow(),
             log_line="iniciando render")

    def log(msg: str):
        _set_job(job_id, log_line=msg)

    try:
        editor = VideoEditor(audio_path, clips_dir, cfg, log=log)
        editor.analyze()
        if job_id in _CANCEL:
            return _finish_canceled(job_id)
        _set_job(job_id, stage="definindo cortes", progress=20.0)
        editor.resolve_cut_points()

        _set_job(job_id, stage="montando timeline", progress=35.0)
        timeline = editor.build_timeline()
        _set_job(job_id, num_cuts=len(timeline))
        if job_id in _CANCEL:
            return _finish_canceled(job_id)

        _set_job(job_id, stage="renderizando vídeo", progress=45.0)
        logger = _make_progress_logger(job_id, floor=45.0, ceil=97.0)
        editor.render(out_path, logger=logger)  # render usa MoviePy internamente
        # progresso final
        _set_job(job_id, status=JobStatus.done, stage="concluído",
                 progress=100.0, output_path=out_path,
                 finished_at=datetime.utcnow(), log_line=f"pronto: {out_path}")
        _mark_project(job_id, ProjectStatus.done)
    except Exception as exc:  # noqa: BLE001 — reporta qualquer falha ao usuário
        import traceback
        _set_job(job_id, status=JobStatus.error, error=str(exc),
                 finished_at=datetime.utcnow(),
                 log_line="ERRO:\n" + traceback.format_exc())
        _mark_project(job_id, ProjectStatus.error)
    finally:
        _CANCEL.discard(job_id)


def _finish_canceled(job_id: int):
    _set_job(job_id, status=JobStatus.canceled, stage="cancelado",
             finished_at=datetime.utcnow(), log_line="cancelado pelo usuário")
    _mark_project(job_id, ProjectStatus.analyzed)
    _CANCEL.discard(job_id)


def _mark_project(job_id: int, status: ProjectStatus):
    with db.get_session() as s:
        j = s.get(RenderJob, job_id)
        if not j:
            return
        p = s.get(Project, j.project_id)
        if p:
            p.status = status
            s.commit()


def _make_progress_logger(job_id: int, floor: float, ceil: float):
    """
    Logger opcional para MoviePy (proglog) que mapeia a barra de escrita do
    vídeo para o intervalo [floor, ceil] de progresso do job. Se proglog não
    estiver disponível, retorna None (o progresso fica só nos estágios).
    """
    try:
        from proglog import ProgressBarLogger
    except Exception:
        return None

    class _Logger(ProgressBarLogger):
        def bars_callback(self, bar, attr, value, old_value=None):
            try:
                total = self.bars[bar]["total"] or 1
                frac = min(max(value / total, 0.0), 1.0)
                pct = floor + (ceil - floor) * frac
                _set_job(job_id, progress=round(pct, 1))
            except Exception:
                pass

    return _Logger()
