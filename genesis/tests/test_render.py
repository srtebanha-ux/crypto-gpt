"""Testes do Módulo 5 (partes independentes de ``bpy``).

Exercitam configuração, validação e a matemática de potência de luz — tudo que
não exige o Blender. O render em si só roda num Python com ``bpy`` instalado.
Roda com pytest OU ``python -m genesis.tests.test_render``.
"""

from __future__ import annotations

import math

from genesis.render import (
    DEFAULT_THREE_POINT,
    HeadlessRenderEngine,
    RenderConfig,
    RenderEngineError,
)


def test_config_defaults_vertical_reels() -> None:
    cfg = RenderConfig(input_mesh="exports/zane.obj", output_dir="renders")
    assert cfg.resolution == (1080, 1920)  # vertical (Reels/TikTok)
    assert cfg.samples == 128 and cfg.use_denoise is True
    assert cfg.device_type == "METAL"  # Apple Silicon, nunca CUDA/OptiX


def test_config_rejects_invalid_frame_range() -> None:
    try:
        RenderConfig(input_mesh="a", output_dir="b", frame_start=10, frame_end=2)
    except ValueError:
        return
    raise AssertionError("deveria rejeitar frame_end < frame_start")


def test_config_rejects_nonpositive_samples() -> None:
    try:
        RenderConfig(input_mesh="a", output_dir="b", samples=0)
    except ValueError:
        return
    raise AssertionError("deveria rejeitar samples <= 0")


def test_light_power_inverse_square() -> None:
    for spec in DEFAULT_THREE_POINT:
        expected = spec.irradiance * 4.0 * math.pi * spec.distance**2
        assert abs(HeadlessRenderEngine._light_power(spec) - expected) < 1e-9


def test_three_point_ratio_and_plausible_watts() -> None:
    key, fill, rim = DEFAULT_THREE_POINT
    # Razão de contraste Key:Fill ~ 4:1 (retrato clássico).
    assert 3.5 <= key.irradiance / fill.irradiance <= 4.5
    # Potências na faixa saudável do Cycles para retrato (nada de 50 kW).
    for spec in DEFAULT_THREE_POINT:
        watts = HeadlessRenderEngine._light_power(spec)
        assert 100.0 <= watts <= 2000.0


def test_render_without_bpy_raises_clean_error() -> None:
    # Sem Blender no ambiente, a etapa de device deve falhar de forma explícita
    # (RenderEngineError), nunca com um ImportError cru ou crash.
    cfg = RenderConfig(input_mesh="exports/zane.obj", output_dir="renders")
    engine = HeadlessRenderEngine(cfg)
    try:
        engine.configure_device()
    except RenderEngineError as exc:
        assert "bpy" in str(exc)
        return
    # Se bpy existir (ambiente com Blender), não há erro a validar aqui.


def _run_all() -> None:
    fns = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]
    for fn in fns:
        fn()
        print(f"  PASS {fn.__name__}")
    print(f"\n{len(fns)} testes OK")


if __name__ == "__main__":
    _run_all()
