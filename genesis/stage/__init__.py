"""Pipeline Gênesis — Cenário procedural (palco de show).

Constrói um palco completo em ``bpy`` (piso, backdrop, treliça de spots com mira
calculada, contraluz e névoa volumétrica) e renderiza pelo motor do Módulo 5.

A matemática de posicionamento (``truss_spot_positions``, ``rim_positions``,
``aim_directions``) é pura e importável sem ``bpy``; a montagem via ``StageBuilder``
exige o Blender.
"""

from __future__ import annotations

from .stage import (
    WARM_STAGE_PALETTE,
    StageBuilder,
    StageConfig,
    aim_directions,
    rim_positions,
    truss_spot_positions,
)

__all__ = [
    "StageConfig",
    "StageBuilder",
    "truss_spot_positions",
    "rim_positions",
    "aim_directions",
    "WARM_STAGE_PALETTE",
]
