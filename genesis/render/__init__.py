"""Pipeline Gênesis — Módulo 5: O Motor Fantasma (Renderizador Headless).

Renderiza os membros da MoonSilver via ``bpy`` importado como biblioteca (100%
headless), no Cycles com backend **Metal** (Apple Silicon — nunca CUDA/OptiX).

O import deste subpacote **não** requer ``bpy``: a dependência só é exigida no
momento do render, permitindo importar/inspecionar a configuração em qualquer
Python. Ver ``headless_engine.HeadlessRenderEngine``.
"""

from __future__ import annotations

from .headless_engine import (
    DEFAULT_THREE_POINT,
    HeadlessRenderEngine,
    LightSpec,
    RenderConfig,
    RenderEngineError,
    configure_logging,
)

__all__ = [
    "HeadlessRenderEngine",
    "RenderConfig",
    "LightSpec",
    "RenderEngineError",
    "DEFAULT_THREE_POINT",
    "configure_logging",
]
