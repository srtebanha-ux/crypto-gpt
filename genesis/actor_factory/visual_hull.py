"""Fábrica de Atores em código bruto — Shape-from-Silhouette (Visual Hull).

Reconstrói uma malha 3D a partir de silhuetas ortográficas (frente, lado, costas)
por **escultura de voxels (space carving)** — geometria projetiva pura em ``numpy``,
sem rede neural nem serviço de terceiros. Único componente externo: ``Pillow``,
apenas para decodificar os pixels das imagens.

Método (visual hull clássico):

1. Extrai a **silhueta** de cada vista (fundo neutro ⇒ máscara por distância de cor).
2. Para cada voxel de um cubo ``N³``, projeta seu centro em cada vista; o voxel
   **sobrevive** se cair dentro de *todas* as silhuetas. A interseção dos cones de
   visão é o *visual hull* — o maior sólido consistente com as silhuetas.
3. Converte os voxels ocupados em malha (faces expostas), pronta para Taubin +
   cura do Módulo 2.

Convenção de mundo: X (esquerda-direita), Y (profundidade), Z (altura).
A frente/costas restringem a silhueta em (X,Z); o lado restringe (Y,Z).

**Limite honesto:** o visual hull captura o *envelope* das silhuetas, não
concavidades (o vão entre braço e tronco não é escavado) nem detalhe fino de
rosto. O resultado é um manequim com a proporção certa — base para o rig, não o
render final.
"""

from __future__ import annotations

from collections import deque
from pathlib import Path

import numpy as np
from numpy.typing import NDArray

from ..mesh import Mesh

BoolMask = NDArray[np.bool_]


# ------------------------------------------------------- extração de silhueta
def extract_silhouette(
    image_path: str | Path, threshold: float = 0.18, keep_largest: bool = True
) -> BoolMask:
    """Máscara booleana do personagem (True=frente) por distância do fundo.

    O fundo é estimado pela mediana dos 4 cantos; um pixel é frente se sua cor
    dista mais que ``threshold`` (0..1) do fundo. ``keep_largest`` mantém só o
    maior blob conexo — remove faixas de título, marca d'água e ruído de fundo.
    """
    from PIL import Image

    rgb = np.asarray(Image.open(image_path).convert("RGB"), dtype=np.float64) / 255.0
    h, w, _ = rgb.shape
    corners = np.concatenate([
        rgb[:8, :8].reshape(-1, 3), rgb[:8, -8:].reshape(-1, 3),
        rgb[-8:, :8].reshape(-1, 3), rgb[-8:, -8:].reshape(-1, 3),
    ])
    bg = np.median(corners, axis=0)
    dist = np.linalg.norm(rgb - bg, axis=2)
    mask = dist > threshold
    if keep_largest and mask.any():
        mask = _largest_component(mask)
    return mask


def save_mask(mask: BoolMask, path: str | Path) -> None:
    """Grava uma silhueta booleana como PNG (branco=frente) para diagnóstico."""
    from PIL import Image

    Image.fromarray((np.asarray(mask) * 255).astype(np.uint8), mode="L").save(path)


def _largest_component(mask: BoolMask) -> BoolMask:
    """Mantém o componente conexo (4-conectividade) que mais cobre a coluna central.

    Faz *flood fill* a partir do pixel de frente mais próximo do centro-inferior
    da imagem (onde um personagem em pé fica), isolando-o de textos/logos soltos.
    """
    h, w = mask.shape
    # semente: frente mais próxima do centro horizontal, parte de baixo
    ys, xs = np.nonzero(mask)
    target = np.array([h * 0.6, w * 0.5])
    seed_idx = np.argmin((ys - target[0]) ** 2 + (xs - target[1]) ** 2)
    seed = (int(ys[seed_idx]), int(xs[seed_idx]))

    out = np.zeros_like(mask)
    stack = deque([seed])
    out[seed] = True
    while stack:
        y, x = stack.pop()
        for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            ny, nx = y + dy, x + dx
            if 0 <= ny < h and 0 <= nx < w and mask[ny, nx] and not out[ny, nx]:
                out[ny, nx] = True
                stack.append((ny, nx))
    return out


# --------------------------------------------------------- amostrador de vista
def _bbox(mask: BoolMask) -> tuple[int, int, int, int]:
    ys, xs = np.nonzero(mask)
    return int(ys.min()), int(ys.max()), int(xs.min()), int(xs.max())


def _sample(mask: BoolMask, u: NDArray, v: NDArray) -> BoolMask:
    """Amostra a silhueta em coordenadas normalizadas do bounding box.

    ``u`` (horizontal, 0..1) e ``v`` (vertical *para cima*, 0..1) mapeiam a caixa
    do personagem; ``v=1`` é o topo (cabeça), então a linha da imagem é invertida.
    """
    rmin, rmax, cmin, cmax = _bbox(mask)
    col = np.clip(np.round(cmin + u * (cmax - cmin)).astype(int), 0, mask.shape[1] - 1)
    row = np.clip(np.round(rmin + (1.0 - v) * (rmax - rmin)).astype(int), 0, mask.shape[0] - 1)
    return mask[row, col]


