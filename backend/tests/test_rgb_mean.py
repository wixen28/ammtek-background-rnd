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

# Euclidean RGB distance can be at most sqrt(3) * 255 ~= 441.7, so this
# threshold disables rejection and yields the plain mean.
KEEP_ALL = 500.0


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
    result = run_rgb_mean(rejection_thresholds=[KEEP_ALL])
    assert result.use_all_frames is True
    assert result.target_frames is None
    assert result.every_n == 1
    assert result.sampled_frames == 20
    assert len(result.variants) == 1
    variant = result.variants[0]
    assert variant.rejected_fraction == 0.0
    assert variant.fallback_pixels == 0
    assert float(variant.background.mean()) == pytest.approx(47.5, abs=2.0)


def test_run_rgb_mean_computes_mean(stored_video: dict) -> None:
    # 20 frames, target 5 -> every_n=4 -> samples frames 0,4,8,12,16
    # (fill values 0,20,40,60,80 -> mean 40).
    result = run_rgb_mean(
        target_frames=5, use_all_frames=False, rejection_thresholds=[KEEP_ALL]
    )
    assert result.use_all_frames is False
    assert result.target_frames == 5
    assert result.every_n == 4
    assert result.sampled_frames == 5
    background = result.variants[0].background
    assert background.shape == (HEIGHT, WIDTH, 3)
    assert background.dtype == np.uint8
    assert float(background.mean()) == pytest.approx(40.0, abs=2.0)
    assert result.processing_time_seconds > 0
    assert 1 <= len(result.previews) <= 5
    assert all(p.shape[1] == 160 for p in result.previews)


def test_run_rgb_mean_rejects_outliers(stored_video: dict) -> None:
    # Fill values 0,5,...,95; per-pixel median 47.5. Threshold 35 keeps
    # |v - 47.5| <= 35 / sqrt(3) ~= 20.2, i.e. values 30..65 (8 of 20,
    # symmetric around 47.5 -> mean still 47.5). The nearest rejected
    # value (25) is ~4.7 distance units past the cut, comfortably more
    # than MJPG compression noise can shift it.
    result = run_rgb_mean(rejection_thresholds=[35.0])
    variant = result.variants[0]
    assert variant.rejection_threshold == 35.0
    assert variant.rejected_fraction == pytest.approx(0.6, abs=0.05)
    assert float(variant.background.mean()) == pytest.approx(47.5, abs=2.0)


def test_run_rgb_mean_sweeps_thresholds_in_order(stored_video: dict) -> None:
    # One decode pass, one variant per threshold, request order preserved.
    # Fill values 0,5,...,95 around median 47.5: threshold 35 keeps 8 of 20
    # samples, threshold 60 keeps 14, KEEP_ALL keeps everything. A wider
    # threshold always keeps a superset, so the rejected share must fall.
    result = run_rgb_mean(rejection_thresholds=[35.0, 60.0, KEEP_ALL])
    assert [v.rejection_threshold for v in result.variants] == [35.0, 60.0, KEEP_ALL]
    fractions = [v.rejected_fraction for v in result.variants]
    assert fractions == pytest.approx([0.6, 0.3, 0.0], abs=0.05)
    assert result.sampled_frames == 20  # shared by every variant
    # Each variant owns its buffer rather than aliasing one shared image.
    assert len({id(v.background) for v in result.variants}) == 3


def test_run_rgb_mean_sweep_matches_individual_runs(stored_video: dict) -> None:
    # A swept variant must be identical to the same threshold run alone —
    # sharing the median and distance matrix must not change the result.
    thresholds = [35.0, 60.0, KEEP_ALL]
    swept = run_rgb_mean(rejection_thresholds=thresholds)
    for threshold, variant in zip(thresholds, swept.variants, strict=True):
        alone = run_rgb_mean(rejection_thresholds=[threshold]).variants[0]
        assert np.array_equal(variant.background, alone.background)
        assert variant.rejected_fraction == alone.rejected_fraction
        assert variant.fallback_pixels == alone.fallback_pixels


