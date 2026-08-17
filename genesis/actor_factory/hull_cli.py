"""CLI da Fábrica de Atores em código bruto — Visual Hull a partir de imagens.

Reconstrói uma malha 3D das silhuetas (frente/lado/costas) por escultura de
voxels — só numpy + Pillow, sem rede neural nem serviço externo.

Exemplos::

    python -m genesis.actor_factory.hull_cli \
        --front img/zane_frente.png --side img/zane_lado.png --back img/zane_costas.png \
        --out exports/zane.obj --resolution 128

    # Só duas vistas (frente + lado) já esculpem um hull
    python -m genesis.actor_factory.hull_cli \
        --front img/zane_frente.png --side img/zane_lado.png --out exports/zane.obj
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

from pathlib import Path as _Path

from .visual_hull import build_actor_from_images, extract_silhouette, save_mask


def _build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="genesis.actor_factory.hull_cli",
        description="Visual Hull — reconstrucao 3D por silhuetas (codigo bruto, sem IA de terceiros).",
    )
    p.add_argument("--front", required=True, help="imagem da vista frontal")
    p.add_argument("--side", required=True, help="imagem da vista de lado")
    p.add_argument("--back", help="imagem da vista de costas (opcional, melhora o hull)")
    p.add_argument("--out", required=True, help="caminho .obj de saida")
    p.add_argument("--resolution", type=int, default=128, help="voxels por eixo (default 128)")
    p.add_argument("--smooth", type=int, default=14, help="iteracoes de suavizacao Taubin")
    p.add_argument("--height", type=float, default=1.8, help="altura-alvo em metros")
    p.add_argument("--threshold", type=float, default=0.18, help="limiar de silhueta (0..1)")
    p.add_argument("--flip-depth", action="store_true", help="inverte a profundidade (lado espelhado)")
    p.add_argument("--close", type=int, default=1, help="iteracoes de fechamento morfologico")
    p.add_argument("--keep-all", action="store_true", help="nao descarta cacos (mantem todos componentes)")
    p.add_argument("--keep-ground", action="store_true", help="nao remove a poca de chao na base")
    p.add_argument(
        "--save-masks", action="store_true",
        help="salva as silhuetas extraidas em renders/mask_*.png e sai (diagnostico)",
    )
    return p


def main(argv: list[str] | None = None) -> int:
    args = _build_parser().parse_args(argv)
    for label in ("front", "side", "back"):
        path = getattr(args, label)
        if path and not Path(path).exists():
            print(f"erro: {label} não encontrado: {path}", file=sys.stderr)
            return 2

    if args.save_masks:
        out_dir = _Path("renders")
        out_dir.mkdir(parents=True, exist_ok=True)
        for label, path in (("frente", args.front), ("lado", args.side), ("costas", args.back)):
            if not path:
                continue
            mask = extract_silhouette(path, threshold=args.threshold)
            dest = out_dir / f"mask_{label}.png"
            save_mask(mask, dest)
            cover = 100.0 * mask.mean()
            print(f"[MASK] {label}: {dest}  (frente cobre {cover:.1f}% da imagem)")
        print(">> abra renders/mask_*.png — o personagem deve ser branco em fundo preto")
        return 0

    try:
        mesh = build_actor_from_images(
            front_path=args.front,
            side_path=args.side,
            back_path=args.back,
            resolution=args.resolution,
            smooth_iterations=args.smooth,
            target_height=args.height,
            threshold=args.threshold,
            flip_depth=args.flip_depth,
            close_iterations=args.close,
            keep_largest=not args.keep_all,
            drop_ground=not args.keep_ground,
            output_path=args.out,
        )
    except (ValueError, RuntimeError) as exc:
        print(f"[VISUAL-HULL] ERRO: {exc}", file=sys.stderr)
        return 1

    report = mesh.analyze()
    print(f"[VISUAL-HULL] ator reconstruído: {args.out}")
    print(f"  {len(mesh.vertices)} vértices, {len(mesh.faces)} faces")
    print(f"  water-tight={report.is_watertight}  componentes={report.num_components}")
    print("  (visual hull: envelope das silhuetas — base para rig, não render final)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
