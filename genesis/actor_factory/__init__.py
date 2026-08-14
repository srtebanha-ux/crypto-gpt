"""Pipeline Gênesis — Fábrica de Atores (ingestão imagem→3D → pipeline).

Normaliza e cura um modelo 3D bruto (saída de geradores imagem→3D como Tripo/
Meshy) para o padrão do pipeline: Z-up, escala real, pé no chão, malha curada.
Núcleo em ``numpy`` (``genesis.mesh``); ``trimesh`` só é preciso para formatos
não-``.obj`` (glTF/PLY/FBX).
"""

from __future__ import annotations

from .ingest import IngestResult, ingest_actor, load_any
from .normalize import (
    convert_up_axis,
    normalize_actor,
    recenter_and_floor,
    scale_to_height,
)

__all__ = [
    "normalize_actor",
    "convert_up_axis",
    "recenter_and_floor",
    "scale_to_height",
    "ingest_actor",
    "load_any",
    "IngestResult",
]
