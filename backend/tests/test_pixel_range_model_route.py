"""The per-pixel range model over HTTP.

What is worth testing at this level is the contract the browser depends on:
the model's grid matches the grid single frames are served at, and the bound
planes survive the PNG round-trip byte for byte. A lossy encoding would move
every box by a few values and the client would classify against something the
backend never derived.
"""

import base64
from pathlib import Path

import cv2
import numpy as np
import pytest
from fastapi.testclient import TestClient

from app.main import create_app
from app.processing.video import store
from tests.conftest import make_video

client = TestClient(create_app())


@pytest.fixture(autouse=True)
def isolated_store(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    videos_dir = tmp_path / "videos"
    monkeypatch.setattr(store, "VIDEOS_DIR", videos_dir)
    return videos_dir


def upload(path: Path) -> dict:
    with path.open("rb") as f:
        return client.post(
            "/api/videos", files={"file": ("sample.avi", f, "video/x-msvideo")}
        ).json()


def decode(data_url: str) -> np.ndarray:
    payload = base64.b64decode(data_url.split(",", 1)[1])
    return cv2.imdecode(np.frombuffer(payload, np.uint8), cv2.IMREAD_COLOR)


def build(**overrides) -> dict:
    body = {"target_frames": 10, "max_width": 32, "max_ranges": 2} | overrides
    response = client.post("/api/experiments/pixel-range-model", json=body)
    assert response.status_code == 200, response.text
    return response.json()


def test_model_grid_matches_the_frame_grid(tmp_path: Path) -> None:
    upload(make_video(tmp_path / "in.avi"))
    model = build()

    frame = client.get(
        "/api/videos/current/frame", params={"frame_index": 0, "max_width": 32}
    ).json()
    assert (model["width"], model["height"]) == (frame["width"], frame["height"])
    # The source is reported too, so a client can map a full-resolution pixel
    # coordinate onto the model.
    assert (model["source_width"], model["source_height"]) == (
        frame["source_width"],
        frame["source_height"],
    )


def test_planes_round_trip_losslessly_and_bound_each_pixel(tmp_path: Path) -> None:
    upload(make_video(tmp_path / "in.avi"))
    model = build()

    assert len(model["ranges"]) == 2
    for plane in model["ranges"]:
        lower = decode(plane["lower"])
        upper = decode(plane["upper"])
        assert lower.shape == (model["height"], model["width"], 3)
        assert upper.shape == lower.shape
        # Every pixel either has a real box (lower <= upper on all channels) or
        # the empty one the client rejects against.
        real = (lower <= upper).all(axis=2)
        empty = (lower == 255).all(axis=2) & (upper == 0).all(axis=2)
        assert (real | empty).all()
        assert int(real.sum()) == plane["pixels"]


def test_signal_and_width_are_reported_back(tmp_path: Path) -> None:
    upload(make_video(tmp_path / "in.avi"))
    model = build(signal=0.7, range_width=0.8, tolerance=3, max_ranges=3)

    assert model["signal"] == 0.7
    assert model["range_width"] == 0.8
    assert model["tolerance"] == 3
    assert model["max_ranges"] == 3
    assert len(model["ranges"]) == 3
    assert 0 <= model["accepted_sample_share"] <= 1
    assert sum(model["pixels_by_range_count"]) <= model["width"] * model["height"]


def test_tolerance_widens_every_box(tmp_path: Path) -> None:
    upload(make_video(tmp_path / "in.avi"))
    bare = decode(build(tolerance=0)["ranges"][0]["upper"])
    padded = decode(build(tolerance=6)["ranges"][0]["upper"])

    # Upper bounds can only rise, or stay put where they already hit 255.
    assert (padded >= bare).all()
    assert (padded > bare).any()


def test_invalid_settings_are_rejected(tmp_path: Path) -> None:
    upload(make_video(tmp_path / "in.avi"))
    for body in (
        {"signal": 0},
        {"signal": 1.5},
        {"range_width": 0},
        {"max_ranges": 4},
        {"tolerance": -1},
        {"target_frames": 1},
    ):
        response = client.post("/api/experiments/pixel-range-model", json=body)
        assert response.status_code == 422, body


def test_without_a_video_returns_404() -> None:
    response = client.post("/api/experiments/pixel-range-model", json={})
    assert response.status_code == 404
