"""Normalização de ator — deixa uma malha bruta de IA pronta para o pipeline.

Modelos vindos de geradores imagem→3D (Tripo, Meshy, etc.) chegam com escala,
orientação e posição **arbitrárias** — quase sempre **Y-up** (convenção glTF),
fora de escala e flutuando longe da origem. Antes de rig/acoplamento/render eles
precisam ser postos na convenção do nosso pipeline:

* **Z-up** (nosso mundo tem +Z para cima);
* **pé no chão** (mínimo em Z = 0);
* **centralizado** em X/Y na origem;
* **escala real** (altura-alvo em metros).

Tudo em ``numpy`` puro sobre ``genesis.mesh.Mesh`` — testável sem dependências.
"""

from __future__ import annotations

import numpy as np

from ..mesh import Mesh

# Mapa de conversão de eixo "para cima": leva o up de origem ao +Z destro.
# Y-up → Z-up: (x, y, z) → (x, -z, y). Preserva a quiralidade (destro).
_UP_TO_Z = {
    "y": np.array([[1, 0, 0], [0, 0, -1], [0, 1, 0]], dtype=np.float64),
    "z": np.eye(3, dtype=np.float64),
    "-z": np.array([[1, 0, 0], [0, 1, 0], [0, 0, -1]], dtype=np.float64),
}


def convert_up_axis(mesh: Mesh, from_up: str = "y") -> Mesh:
    """Rotaciona a malha para que o eixo ``from_up`` vire +Z (nosso up)."""
    key = from_up.lower()
    if key not in _UP_TO_Z:
        raise ValueError(f"from_up inválido: {from_up} (use 'y', 'z' ou '-z')")
    R = _UP_TO_Z[key]
    return Mesh(mesh.vertices @ R.T, mesh.faces.copy())


def recenter_and_floor(mesh: Mesh) -> Mesh:
    """Centraliza em X/Y na origem e apoia o pé em Z=0 (mínimo em Z → 0)."""
    v = mesh.vertices
    lo = v.min(axis=0)
    hi = v.max(axis=0)
    offset = np.array([
        (lo[0] + hi[0]) / 2.0,   # centro em X
        (lo[1] + hi[1]) / 2.0,   # centro em Y
        lo[2],                   # base em Z
    ])
    return Mesh(v - offset, mesh.faces.copy())


def scale_to_height(mesh: Mesh, target_height: float, axis: int = 2) -> Mesh:
    """Escala uniformemente para que a extensão em ``axis`` seja ``target_height``."""
    v = mesh.vertices
    current = float(v[:, axis].max() - v[:, axis].min())
    if current <= 1e-12:
        raise ValueError("altura atual ~0; não dá para escalar")
    factor = target_height / current
    return Mesh(v * factor, mesh.faces.copy())


def normalize_actor(
    mesh: Mesh,
    from_up: str = "y",
    target_height: float = 1.8,
) -> Mesh:
    """Pipeline de normalização: Z-up → escala → centraliza/apoia no chão.

    Ordem importa: converte o eixo antes de medir a altura (para medir na
    vertical correta) e centraliza por último (a escala muda as coordenadas).
    """
    m = convert_up_axis(mesh, from_up=from_up)
    m = scale_to_height(m, target_height, axis=2)
    m = recenter_and_floor(m)
    return m
