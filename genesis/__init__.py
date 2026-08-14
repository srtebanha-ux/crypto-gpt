"""Pipeline Gênesis — Módulo 2: Retopologia Genética (cura de malha).

Este pacote é *autônomo*: nenhum de seus submódulos importa outra parte do
pipeline Gênesis para funcionar. A única dependência obrigatória é ``numpy``.
Bibliotecas pesadas (``scipy``, ``open3d``) são *aceleradores opcionais* — quando
ausentes, o código cai para a implementação pura em ``numpy`` sem quebrar.

Entrada e saída são malhas triângulo em formato Wavefront ``.obj``.
"""

from __future__ import annotations

from .mesh import Mesh, TopologyReport
from .retopology import (
    HealConfig,
    heal,
    laplacian_smooth,
    remove_degenerate_faces,
    remove_duplicate_faces,
    remove_unreferenced_vertices,
    weld_vertices,
)

__all__ = [
    "Mesh",
    "TopologyReport",
    "HealConfig",
    "heal",
    "weld_vertices",
    "remove_degenerate_faces",
    "remove_duplicate_faces",
    "remove_unreferenced_vertices",
    "laplacian_smooth",
]

__version__ = "0.1.0"