# --------------------------------------------------------------- escultura 3D
def carve(
    front: BoolMask,
    side: BoolMask,
    back: BoolMask | None = None,
    resolution: int = 96,
    flip_depth: bool = False,
) -> NDArray[np.bool_]:
    """Esculpe o visual hull. Retorna ocupação booleana ``(N,N,N)`` em (X,Y,Z).

    front/back restringem (X,Z); side restringe (Y,Z). O grid é o cubo unitário
    de voxels; um voxel sobrevive se seu centro projeta dentro de todas as vistas.
    """
    n = resolution
    frac = (np.arange(n) + 0.5) / n
    fx = frac[:, None, None]
    fy = frac[None, :, None]
    fz = frac[None, None, :]
    fx, fy, fz = np.broadcast_arrays(fx, fy, fz)

    occ = _sample(front, fx, fz)
    depth_u = (1.0 - fy) if flip_depth else fy
    occ &= _sample(side, depth_u, fz)
    if back is not None:
        occ &= _sample(back, 1.0 - fx, fz)  # de costas, esquerda↔direita invertem
    return occ


# -------------------------------------------------- limpeza de voxels (nossa)
def _dilate(occ: NDArray[np.bool_]) -> NDArray[np.bool_]:
    """Dilatação morfológica 6-conexa (OR com os 6 vizinhos)."""
    p = np.pad(occ, 1, constant_values=False)
    return (
        p[1:-1, 1:-1, 1:-1] | p[:-2, 1:-1, 1:-1] | p[2:, 1:-1, 1:-1]
        | p[1:-1, :-2, 1:-1] | p[1:-1, 2:, 1:-1]
        | p[1:-1, 1:-1, :-2] | p[1:-1, 1:-1, 2:]
    )


def _erode(occ: NDArray[np.bool_]) -> NDArray[np.bool_]:
    """Erosão morfológica 6-conexa (AND com os 6 vizinhos; borda conta como vazio)."""
    p = np.pad(occ, 1, constant_values=False)
    return (
        p[1:-1, 1:-1, 1:-1] & p[:-2, 1:-1, 1:-1] & p[2:, 1:-1, 1:-1]
        & p[1:-1, :-2, 1:-1] & p[1:-1, 2:, 1:-1]
        & p[1:-1, 1:-1, :-2] & p[1:-1, 1:-1, 2:]
    )


def morphological_close(occ: NDArray[np.bool_], iterations: int = 1) -> NDArray[np.bool_]:
    """Fechamento (dilata N, depois erode N): tapa vãos finos e funde pontes.

    Remove os buracos de 1 voxel e as pontes frágeis que quebram o sólido em
    componentes — o que deixa a casca mais próxima de manifold/water-tight.
    """
    if iterations <= 0:
        return occ
    m = occ
    for _ in range(iterations):
        m = _dilate(m)
    for _ in range(iterations):
        m = _erode(m)
    return m


def largest_component(occ: NDArray[np.bool_]) -> NDArray[np.bool_]:
    """Mantém só o maior componente conexo (6-conectividade) do volume.

    Rotulação por propagação do menor índice entre vizinhos ocupados até
    estabilizar — descarta cacos flutuantes que a escultura deixa soltos.
    """
    if not occ.any():
        return occ
    inf = occ.size
    lab = np.where(occ, np.arange(occ.size).reshape(occ.shape), inf).astype(np.int64)
    while True:
        p = np.pad(lab, 1, constant_values=inf)
        m = lab.copy()
        m = np.minimum(m, p[:-2, 1:-1, 1:-1]); m = np.minimum(m, p[2:, 1:-1, 1:-1])
        m = np.minimum(m, p[1:-1, :-2, 1:-1]); m = np.minimum(m, p[1:-1, 2:, 1:-1])
        m = np.minimum(m, p[1:-1, 1:-1, :-2]); m = np.minimum(m, p[1:-1, 1:-1, 2:])
        m = np.where(occ, m, inf)
        if np.array_equal(m, lab):
            break
        lab = m
    vals = lab[occ]
    uniq, counts = np.unique(vals, return_counts=True)
    biggest = uniq[np.argmax(counts)]
    return occ & (lab == biggest)


# ------------------------------------------------------ voxels → malha (nossa)
# Deslocamentos dos 4 cantos de cada face e o eixo/direção, com winding p/ normal
# apontando para fora. Cada face vira 2 triângulos.
_FACE_DEFS = {
    (1, 0, 0): [(1, 0, 0), (1, 1, 0), (1, 1, 1), (1, 0, 1)],   # +X
    (-1, 0, 0): [(0, 0, 0), (0, 0, 1), (0, 1, 1), (0, 1, 0)],  # -X
    (0, 1, 0): [(0, 1, 0), (0, 1, 1), (1, 1, 1), (1, 1, 0)],   # +Y
    (0, -1, 0): [(0, 0, 0), (1, 0, 0), (1, 0, 1), (0, 0, 1)],  # -Y
    (0, 0, 1): [(0, 0, 1), (1, 0, 1), (1, 1, 1), (0, 1, 1)],   # +Z
    (0, 0, -1): [(0, 0, 0), (0, 1, 0), (1, 1, 0), (1, 0, 0)],  # -Z
}


