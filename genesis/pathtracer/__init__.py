"""Pipeline Gênesis — Etapa 4: Motor de Luz Puro (Mitsuba 3).

Render por path-tracing em Python puro, sem Blender. Importa a malha acoplada,
instancia câmera/luzes e traça o caminho da luz na CPU (LLVM) ou GPU (CUDA).

O import deste subpacote **não** requer ``mitsuba``: ``describe_scene`` e a config
são inspecionáveis com só ``numpy``; o ``mitsuba`` é exigido apenas no render.
"""

from __future__ import annotations

from .engine import (
    DEFAULT_LIGHTS,
    LightSpec,
    MitsubaRenderError,
    MitsubaRenderer,
    RenderConfig,
    configure_logging,
    describe_scene,
    measure_mesh,
    spherical_to_cartesian,
)

__all__ = [
    "MitsubaRenderer",
    "RenderConfig",
    "LightSpec",
    "MitsubaRenderError",
    "DEFAULT_LIGHTS",
    "describe_scene",
    "measure_mesh",
    "spherical_to_cartesian",
    "configure_logging",
]
