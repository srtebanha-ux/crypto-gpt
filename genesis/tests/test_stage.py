"""Testes do cenário (partes independentes de ``bpy``): geometria e config."""

from __future__ import annotations

import numpy as np

from genesis.stage import (
    WARM_STAGE_PALETTE,
    StageConfig,
    aim_directions,
    rim_positions,
    truss_spot_positions,
)


def test_truss_positions_span_width_symmetrically() -> None:
    pos = truss_spot_positions(count=5, width=8.0, height=4.5, depth=4.0)
    assert pos.shape == (5, 3)
    assert np.isclose(pos[:, 0].min(), -4.0) and np.isclose(pos[:, 0].max(), 4.0)
    assert np.allclose(pos[:, 1], -4.0)   # à frente do sujeito (-Y)
    assert np.allclose(pos[:, 2], 4.5)    # à altura da treliça
    assert np.isclose(pos[:, 0].mean(), 0.0)  # simétrico em torno do centro


def test_single_spot_is_centered() -> None:
    pos = truss_spot_positions(count=1, width=8.0, height=4.5, depth=4.0)
    assert pos.shape == (1, 3)
    assert np.allclose(pos[0], [0.0, -4.0, 4.5])


def test_rim_positions_are_behind_subject() -> None:
    pos = rim_positions(count=2, width=5.0, height=4.5, depth=3.6)
    assert np.all(pos[:, 1] > 0.0)  # atrás do sujeito (+Y)


def test_aim_directions_are_unit_and_point_to_target() -> None:
    pos = truss_spot_positions(count=3, width=6.0, height=4.0, depth=4.0)
    target = np.array([0.0, 0.0, 1.4])
    dirs = aim_directions(pos, target)
    assert np.allclose(np.linalg.norm(dirs, axis=1), 1.0, atol=1e-9)
    # cada direção, escalada de volta, aponta para o alvo
    for p, d in zip(pos, dirs):
        reconstructed = p + d * np.linalg.norm(target - p)
        assert np.allclose(reconstructed, target, atol=1e-6)


def test_palette_has_warm_and_cool_and_valid_ranges() -> None:
    assert set(WARM_STAGE_PALETTE) == {"amber", "warm_white", "cool_rim"}
    for rgb in WARM_STAGE_PALETTE.values():
        assert len(rgb) == 3 and all(0.0 <= c <= 1.0 for c in rgb)
    # âmbar é quente (R > B); o rim é frio (B > R)
    assert WARM_STAGE_PALETTE["amber"][0] > WARM_STAGE_PALETTE["amber"][2]
    assert WARM_STAGE_PALETTE["cool_rim"][2] > WARM_STAGE_PALETTE["cool_rim"][0]


def test_config_validation() -> None:
    for bad in (dict(truss_count=0), dict(spot_blend=1.5)):
        try:
            StageConfig(**bad)
        except ValueError:
            continue
        raise AssertionError(f"StageConfig deveria rejeitar {bad}")


def _run_all() -> None:
    fns = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]
    for fn in fns:
        fn()
        print(f"  PASS {fn.__name__}")
    print(f"\n{len(fns)} testes OK")


if __name__ == "__main__":
    _run_all()
