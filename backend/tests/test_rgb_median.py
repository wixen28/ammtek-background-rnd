import base64
from pathlib import Path

import cv2
import numpy as np
import pytest
from fastapi.testclient import TestClient

from app.main import create_app
from app.processing.background.rgb_median import run_rgb_median, temporal_median
from app.processing.video import store
from app.processing.video.sampling import NoCurrentVideoError
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


def test_temporal_median_odd_frames_per_channel() -> None:
    # 5 frames, each channel with its own value sequence; the median is
    # taken per channel, so the channels must not mix.
    stack = np.zeros((5, 1, 1, 3), dtype=np.uint8)
    stack[:, 0, 0, 0] = [10, 50, 30, 90, 70]  # median 50
    stack[:, 0, 0, 1] = [200, 0, 100, 150, 50]  # median 100
    stack[:, 0, 0, 2] = [5, 5, 5, 255, 255]  # median 5
    background = temporal_median(stack)
    assert background.shape == (1, 1, 3)
    assert background.dtype == np.uint8
    assert background[0, 0].tolist() == [50, 100, 5]


def test_temporal_median_even_frames_averages_middle_pair() -> None:
    # 4 frames: the median is the average of the two middle samples.
    stack = np.zeros((4, 1, 1, 3), dtype=np.uint8)
    stack[:, 0, 0, 0] = [10, 20, 40, 200]  # middle pair 20, 40 -> 30
    stack[:, 0, 0, 1] = [0, 11, 12, 255]  # middle pair 11, 12 -> 11.5 -> 12
    stack[:, 0, 0, 2] = [7, 7, 7, 7]
    background = temporal_median(stack)
    assert background[0, 0].tolist() == [30, 12, 7]


def test_temporal_median_ignores_minority_foreground() -> None:
    # 18 background samples at 10 plus 2 foreground samples at 200: the
    # median stays on the background value with no rejection step.
    stack = np.full((20, 4, 6, 3), 10, dtype=np.uint8)
    stack[5] = 200
    stack[11] = 200
    background = temporal_median(stack)
    assert np.array_equal(background, np.full((4, 6, 3), 10, dtype=np.uint8))


def test_run_rgb_median_all_frames(stored_video: dict) -> None:
    # All 20 frames (even count), fill values 0,5,...,95 -> median 47.5,
    # rounded to 48.
    result = run_rgb_median()
    assert result.use_all_frames is True
    assert result.target_frames is None
    assert result.every_n == 1
    assert result.sampled_frames == 20
    assert result.background.shape == (HEIGHT, WIDTH, 3)
    assert result.background.dtype == np.uint8
    assert float(result.background.mean()) == pytest.approx(47.5, abs=2.0)
    assert result.processing_time_seconds > 0


def test_run_rgb_median_sampled_frames(stored_video: dict) -> None:
    # 20 frames, target 5 (odd count) -> every_n=4 -> samples frames
    # 0,4,8,12,16 (fill values 0,20,40,60,80 -> median 40).
    result = run_rgb_median(target_frames=5, use_all_frames=False)
    assert result.use_all_frames is False
    assert result.target_frames == 5
    assert result.every_n == 4
    assert result.sampled_frames == 5
    assert float(result.background.mean()) == pytest.approx(40.0, abs=2.0)
    assert 1 <= len(result.previews) <= 5
    assert all(p.shape[1] == 160 for p in result.previews)


def test_run_rgb_median_with_resize(stored_video: dict) -> None:
    result = run_rgb_median(target_frames=5, resize=(32, 16), use_all_frames=False)
    assert result.background.shape == (16, 32, 3)


def test_run_rgb_median_without_video(empty_store: None) -> None:
    with pytest.raises(NoCurrentVideoError):
        run_rgb_median()


def test_endpoint_returns_result(stored_video: dict) -> None:
    response = client.post(
        "/api/experiments/rgb-median",
        json={"target_frames": 5, "use_all_frames": False},
    )
    assert response.status_code == 200
    body = response.json()
    assert body["use_all_frames"] is False
    assert body["target_frames"] == 5
    assert body["every_n"] == 4
    assert body["sampled_frames"] == 5
    assert body["resize"] is None
    assert "median" in body["method"]
    assert "rejection_threshold" not in body
    assert body["processing_time_seconds"] > 0

    background = decode_data_url(body["background"])
    assert background.shape == (HEIGHT, WIDTH, 3)
    assert float(background.mean()) == pytest.approx(40.0, abs=2.0)

    assert len(body["previews"]) >= 1
    assert decode_data_url(body["previews"][0]).shape[1] == 160


def test_endpoint_defaults_to_all_frames(stored_video: dict) -> None:
    response = client.post("/api/experiments/rgb-median", json={})
    assert response.status_code == 200
    body = response.json()
    assert body["use_all_frames"] is True
    assert body["target_frames"] is None
    assert body["every_n"] == 1
    assert body["sampled_frames"] == 20


def test_endpoint_without_video_returns_404(empty_store: None) -> None:
    response = client.post("/api/experiments/rgb-median", json={})
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
    response = client.post("/api/experiments/rgb-median", json=body)
    assert response.status_code == 422