def voxels_to_mesh(occupancy: NDArray[np.bool_], voxel_size: float = 1.0) -> Mesh:
    """Malha das faces expostas dos voxels ocupados (surface nets simples).

    Uma face de voxel é emitida quando o vizinho naquela direção está vazio —
    produz a casca fechada do sólido. Vértices são deduplicados por coordenada
    inteira de canto.
    """
    occ = np.asarray(occupancy, dtype=bool)
    n = occ.shape
    padded = np.pad(occ, 1)  # borda vazia para expor faces externas

    quads: list[tuple] = []
    for (dx, dy, dz), corners in _FACE_DEFS.items():
        shifted = padded[1 + dx: 1 + dx + n[0], 1 + dy: 1 + dy + n[1], 1 + dz: 1 + dz + n[2]]
        exposed = occ & ~shifted
        ii, jj, kk = np.nonzero(exposed)
        base = np.stack([ii, jj, kk], axis=1)  # (M,3) canto mínimo do voxel
        for c in corners:
            quads.append(base + np.array(c))
    if not quads:
        return Mesh(np.empty((0, 3), np.float64), np.empty((0, 3), np.int64))

    # quads guarda, por tipo de face (6), 4 arrays (M_t,3) — um por canto. Para
    # cada canto c, concatena os 6 tipos na mesma ordem: assim o índice i em c0..c3
    # refere-se sempre à mesma face triangulável.
    n_types = len(quads) // 4
    c0 = np.concatenate([quads[t * 4 + 0] for t in range(n_types)])
    c1 = np.concatenate([quads[t * 4 + 1] for t in range(n_types)])
    c2 = np.concatenate([quads[t * 4 + 2] for t in range(n_types)])
    c3 = np.concatenate([quads[t * 4 + 3] for t in range(n_types)])

    all_corners = np.concatenate([c0, c1, c2, c3])
    unique, inverse = np.unique(all_corners, axis=0, return_inverse=True)
    inverse = inverse.ravel().reshape(4, -1)  # (4, F)
    i0, i1, i2, i3 = inverse[0], inverse[1], inverse[2], inverse[3]
    tris = np.concatenate([
        np.stack([i0, i1, i2], axis=1),
        np.stack([i0, i2, i3], axis=1),
    ])
    return Mesh(unique.astype(np.float64) * voxel_size, tris)


# --------------------------------------------------------------- orquestração
def build_actor_from_images(
    front_path: str | Path,
    side_path: str | Path,
    back_path: str | Path | None = None,
    resolution: int = 128,
    smooth_iterations: int = 14,
    target_height: float = 1.8,
    threshold: float = 0.18,
    flip_depth: bool = False,
    close_iterations: int = 1,
    keep_largest: bool = True,
    output_path: str | Path | None = None,
) -> Mesh:
    """Pipeline completo: silhuetas → visual hull → limpeza → Taubin → ``.obj``.

    Reconstrói a malha do ator só com nossa matemática (Pillow apenas lê pixels).
    A escultura passa por fechamento morfológico e extração do maior componente
    (junta o corpo num sólido só), depois suavização Taubin e normalização
    (Z-up nativo, escala para ``target_height``, pé no chão).
    """
    from ..retopology import laplacian_smooth
    from .normalize import normalize_actor

    front = extract_silhouette(front_path, threshold)
    side = extract_silhouette(side_path, threshold)
    back = extract_silhouette(back_path, threshold) if back_path else None

    occ = carve(front, side, back, resolution=resolution, flip_depth=flip_depth)
    if not occ.any():
        raise ValueError(
            "escultura vazia — silhuetas não se cruzam. Verifique o fundo (neutro?) "
            "e o alinhamento das vistas (mesma altura de personagem)."
        )
    occ = morphological_close(occ, close_iterations)  # tapa vãos, funde pontes
    if keep_largest:
        occ = largest_component(occ)                  # descarta cacos flutuantes
    mesh = voxels_to_mesh(occ)
    if smooth_iterations > 0:
        mesh = laplacian_smooth(mesh, iterations=smooth_iterations, lam=0.5, mu=-0.53)
    mesh = normalize_actor(mesh, from_up="z", target_height=target_height)

    if output_path is not None:
        out = Path(output_path)
        out.parent.mkdir(parents=True, exist_ok=True)
        mesh.save_obj(out, header=[
            "ator por Visual Hull (shape-from-silhouette, codigo bruto)",
            f"resolucao={resolution} suavizacao={smooth_iterations} altura={target_height}",
        ])
    return mesh
