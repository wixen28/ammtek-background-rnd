import base64
from pathlib import Path

import cv2
import numpy as np
import pytest
from fastapi.testclient import TestClient

from app.main import create_app
from app.processing.background.rgb_mean import run_rgb_mean
from app.processing.video import store
from app.processing.video.sampling import NoCurrentVideoError, spread_every_n
from tests.conftest import HEIGHT, WIDTH, make_video

client = TestClient(create_app())


@pytest.fixture
def stored_video(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> dict:
    monkeypatch.setattr(store, "VIDEOS_DIR", tmp_path / "videos")
    return store.save_video(make_video(tmp_path / "in.avi", frames=20), "in.avi")


@pytest.fixture
def empty_store(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(store, "VIDEOS_DIR", tmp_path / "videos")


def decode_data_url(data_url: str) -> np.ndarray:
    prefix, payload = data_url.split(",", 1)
    assert prefix.startswith("data:image/")
    raw = np.frombuffer(base64.b64decode(payload), dtype=np.uint8)
    return cv2.imdecode(raw, cv2.IMREAD_COLOR)


def test_spread_every_n() -> None:
    assert spread_every_n(219, 30) == 7
    assert spread_every_n(20, 100) == 1  # fewer frames than requested
    assert spread_every_n(1000, 10) == 100
    with pytest.raises(ValueError):
        spread_every_n(100, 0)


def test_run_rgb_mean_all_frames(stored_video: dict) -> None:
    # All 20 frames, fill values 0,5,...,95 -> mean 47.5.
    result = run_rgb_mean()
    assert result.use_all_frames is True
    assert result.target_frames is None
    assert result.every_n == 1
    assert result.sampled_frames == 20
    assert float(result.background.mean()) == pytest.approx(47.5, abs=2.0)


def test_run_rgb_mean_computes_mean(stored_video: dict) -> None:
    # 20 frames, target 5 -> every_n=4 -> samples frames 0,4,8,12,16
    # (fill values 0,20,40,60,80 -> mean 40).
    result = run_rgb_mean(target_frames=5, use_all_frames=False)
    assert result.use_all_frames is False
    assert result.target_frames == 5
    assert result.every_n == 4
    assert result.sampled_frames == 5
    assert result.background.shape == (HEIGHT, WIDTH, 3)
    assert result.background.dtype == np.uint8
    assert float(result.background.mean()) == pytest.approx(40.0, abs=2.0)
    assert result.processing_time_seconds > 0
    assert 1 <= len(result.previews) <= 5
    assert all(p.shape[1] == 160 for p in result.previews)


def test_run_rgb_mean_with_resize(stored_video: dict) -> None:
    result = run_rgb_mean(target_frames=5, resize=(32, 16), use_all_frames=False)
    assert result.background.shape == (16, 32, 3)


def test_run_rgb_mean_without_video(empty_store: None) -> None:
    with pytest.raises(NoCurrentVideoError):
        run_rgb_mean()


def test_endpoint_returns_result(stored_video: dict) -> None:
    response = client.post(
        "/api/experiments/rgb-mean",
        json={"target_frames": 5, "use_all_frames": False},
    )
    assert response.status_code == 200
    body = response.json()
    assert body["use_all_frames"] is False
    assert body["target_frames"] == 5
    assert body["every_n"] == 4
    assert body["sampled_frames"] == 5
    assert body["resize"] is None
    assert body["processing_time_seconds"] > 0

    background = decode_data_url(body["background"])
    assert background.shape == (HEIGHT, WIDTH, 3)
    assert float(background.mean()) == pytest.approx(40.0, abs=2.0)

    assert len(body["previews"]) >= 1
    assert decode_data_url(body["previews"][0]).shape[1] == 160


def test_endpoint_defaults_to_all_frames(stored_video: dict) -> None:
    response = client.post("/api/experiments/rgb-mean", json={})
    assert response.status_code == 200
    body = response.json()
    assert body["use_all_frames"] is True
    assert body["target_frames"] is None
    assert body["every_n"] == 1
    assert body["sampled_frames"] == 20


def test_endpoint_without_video_returns_404(empty_store: None) -> None:
    response = client.post("/api/experiments/rgb-mean", json={})
    assert response.status_code == 404


@pytest.mark.parametrize(
    "body",
    [
        {"target_frames": 0},
        {"target_frames": -3},
        {"resize": [0, 16]},
        {"resize": [32, -1]},
    ],
)
def test_endpoint_invalid_parameters(stored_video: dict, body: dict) -> None:
    response = client.post("/api/experiments/rgb-mean", json=body)
    assert response.status_code == 422
