"""Acoplador Matemático — "parenting" de props por álgebra de matrizes.

Sem Blender, sem ``bpy``. Cola um prop (ex.: a guitarra) na mão do personagem
aplicando uma **transformação afim 4×4** (rotação por quatérnion + translação +
escala) aos vértices do prop, e então **concatena** as duas malhas num único
``.obj`` — dois componentes conexos intactos, prontos para o render (Mitsuba 3).

Por que concatenação e não união booleana (CSG): a booleana funde volumes e
destrói geometria na zona de interseção (a mão "comeria" o braço da guitarra).
Para acoplar um prop rígido, a operação correta é a concatenação preservando
ambas as malhas.

A matriz afim segue a convenção de coluna homogênea:

    ┌       ┐   ┌            ┐ ┌   ┐
    │ x' y' │   │ s·R   | t  │ │ x │
    │ z' 1  │ = │ 0 0 0 | 1  │ │ y │   ⇒   p' = s·R·p + t
    └       ┘   └            ┘ │ z │
                               │ 1 │
                               └   ┘

O ponto de **empunhadura** (grip) do prop — uma coordenada no espaço local da
guitarra, tipicamente onde a mão agarra o braço — é ancorado exatamente na
posição da mão: ``t = hand_pos − s·R·grip``.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

import numpy as np
from numpy.typing import NDArray

from ..mesh import Mesh
from ..rig.quaternion import quat_normalize, quat_rotate

Array = NDArray[np.float64]
Vec3 = tuple[float, float, float]


# --------------------------------------------------------- álgebra afim (pura)
def quat_to_matrix(quat: Array) -> Array:
    """Matriz de rotação 3×3 a partir de um quatérnion unitário.

    Colunas = imagens dos eixos canônicos sob a rotação, computadas com a mesma
    rotação de vetores do Módulo 3 (``q ⊗ (0,e_i) ⊗ q*``). Garante coerência com
    o resto da engine.
    """
    q = quat_normalize(np.asarray(quat, dtype=np.float64))
    basis = np.eye(3, dtype=np.float64)
    # quat_rotate faz broadcast: aplica q às 3 linhas (eixos) de uma vez.
    rotated = quat_rotate(np.broadcast_to(q, (3, 4)), basis)  # (3,3), linha i = R·e_i
    return rotated.T  # coluna i = R·e_i


def affine_matrix(
    translation: Array = (0.0, 0.0, 0.0),
    quat: Array = (1.0, 0.0, 0.0, 0.0),
    scale: float | Array = 1.0,
) -> Array:
    """Monta a matriz afim 4×4 ``[[s·R, t], [0, 1]]``."""
    R = quat_to_matrix(quat)
    s = np.asarray(scale, dtype=np.float64)
    M = np.eye(4, dtype=np.float64)
    M[:3, :3] = R * s  # escala isotrópica (float) ou por-eixo (vetor 3,)
    M[:3, 3] = np.asarray(translation, dtype=np.float64)
    return M


def transform_points(matrix: Array, points: Array) -> Array:
    """Aplica a matriz afim 4×4 a pontos ``(N,3)`` via coordenadas homogêneas."""
    p = np.asarray(points, dtype=np.float64)
    homogeneous = np.hstack([p, np.ones((len(p), 1))])  # (N,4)
    return (homogeneous @ np.asarray(matrix, dtype=np.float64).T)[:, :3]


def grip_anchor_matrix(
    hand_position: Array, quat: Array, grip_point: Array, scale: float = 1.0
) -> Array:
    """Afim que leva ``grip_point`` (local do prop) exatamente a ``hand_position``.

    ``t = hand_pos − s·R·grip`` garante que, após rotação/escala, a empunhadura
    caia na mão — não a origem arbitrária do arquivo do prop.
    """
    R = quat_to_matrix(quat)
    grip = np.asarray(grip_point, dtype=np.float64)
    hand = np.asarray(hand_position, dtype=np.float64)
    translation = hand - scale * (R @ grip)
    return affine_matrix(translation=translation, quat=quat, scale=scale)


# ------------------------------------------------------- concatenação de malha
def attach_prop(character: Mesh, prop: Mesh, matrix: Array) -> Mesh:
    """Transforma o prop pela matriz e concatena com o personagem numa só malha.

    Os índices das faces do prop são deslocados por ``len(character.vertices)`` —
    ambas as malhas permanecem componentes conexos independentes no resultado.
    """
    prop_vertices = transform_points(matrix, prop.vertices)
    vertices = np.vstack([character.vertices, prop_vertices])
    offset = len(character.vertices)
    faces = np.vstack([character.faces, prop.faces + offset]) if len(prop.faces) else character.faces
    return Mesh(vertices, faces)


# --------------------------------------------------------------- orquestração
@dataclass
class CoupleResult:
    mesh: Mesh
    matrix: Array
    character_vertices: int
    prop_vertices: int


def couple(
    character_path: str | Path,
    prop_path: str | Path,
    hand_position: Vec3,
    quat: Vec3 | tuple[float, float, float, float] = (1.0, 0.0, 0.0, 0.0),
    grip_point: Vec3 = (0.0, 0.0, 0.0),
    scale: float = 1.0,
    output_path: str | Path | None = None,
    loader=None,
) -> CoupleResult:
    """Carrega personagem + prop, acopla e (opcionalmente) exporta o ``.obj`` unido.

    ``loader`` é uma função ``path -> Mesh`` (default: ``Mesh.load_obj``). Passe um
    loader baseado em ``trimesh`` se precisar de formatos que o nosso IO não cobre.
    """
    load = loader or Mesh.load_obj
    character = load(character_path)
    prop = load(prop_path)

    matrix = grip_anchor_matrix(hand_position, quat, grip_point, scale)
    unified = attach_prop(character, prop, matrix)

    if output_path is not None:
        unified.save_obj(
            output_path,
            header=[
                f"acoplado: {Path(character_path).name} + {Path(prop_path).name}",
                f"mao={tuple(hand_position)} quat={tuple(quat)} escala={scale}",
            ],
        )
    return CoupleResult(
        mesh=unified,
        matrix=matrix,
        character_vertices=len(character.vertices),
        prop_vertices=len(prop.vertices),
    )