def test_run_rgb_mean_with_resize(stored_video: dict) -> None:
    result = run_rgb_mean(target_frames=5, resize=(32, 16), use_all_frames=False)
    assert all(v.background.shape == (16, 32, 3) for v in result.variants)


def test_run_rgb_mean_defaults_to_preset_sweep(stored_video: dict) -> None:
    result = run_rgb_mean()
    assert [v.rejection_threshold for v in result.variants] == [20.0, 30.0, 50.0]


def test_run_rgb_mean_rejects_negative_threshold(stored_video: dict) -> None:
    with pytest.raises(ValueError):
        run_rgb_mean(rejection_thresholds=[30.0, -1.0])


def test_run_rgb_mean_rejects_empty_thresholds(stored_video: dict) -> None:
    with pytest.raises(ValueError):
        run_rgb_mean(rejection_thresholds=[])


def test_run_rgb_mean_rejects_too_many_thresholds(stored_video: dict) -> None:
    with pytest.raises(ValueError):
        run_rgb_mean(rejection_thresholds=[float(i) for i in range(20)])


def test_run_rgb_mean_without_video(empty_store: None) -> None:
    with pytest.raises(NoCurrentVideoError):
        run_rgb_mean()


def test_endpoint_returns_result(stored_video: dict) -> None:
    response = client.post(
        "/api/experiments/rgb-mean",
        json={
            "target_frames": 5,
            "use_all_frames": False,
            "rejection_thresholds": [500],
        },
    )
    assert response.status_code == 200
    body = response.json()
    assert body["use_all_frames"] is False
    assert body["target_frames"] == 5
    assert body["every_n"] == 4
    assert body["sampled_frames"] == 5
    assert body["resize"] is None
    assert "median" in body["method"]
    assert body["processing_time_seconds"] > 0
    # Run-level fields are reported once, not per variant.
    assert "background" not in body
    assert "rejection_threshold" not in body

    assert len(body["variants"]) == 1
    variant = body["variants"][0]
    assert variant["rejection_threshold"] == 500
    assert variant["rejected_fraction"] == 0.0
    assert variant["fallback_pixels"] == 0

    background = decode_data_url(variant["background"])
    assert background.shape == (HEIGHT, WIDTH, 3)
    assert float(background.mean()) == pytest.approx(40.0, abs=2.0)

    assert len(body["previews"]) >= 1
    assert decode_data_url(body["previews"][0]).shape[1] == 160


def test_endpoint_returns_one_variant_per_threshold(stored_video: dict) -> None:
    # Three thresholds, one shared run: previews and timing are reported
    # once, and each variant carries its own decodable background.
    response = client.post(
        "/api/experiments/rgb-mean",
        json={"rejection_thresholds": [35, 60, 500]},
    )
    assert response.status_code == 200
    body = response.json()
    assert [v["rejection_threshold"] for v in body["variants"]] == [35, 60, 500]
    assert body["sampled_frames"] == 20
    for variant in body["variants"]:
        assert decode_data_url(variant["background"]).shape == (HEIGHT, WIDTH, 3)


def test_endpoint_defaults_to_all_frames(stored_video: dict) -> None:
    response = client.post("/api/experiments/rgb-mean", json={})
    assert response.status_code == 200
    body = response.json()
    assert body["use_all_frames"] is True
    assert body["target_frames"] is None
    assert body["every_n"] == 1
    assert body["sampled_frames"] == 20
    assert [v["rejection_threshold"] for v in body["variants"]] == [20.0, 30.0, 50.0]


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
        {"rejection_thresholds": [30, -5]},
        {"rejection_thresholds": []},
        {"rejection_thresholds": [10, 20, 30, 40, 50, 60]},
    ],
)
def test_endpoint_invalid_parameters(stored_video: dict, body: dict) -> None:
    response = client.post("/api/experiments/rgb-mean", json=body)
    assert response.status_code == 422
