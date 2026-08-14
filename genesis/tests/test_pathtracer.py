"""Testes do Motor Mitsuba (partes independentes do ``mitsuba``): cena e config."""

from __future__ import annotations

import math

import numpy as np

from genesis.pathtracer import (
    DEFAULT_LIGHTS,
    RenderConfig,
    describe_scene,
    measure_mesh,
    spherical_to_cartesian,
)
from genesis.pathtracer.engine import LightSpec
from genesis.shapes import icosphere


def test_config_validation() -> None:
    for bad in (dict(samples=0), dict(max_depth=0)):
        try:
            RenderConfig(input_mesh="x.obj", **bad)
        except ValueError:
            continue
        raise AssertionError(f"deveria rejeitar {bad}")


def test_measure_mesh_unit_sphere() -> None:
    sphere = icosphere(subdivisions=2, radius=1.0)
    center, dims = measure_mesh(sphere)
    assert np.allclose(center, [0, 0, 0], atol=1e-9)
    assert np.allclose(dims, [2, 2, 2], atol=1e-6)  # diâmetro 2


def test_light_intensity_inverse_square() -> None:
    spec = LightSpec("K", azimuth=0, elevation=0, distance=3.0, irradiance=10.0, color=(1, 1, 1))
    # I = E · d² = 10 · 9 = 90
    assert np.allclose(spec.intensity(), [90.0, 90.0, 90.0], atol=1e-9)


def test_spherical_front_is_negative_y() -> None:
    # azimute 0 e elevação 0 → diretamente à frente do sujeito (−Y)
    p = spherical_to_cartesian(0.0, 0.0, 2.0)
    assert np.allclose(p, [0.0, -2.0, 0.0], atol=1e-9)


def test_describe_scene_camera_distance_from_fov() -> None:
    cfg = RenderConfig(input_mesh="x.obj", fov_deg=32.0, frame_height_fraction=0.9)
    center = np.zeros(3)
    dims = np.array([1.0, 1.0, 2.0])  # altura 2
    desc = describe_scene(cfg, center, dims)

    frame_h = 2.0 * 0.9
    expected_d = (frame_h / 2.0) / math.tan(math.radians(32.0) / 2.0)
    origin = np.array(desc["sensor"]["origin"])
    aim = np.array(desc["sensor"]["target"])
    # câmera está à frente (−Y) e a distância planejada do alvo
    assert origin[1] < aim[1]
    assert np.isclose(abs(aim[1] - origin[1]), expected_d, atol=1e-9)


def test_describe_scene_has_all_lights_and_floor() -> None:
    cfg = RenderConfig(input_mesh="x.obj", add_floor=True)
    desc = describe_scene(cfg, np.zeros(3), np.array([1.0, 1.0, 2.0]))
    assert len(desc["lights"]) == len(DEFAULT_LIGHTS)
    names = {l["name"] for l in desc["lights"]}
    assert names == {"KEY", "FILL", "RIM"}
    assert desc["floor"] is not None
    # cada luz tem posição 3D e intensidade RGB positiva
    for light in desc["lights"]:
        assert len(light["position"]) == 3
        assert all(c > 0 for c in light["intensity"])


def test_describe_scene_no_floor_when_disabled() -> None:
    cfg = RenderConfig(input_mesh="x.obj", add_floor=False)
    desc = describe_scene(cfg, np.zeros(3), np.array([1.0, 1.0, 2.0]))
    assert desc["floor"] is None


def _run_all() -> None:
    fns = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]
    for fn in fns:
        fn()
        print(f"  PASS {fn.__name__}")
    print(f"\n{len(fns)} testes OK")


if __name__ == "__main__":
    _run_all()
