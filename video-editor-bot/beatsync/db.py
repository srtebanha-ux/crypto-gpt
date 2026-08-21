"""
db.py
=====

Camada de banco de dados do beatsync Studio (SQLAlchemy 2.0).

Schema completo do estúdio:

    projects   1─┬─* assets        (áudio/vídeo enviados)
                 ├─* analyses      (resultados de análise de áudio)
                 └─* render_jobs   (fila/histórico de renderizações)
    presets      (presets de render — os builtin + os criados pelo usuário)

Por padrão usa SQLite em ``beatsync_studio.db`` (override via env DATABASE_URL).
"""

from __future__ import annotations

import enum
import json
import os
from datetime import datetime
from typing import Optional

from sqlalchemy import (
    DateTime,
    Enum as SAEnum,
    Float,
    ForeignKey,
    Integer,
    String,
    Text,
    create_engine,
    func,
)
from sqlalchemy.orm import (
    DeclarativeBase,
    Mapped,
    mapped_column,
    relationship,
    sessionmaker,
)


# --------------------------------------------------------------------------- #
# Enums de estado
# --------------------------------------------------------------------------- #
class AssetKind(str, enum.Enum):
    audio = "audio"
    video = "video"


class ProjectStatus(str, enum.Enum):
    draft = "draft"
    analyzed = "analyzed"
    rendering = "rendering"
    done = "done"
    error = "error"


class JobStatus(str, enum.Enum):
    queued = "queued"
    running = "running"
    done = "done"
    error = "error"
    canceled = "canceled"


# --------------------------------------------------------------------------- #
# Base + mixin de JSON
# --------------------------------------------------------------------------- #
class Base(DeclarativeBase):
    pass


def _now() -> datetime:
    return datetime.utcnow()


# --------------------------------------------------------------------------- #
# Modelos
# --------------------------------------------------------------------------- #
class Project(Base):
    __tablename__ = "projects"

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    description: Mapped[str] = mapped_column(Text, default="")
    status: Mapped[ProjectStatus] = mapped_column(
        SAEnum(ProjectStatus), default=ProjectStatus.draft, index=True
    )
    preset: Mapped[str] = mapped_column(String(50), default="hype")
    config_json: Mapped[str] = mapped_column(Text, default="{}")
    created_at: Mapped[datetime] = mapped_column(DateTime, default=_now)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, default=_now, onupdate=_now
    )

    assets: Mapped[list["Asset"]] = relationship(
        back_populates="project", cascade="all, delete-orphan"
    )
    analyses: Mapped[list["Analysis"]] = relationship(
        back_populates="project", cascade="all, delete-orphan",
        order_by="Analysis.created_at.desc()",
    )
    jobs: Mapped[list["RenderJob"]] = relationship(
        back_populates="project", cascade="all, delete-orphan",
        order_by="RenderJob.created_at.desc()",
    )

    # --- helpers ---------------------------------------------------------- #
    @property
    def config(self) -> dict:
        try:
            return json.loads(self.config_json or "{}")
        except json.JSONDecodeError:
            return {}

    @config.setter
    def config(self, value: dict) -> None:
        self.config_json = json.dumps(value or {})

    def audio_asset(self) -> Optional["Asset"]:
        for a in self.assets:
            if a.kind == AssetKind.audio:
                return a
        return None

    def video_assets(self) -> list["Asset"]:
        return [a for a in self.assets if a.kind == AssetKind.video]

    def latest_analysis(self) -> Optional["Analysis"]:
        return self.analyses[0] if self.analyses else None

    def to_dict(self, deep: bool = False) -> dict:
        d = {
            "id": self.id,
            "name": self.name,
            "description": self.description,
            "status": self.status.value,
            "preset": self.preset,
            "config": self.config,
            "created_at": self.created_at.isoformat(),
            "updated_at": self.updated_at.isoformat(),
            "counts": {
                "audio": 1 if self.audio_asset() else 0,
                "video": len(self.video_assets()),
                "jobs": len(self.jobs),
            },
        }
        if deep:
            d["assets"] = [a.to_dict() for a in self.assets]
            an = self.latest_analysis()
            d["analysis"] = an.to_dict() if an else None
            d["jobs"] = [j.to_dict() for j in self.jobs]
        return d


