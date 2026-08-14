"""Retopologia Genética — algoritmos que curam a geometria caótica da IA.

Ordem canônica da cura (:func:`heal`):

1. **Solda de vértices** coincidentes (``weld_vertices``) — remove duplicatas
   geradas por reconstruções que não compartilham vértices entre faces.
2. **Remoção de faces degeneradas** (``remove_degenerate_faces``) — descarta
   triângulos de área ~0, que produzem normais indefinidas.
3. **Remoção de faces duplicadas** (``remove_duplicate_faces``).
4. **Suavização** (``laplacian_smooth``) — difusão que regulariza a superfície.

Aceleradores opcionais: se ``open3d`` estiver presente, :func:`poisson_reconstruct`
oferece Reconstrução de Superfície de Poisson para fechar buracos com uma malha
water-tight. Sem ``open3d`` a função levanta ``RuntimeError`` explicativo — o
restante do módulo continua funcionando em ``numpy`` puro.
"""

from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np

from .mesh import FloatArray, IntArray, Mesh, TopologyReport


@dataclass
class HealConfig:
    """Parâmetros da pipeline de cura."""

    weld_tolerance: float = 1e-5
    remove_degenerate: bool = True
    degenerate_area_eps: float = 1e-12
    remove_duplicate_faces: bool = True
    smooth_iterations: int = 0
    smooth_lambda: float = 0.5
    smooth_mu: float = -0.53  # Taubin: μ < 0 compensa o encolhimento de λ
    use_taubin: bool = True


@dataclass
class HealResult:
    """Malha curada + relatórios antes/depois e passos aplicados."""

    mesh: Mesh
    before: TopologyReport
    after: TopologyReport
    steps: list[str] = field(default_factory=list)


# --------------------------------------------------------------------- solda -
def weld_vertices(mesh: Mesh, tolerance: float = 1e-5) -> Mesh:
    """Funde vértices coincidentes dentro de ``tolerance``.

    Estratégia de *spatial hashing* por quantização: cada posição é arredondada
    para a grade de passo ``tolerance`` e vértices que caem na mesma célula são
    fundidos no seu centróide. O agrupamento usa ``np.unique`` sobre as chaves
    inteiras da grade — ``O(V log V)``, dentro do limite assintótico exigido para
    malhas de 1e6 vértices (sem necessidade de octree explícita neste passo).

    Nota: a quantização pode não fundir dois pontos próximos que caiam em lados
    opostos de uma fronteira de célula. Para solda de tolerância isso é aceitável;
    quando exatidão de vizinhança é crítica, prefira o KD-tree em ``spatial.py``.
    """
    if tolerance <= 0 or len(mesh.vertices) == 0:
        return mesh.copy()

    keys = np.round(mesh.vertices / tolerance).astype(np.int64)
    _, inverse, counts = np.unique(
        keys, axis=0, return_inverse=True, return_counts=True
    )
    inverse = inverse.ravel()
    n_groups = len(counts)

    # Centróide de cada grupo: soma acumulada / contagem (posição média estável).
    summed = np.zeros((n_groups, 3), dtype=np.float64)
    np.add.at(summed, inverse, mesh.vertices)
    new_vertices = summed / counts[:, None]

    new_faces = inverse[mesh.faces]
    # Remove faces que colapsaram (dois ou mais cantos agora no mesmo vértice).
    valid = (
        (new_faces[:, 0] != new_faces[:, 1])
        & (new_faces[:, 1] != new_faces[:, 2])
        & (new_faces[:, 2] != new_faces[:, 0])
    )
    return Mesh(new_vertices, new_faces[valid])


# --------------------------------------------------------------- degeneradas -
def remove_degenerate_faces(mesh: Mesh, area_eps: float = 1e-12) -> Mesh:
    """Descarta triângulos com área ``<= area_eps`` (colineares / de área nula)."""
    if len(mesh.faces) == 0:
        return mesh.copy()
    keep = mesh.face_areas() > area_eps
    return Mesh(mesh.vertices.copy(), mesh.faces[keep])


def remove_duplicate_faces(mesh: Mesh) -> Mesh:
    """Remove faces duplicadas independentemente da ordem cíclica dos cantos."""
    if len(mesh.faces) == 0:
        return mesh.copy()
    canon = np.sort(mesh.faces, axis=1)  # ignora orientação para deduplicar
    _, unique_idx = np.unique(canon, axis=0, return_index=True)
    keep = np.sort(unique_idx)
    return Mesh(mesh.vertices.copy(), mesh.faces[keep])


def remove_unreferenced_vertices(mesh: Mesh) -> Mesh:
    """Descarta vértices que nenhuma face referencia e remapeia os índices.

    Passos de remoção de faces deixam vértices órfãos; compactá-los mantém a
    numeração densa (importante para o rigging, que indexa vértices por peso).
    """
    if len(mesh.faces) == 0:
        return Mesh(np.empty((0, 3), np.float64), np.empty((0, 3), np.int64))
    used = np.unique(mesh.faces)
    remap = np.full(len(mesh.vertices), -1, dtype=np.int64)
    remap[used] = np.arange(len(used), dtype=np.int64)
    return Mesh(mesh.vertices[used], remap[mesh.faces])


