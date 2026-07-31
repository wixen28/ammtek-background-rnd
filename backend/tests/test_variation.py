import base64
from pathlib import Path

import cv2
import numpy as np
import pytest
from fastapi.testclient import TestClient

from app.main import create_app
from app.processing.background.rgb_mean import run_rgb_mean
from app.processing.background.variation import (
    deviation_range,
    run_background_variation,
    to_grayscale_mask,
)
from app.processing.video import store
from app.processing.video.sampling import NoCurrentVideoError
from tests.conftest import HEIGHT, WIDTH, make_video

client = TestClient(create_app())

THRESHOLD = 30.0


@pytest.fixture
def stored_video(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> dict:
    monkeypatch.setattr(store, "VIDEOS_DIR", tmp_path / "videos")
    return store.save_video(make_video(tmp_path / "in.avi", frames=20), "in.avi")


@pytest.fixture
def static_video(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> dict:
    """A one-frame video: nothing can vary, so every deviation is zero."""
    monkeypatch.setattr(store, "VIDEOS_DIR", tmp_path / "videos")
    return store.save_video(make_video(tmp_path / "one.avi", frames=1), "one.avi")


@pytest.fixture
def empty_store(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(store, "VIDEOS_DIR", tmp_path / "videos")


def decode_data_url(data_url: str, flags: int = cv2.IMREAD_COLOR) -> np.ndarray:
    prefix, payload = data_url.split(",", 1)
    assert prefix.startswith("data:image/")
    raw = np.frombuffer(base64.b64decode(payload), dtype=np.uint8)
    return cv2.imdecode(raw, flags)


# --- to_grayscale_mask ------------------------------------------------------


def test_to_grayscale_mask_scales_linearly_from_zero() -> None:
    # Anchored at true zero, not at the observed minimum: 5 of a maximum of
    # 10 is mid gray even though no pixel is darker than 2.
    deviation = np.array([[2.0, 5.0, 10.0]], dtype=np.float32)
    mask = to_grayscale_mask(deviation, 10.0)
    assert mask.dtype == np.uint8
    assert mask.tolist() == [[51, 128, 255]]


def test_to_grayscale_mask_is_monotonic() -> None:
    deviation = np.array([[0.0, 1.0, 3.0, 7.0, 12.0]], dtype=np.float32)
    mask = to_grayscale_mask(deviation, 12.0)
    assert mask[0].tolist() == sorted(mask[0].tolist())
    assert mask[0, 0] == 0  # black means no surviving variation
    assert mask[0, -1] == 255  # brightest is the run's largest deviation


def test_to_grayscale_mask_without_variation_is_black() -> None:
    deviation = np.zeros((2, 3), dtype=np.float32)
    mask = to_grayscale_mask(deviation, 0.0)
    assert mask.shape == (2, 3)
    assert not mask.any()


# --- deviation_range -------------------------------------------------------


def test_deviation_range_ignores_pixels_with_no_kept_samples() -> None:
    # The fallback pixel sits at 0.0 without ever having had an inlier, so
    # it must not drag the reported minimum down to zero.
    deviation = np.array([[4.0, 0.0, 9.0]], dtype=np.float32)
    kept_counts = np.array([[7, 0, 3]], dtype=np.int32)
    assert deviation_range(deviation, kept_counts) == (4.0, 9.0)


def test_deviation_range_without_any_kept_samples() -> None:
    deviation = np.zeros((2, 2), dtype=np.float32)
    kept_counts = np.zeros((2, 2), dtype=np.int32)
    assert deviation_range(deviation, kept_counts) == (0.0, 0.0)


# --- run_background_variation ---------------------------------------------


def test_run_background_variation_all_frames(stored_video: dict) -> None:
    result = run_background_variation(rejection_threshold=THRESHOLD)
    assert result.use_all_frames is True
    assert result.target_frames is None
    assert result.every_n == 1
    assert result.sampled_frames == 20
    assert result.rejection_threshold == THRESHOLD
    assert result.processing_time_seconds > 0
    assert result.background.shape == (HEIGHT, WIDTH, 3)
    # Single channel: the mask is one scalar per pixel, not an RGB image.
    assert result.variation_mask.shape == (HEIGHT, WIDTH)
    assert result.variation_mask.dtype == np.uint8
    assert 1 <= len(result.previews) <= 6


def test_run_background_variation_reuses_the_rgb_mean_background(
    stored_video: dict,
) -> None:
    # Both experiments run the same shared pass, so at the same threshold
    # the reference background must be identical, not merely similar.
    variation = run_background_variation(rejection_threshold=THRESHOLD)
    mean = run_rgb_mean(rejection_thresholds=[THRESHOLD])
    assert np.array_equal(variation.background, mean.variants[0].background)
    assert variation.rejected_fraction == mean.variants[0].rejected_fraction
    assert variation.fallback_pixels == mean.variants[0].fallback_pixels


def test_run_background_variation_reports_a_deviation_range(
    stored_video: dict,
) -> None:
    result = run_background_variation(rejection_threshold=THRESHOLD)
    assert 0.0 <= result.deviation_min <= result.deviation_max
    # Frames step by 5, so the kept samples around the median genuinely
    # differ and the surviving variation cannot be zero.
    assert result.deviation_max > 0
    # The brightest pixel is the run's maximum by construction.
    assert result.variation_mask.max() == 255


def test_run_background_variation_widening_the_threshold_admits_variation(
    stored_video: dict,
) -> None:
    tight = run_background_variation(rejection_threshold=20.0)
    wide = run_background_variation(rejection_threshold=200.0)
    assert wide.deviation_max > tight.deviation_max
    assert wide.rejected_fraction < tight.rejected_fraction


def test_run_background_variation_without_variation(static_video: dict) -> None:
    # One frame: the median is that frame, every sample sits on it, so the
    # mask is uniformly black and the range collapses to zero.
    result = run_background_variation(rejection_threshold=THRESHOLD)
    assert result.sampled_frames == 1
    assert result.deviation_min == 0.0
    assert result.deviation_max == 0.0
    assert not result.variation_mask.any()
    assert result.fallback_pixels == 0


def test_run_background_variation_samples_evenly(stored_video: dict) -> None:
    result = run_background_variation(
        target_frames=5, use_all_frames=False, rejection_threshold=THRESHOLD
    )
    assert result.use_all_frames is False
    assert result.target_frames == 5
    assert result.every_n == 4
    assert result.sampled_frames == 5


def test_run_background_variation_with_resize(stored_video: dict) -> None:
    result = run_background_variation(resize=(32, 16), rejection_threshold=THRESHOLD)
    assert result.background.shape == (16, 32, 3)
    assert result.variation_mask.shape == (16, 32)


def test_run_background_variation_rejects_negative_threshold(
    stored_video: dict,
) -> None:
    with pytest.raises(ValueError):
        run_background_variation(rejection_threshold=-1.0)


def test_run_background_variation_without_video(empty_store: None) -> None:
    with pytest.raises(NoCurrentVideoError):
        run_background_variation()


# --- endpoint --------------------------------------------------------------


def test_endpoint_returns_result(stored_video: dict) -> None:
    response = client.post(
        "/api/experiments/background-variation",
        json={"rejection_threshold": THRESHOLD},
    )
    assert response.status_code == 200
    body = response.json()

    assert body["use_all_frames"] is True
    assert body["target_frames"] is None
    assert body["every_n"] == 1
    assert body["sampled_frames"] == 20
    assert body["resize"] is None
    assert "deviation" in body["method"]
    assert body["processing_time_seconds"] > 0
    assert body["rejection_threshold"] == THRESHOLD
    assert 0.0 <= body["rejected_fraction"] <= 1.0
    assert body["fallback_pixels"] >= 0
    assert 0.0 <= body["deviation_min"] <= body["deviation_max"]

    background = decode_data_url(body["background"])
    assert background.shape == (HEIGHT, WIDTH, 3)

    mask = decode_data_url(body["variation_mask"], cv2.IMREAD_UNCHANGED)
    assert mask.shape == (HEIGHT, WIDTH)  # encoded as single-channel gray
    assert mask.dtype == np.uint8

    assert len(body["previews"]) >= 1
    assert decode_data_url(body["previews"][0]).shape[1] == 160


def test_endpoint_defaults(stored_video: dict) -> None:
    response = client.post("/api/experiments/background-variation", json={})
    assert response.status_code == 200
    assert response.json()["rejection_threshold"] == 30.0


def test_endpoint_without_video_returns_404(empty_store: None) -> None:
    response = client.post("/api/experiments/background-variation", json={})
    assert response.status_code == 404


@pytest.mark.parametrize(
    "body",
    [
        {"target_frames": 0},
        {"target_frames": -3},
        {"resize": [0, 16]},
        {"resize": [32, -1]},
        {"rejection_threshold": -1},
    ],
)
def test_endpoint_invalid_parameters(stored_video: dict, body: dict) -> None:
    response = client.post("/api/experiments/background-variation", json=body)
    assert response.status_code == 422