class Asset(Base):
    __tablename__ = "assets"

    id: Mapped[int] = mapped_column(primary_key=True)
    project_id: Mapped[int] = mapped_column(
        ForeignKey("projects.id", ondelete="CASCADE"), index=True
    )
    kind: Mapped[AssetKind] = mapped_column(SAEnum(AssetKind), index=True)
    filename: Mapped[str] = mapped_column(String(300))
    path: Mapped[str] = mapped_column(String(600))
    size_bytes: Mapped[int] = mapped_column(Integer, default=0)
    duration: Mapped[float] = mapped_column(Float, default=0.0)
    width: Mapped[int] = mapped_column(Integer, default=0)
    height: Mapped[int] = mapped_column(Integer, default=0)
    fps: Mapped[float] = mapped_column(Float, default=0.0)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=_now)

    project: Mapped["Project"] = relationship(back_populates="assets")

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "kind": self.kind.value,
            "filename": self.filename,
            "size_bytes": self.size_bytes,
            "duration": round(self.duration, 3),
            "width": self.width,
            "height": self.height,
            "fps": round(self.fps, 3),
            "created_at": self.created_at.isoformat(),
        }


class Analysis(Base):
    __tablename__ = "analyses"

    id: Mapped[int] = mapped_column(primary_key=True)
    project_id: Mapped[int] = mapped_column(
        ForeignKey("projects.id", ondelete="CASCADE"), index=True
    )
    tempo: Mapped[float] = mapped_column(Float, default=0.0)
    duration: Mapped[float] = mapped_column(Float, default=0.0)
    cut_mode: Mapped[str] = mapped_column(String(20), default="hybrid")
    num_beats: Mapped[int] = mapped_column(Integer, default=0)
    num_cuts: Mapped[int] = mapped_column(Integer, default=0)
    beats_json: Mapped[str] = mapped_column(Text, default="[]")
    downbeats_json: Mapped[str] = mapped_column(Text, default="[]")
    onsets_json: Mapped[str] = mapped_column(Text, default="[]")
    cuts_json: Mapped[str] = mapped_column(Text, default="[]")
    created_at: Mapped[datetime] = mapped_column(DateTime, default=_now)

    project: Mapped["Project"] = relationship(back_populates="analyses")

    def _load(self, field: str) -> list:
        try:
            return json.loads(getattr(self, field) or "[]")
        except json.JSONDecodeError:
            return []

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "tempo": round(self.tempo, 2),
            "duration": round(self.duration, 3),
            "cut_mode": self.cut_mode,
            "num_beats": self.num_beats,
            "num_cuts": self.num_cuts,
            "beats": self._load("beats_json"),
            "downbeats": self._load("downbeats_json"),
            "onsets": self._load("onsets_json"),
            "cuts": self._load("cuts_json"),
            "created_at": self.created_at.isoformat(),
        }