# ----------------------------------------------------------------- suavização -
def _build_adjacency(mesh: Mesh) -> tuple[IntArray, IntArray]:
    """Lista de adjacência 1-anel como pares direcionados ``(i, j)`` únicos."""
    f = mesh.faces
    pairs = np.concatenate(
        [
            f[:, [0, 1]], f[:, [1, 0]],
            f[:, [1, 2]], f[:, [2, 1]],
            f[:, [2, 0]], f[:, [0, 2]],
        ],
        axis=0,
    )
    pairs = np.unique(pairs, axis=0)
    return pairs[:, 0].copy(), pairs[:, 1].copy()


def _umbrella_step(
    vertices: FloatArray, src: IntArray, dst: IntArray, degree: FloatArray, lam: float
) -> FloatArray:
    """Um passo do operador umbrella (Laplaciano uniforme).

    ``L(v_i) = (1/|N(i)|) Σ_{j∈N(i)} (v_j - v_i)`` e ``v_i ← v_i + λ · L(v_i)``.
    É um passo de difusão (equação do calor discreta) que atenua alta frequência.
    """
    accum = np.zeros_like(vertices)
    np.add.at(accum, src, vertices[dst] - vertices[src])
    safe_degree = np.where(degree > 0, degree, 1.0)
    laplacian = accum / safe_degree[:, None]
    return vertices + lam * laplacian


def laplacian_smooth(
    mesh: Mesh,
    iterations: int = 5,
    lam: float = 0.5,
    mu: float = -0.53,
    taubin: bool = True,
) -> Mesh:
    """Suavização Laplaciana uniforme, opcionalmente em modo Taubin (λ|μ).

    A suavização Laplaciana pura encolhe o volume (passa-baixa que também remove
    a média). O esquema de **Taubin** alterna um passo positivo ``λ`` com um passo
    negativo ``μ`` (``μ < -λ``), formando um filtro passa-banda que suaviza o ruído
    de alta frequência **sem** encolher a silhueta — essencial para não deformar a
    silhueta de Zane/Vance/Leo. Vértices de borda são preservados (ordem 0).
    """
    if iterations <= 0 or len(mesh.faces) == 0:
        return mesh.copy()

    src, dst = _build_adjacency(mesh)
    degree = np.bincount(src, minlength=len(mesh.vertices)).astype(np.float64)

    verts = mesh.vertices.copy()
    for _ in range(iterations):
        verts = _umbrella_step(verts, src, dst, degree, lam)
        if taubin:
            verts = _umbrella_step(verts, src, dst, degree, mu)
    return Mesh(verts, mesh.faces.copy())


# ---------------------------------------------------- acelerador opcional (o3d)
def poisson_reconstruct(
    mesh: Mesh, depth: int = 8, normals_knn: int = 30
) -> Mesh:
    """Reconstrução de Superfície de Poisson (requer ``open3d``).

    Resolve ``∇·(∇χ) = ∇·V`` para o campo indicador ``χ`` a partir das normais,
    produzindo uma isosuperfície water-tight — ideal para fechar buracos que a
    suavização não fecha. Fallback: sem ``open3d``, levanta ``RuntimeError``.
    """
    try:
        import open3d as o3d  # type: ignore
    except ImportError as exc:  # pragma: no cover - depende do ambiente
        raise RuntimeError(
            "poisson_reconstruct requer 'open3d' (acelerador opcional). "
            "Instale com `pip install open3d` ou use apenas weld+smooth."
        ) from exc

    pcd = o3d.geometry.PointCloud()
    pcd.points = o3d.utility.Vector3dVector(mesh.vertices)
    pcd.estimate_normals(
        search_param=o3d.geometry.KDTreeSearchParamKNN(knn=normals_knn)
    )
    rec, _ = o3d.geometry.TriangleMesh.create_from_point_cloud_poisson(
        pcd, depth=depth
    )
    v = np.asarray(rec.vertices, dtype=np.float64)
    f = np.asarray(rec.triangles, dtype=np.int64)
    return Mesh(v, f)


# ---------------------------------------------------------------- orquestração -
def heal(mesh: Mesh, config: HealConfig | None = None) -> HealResult:
    """Executa a pipeline de cura completa e devolve malha + relatórios."""
    cfg = config or HealConfig()
    before = mesh.analyze()
    steps: list[str] = []
    current = mesh

    if cfg.weld_tolerance > 0:
        current = weld_vertices(current, cfg.weld_tolerance)
        steps.append(f"weld_vertices(tol={cfg.weld_tolerance})")
    if cfg.remove_degenerate:
        current = remove_degenerate_faces(current, cfg.degenerate_area_eps)
        steps.append(f"remove_degenerate_faces(eps={cfg.degenerate_area_eps})")
    if cfg.remove_duplicate_faces:
        current = remove_duplicate_faces(current)
        steps.append("remove_duplicate_faces()")
    if cfg.remove_degenerate or cfg.remove_duplicate_faces:
        current = remove_unreferenced_vertices(current)
        steps.append("remove_unreferenced_vertices()")
    if cfg.smooth_iterations > 0:
        current = laplacian_smooth(
            current,
            iterations=cfg.smooth_iterations,
            lam=cfg.smooth_lambda,
            mu=cfg.smooth_mu,
            taubin=cfg.use_taubin,
        )
        mode = "taubin" if cfg.use_taubin else "uniform"
        steps.append(f"laplacian_smooth(n={cfg.smooth_iterations}, mode={mode})")

    after = current.analyze()
    return HealResult(mesh=current, before=before, after=after, steps=steps)
