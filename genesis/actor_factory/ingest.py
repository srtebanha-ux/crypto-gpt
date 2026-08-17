"""Ingestão de ator: carrega o modelo bruto, normaliza e cura para o pipeline.

Fluxo: **carregar** (`.obj` nativo; `.glb`/`.ply`/`.fbx` via ``trimesh`` opcional)
→ **normalizar** (Z-up, escala, chão) → **curar** (Módulo 2) → exportar `.obj`
pronto para rig/acoplador/render.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from ..mesh import Mesh, TopologyReport
from ..retopology import HealConfig, heal
from .normalize import normalize_actor


def load_any(path: str | Path) -> Mesh:
    """Carrega uma malha de vários formatos, retornando nosso :class:`Mesh`.

    ``.obj`` usa nosso próprio IO (numpy, sem dependências). Outros formatos
    (``.glb``/``.gltf``/``.ply``/``.fbx``/``.stl``) exigem ``trimesh``, que muitos
    geradores usam como saída — se ausente, erro claro pedindo `pip install trimesh`.
    """
    path = Path(path)
    if path.suffix.lower() == ".obj":
        return Mesh.load_obj(path)

    try:
        import trimesh  # type: ignore
    except ImportError as exc:
        raise RuntimeError(
            f"formato {path.suffix} requer 'trimesh' (pip install trimesh). "
            "Alternativa: exporte o modelo como .obj na ferramenta de origem."
        ) from exc

    loaded = trimesh.load(str(path), force="mesh")
    import numpy as np

    return Mesh(np.asarray(loaded.vertices, dtype=np.float64),
                np.asarray(loaded.faces, dtype=np.int64))


@dataclass
class IngestResult:
    mesh: Mesh
    before: TopologyReport
    after: TopologyReport
    output_path: Path | None


def ingest_actor(
    input_path: str | Path,
    output_path: str | Path | None = None,
    from_up: str = "y",
    target_height: float = 1.8,
    do_heal: bool = True,
    heal_config: HealConfig | None = None,
) -> IngestResult:
    """Carrega → normaliza → (cura) → exporta. Retorna malha + relatórios."""
    raw = load_any(input_path)
    before = raw.analyze()

    normalized = normalize_actor(raw, from_up=from_up, target_height=target_height)
    if do_heal:
        result = heal(normalized, heal_config or HealConfig(weld_tolerance=1e-4))
        final = result.mesh
    else:
        final = normalized

    after = final.analyze()
    out = Path(output_path) if output_path else None
    if out is not None:
        out.parent.mkdir(parents=True, exist_ok=True)
        final.save_obj(out, header=[
            f"ator ingerido de {Path(input_path).name}",
            f"altura={target_height} up_origem={from_up} curado={do_heal}",
        ])
    return IngestResult(mesh=final, before=before, after=after, output_path=out)