class RenderJob(Base):
    __tablename__ = "render_jobs"

    id: Mapped[int] = mapped_column(primary_key=True)
    project_id: Mapped[int] = mapped_column(
        ForeignKey("projects.id", ondelete="CASCADE"), index=True
    )
    status: Mapped[JobStatus] = mapped_column(
        SAEnum(JobStatus), default=JobStatus.queued, index=True
    )
    progress: Mapped[float] = mapped_column(Float, default=0.0)  # 0..100
    stage: Mapped[str] = mapped_column(String(60), default="na fila")
    config_json: Mapped[str] = mapped_column(Text, default="{}")
    output_path: Mapped[str] = mapped_column(String(600), default="")
    num_cuts: Mapped[int] = mapped_column(Integer, default=0)
    log: Mapped[str] = mapped_column(Text, default="")
    error: Mapped[str] = mapped_column(Text, default="")
    created_at: Mapped[datetime] = mapped_column(DateTime, default=_now)
    started_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    finished_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)

    project: Mapped["Project"] = relationship(back_populates="jobs")

    @property
    def config(self) -> dict:
        try:
            return json.loads(self.config_json or "{}")
        except json.JSONDecodeError:
            return {}

    def append_log(self, line: str) -> None:
        self.log = (self.log or "") + line.rstrip() + "\n"

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "project_id": self.project_id,
            "status": self.status.value,
            "progress": round(self.progress, 1),
            "stage": self.stage,
            "num_cuts": self.num_cuts,
            "output": bool(self.output_path),
            "error": self.error,
            "log": self.log,
            "created_at": self.created_at.isoformat(),
            "started_at": self.started_at.isoformat() if self.started_at else None,
            "finished_at": self.finished_at.isoformat() if self.finished_at else None,
        }


class Preset(Base):
    __tablename__ = "presets"

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(50), unique=True, index=True)
    label: Mapped[str] = mapped_column(String(80), default="")
    description: Mapped[str] = mapped_column(Text, default="")
    config_json: Mapped[str] = mapped_column(Text, default="{}")
    builtin: Mapped[bool] = mapped_column(default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=_now)

    def to_dict(self) -> dict:
        try:
            cfg = json.loads(self.config_json or "{}")
        except json.JSONDecodeError:
            cfg = {}
        return {
            "name": self.name,
            "label": self.label,
            "description": self.description,
            "config": cfg,
            "builtin": self.builtin,
        }


# --------------------------------------------------------------------------- #
# Engine / sessão / bootstrap
# --------------------------------------------------------------------------- #
_ENGINE = None
_SessionLocal = None


def _database_url() -> str:
    return os.environ.get(
        "DATABASE_URL",
        f"sqlite:///{os.path.join(os.getcwd(), 'beatsync_studio.db')}",
    )


def init_engine(url: Optional[str] = None):
    """Cria (uma vez) o engine e o sessionmaker, e garante as tabelas."""
    global _ENGINE, _SessionLocal
    if _ENGINE is not None:
        return _ENGINE
    url = url or _database_url()
    connect_args = {"check_same_thread": False} if url.startswith("sqlite") else {}
    _ENGINE = create_engine(url, echo=False, future=True, connect_args=connect_args)
    _SessionLocal = sessionmaker(bind=_ENGINE, expire_on_commit=False, future=True)
    Base.metadata.create_all(_ENGINE)
    _seed_presets()
    return _ENGINE


def get_session():
    """Abre uma nova sessão (o chamador é responsável por fechar)."""
    if _SessionLocal is None:
        init_engine()
    return _SessionLocal()


def _seed_presets() -> None:
    """Popula a tabela de presets a partir dos presets builtin do beatsync."""
    from dataclasses import asdict
    from .config import PRESETS

    labels = {
        "leve": ("⚡ Leve (recomendado p/ notebook)",
                 "720p, encoding rápido, pouco processador — não trava o Mac."),
        "reels": ("Reels / Vertical", "Vertical 9:16, corte em cada batida — redes sociais."),
        "cinematic": ("Cinemático", "16:9 24fps, cortes por compasso + crossfade suave."),
        "hype": ("Hype", "Híbrido agressivo: downbeats + picos, meias-batidas, speed-ramp."),
        "clean": ("Clean", "Corte por batida com crossfade curto — limpo e elegante."),
    }
    with get_session() as s:
        existing = {p.name for p in s.query(Preset).all()}
        changed = False
        for name, cfg in PRESETS.items():
            if name in existing:
                continue
            label, desc = labels.get(name, (name.title(), ""))
            s.add(Preset(
                name=name,
                label=label,
                description=desc,
                config_json=json.dumps(asdict(cfg)),
                builtin=True,
            ))
            changed = True
        if changed:
            s.commit()
