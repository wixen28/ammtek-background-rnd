from pathlib import Path

import cv2
import numpy as np
import pytest
from fastapi.testclient import TestClient

from app.main import create_app
from app.processing.video import store
from app.processing.video.pixel_timeline import run_pixel_timeline
from app.processing.video.sampling import NoCurrentVideoError
from tests.conftest import FPS, HEIGHT, WIDTH, make_video

client = TestClient(create_app())


@pytest.fixture
def stored_video(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> dict:
    monkeypatch.setattr(store, "VIDEOS_DIR", tmp_path / "videos")
    return store.save_video(make_video(tmp_path / "in.avi", frames=20), "in.avi")


@pytest.fixture
def empty_store(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(store, "VIDEOS_DIR", tmp_path / "videos")


def test_reads_every_frame(stored_video: dict) -> None:
    result = run_pixel_timeline(3, 5)
    assert result.x == 3
    assert result.y == 5
    assert result.frame_count == 20
    assert [s.frame_index for s in result.frames] == list(range(20))
    assert [s.timestamp_seconds for s in result.frames] == pytest.approx(
        [i / FPS for i in range(20)]
    )
    # Frame i is filled with value i * 5 on all channels.
    for i, sample in enumerate(result.frames):
        assert sample.r == pytest.approx(i * 5, abs=3)
        assert sample.g == pytest.approx(i * 5, abs=3)
        assert sample.b == pytest.approx(i * 5, abs=3)


def test_channel_order_is_rgb(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(store, "VIDEOS_DIR", tmp_path / "videos")
    path = tmp_path / "color.avi"
    writer = cv2.VideoWriter(
        str(path), cv2.VideoWriter_fourcc(*"MJPG"), FPS, (WIDTH, HEIGHT)
    )
    assert writer.isOpened()
    frame = np.zeros((HEIGHT, WIDTH, 3), dtype=np.uint8)
    frame[:, :, 0] = 10  # blue (OpenCV frames are BGR)
    frame[:, :, 1] = 100  # green
    frame[:, :, 2] = 200  # red
    for _ in range(3):
        writer.write(frame)
    writer.release()
    store.save_video(path, "color.avi")

    sample = run_pixel_timeline(10, 10).frames[0]
    assert sample.r == pytest.approx(200, abs=5)
    assert sample.g == pytest.approx(100, abs=5)
    assert sample.b == pytest.approx(10, abs=5)


@pytest.mark.parametrize("x,y", [(WIDTH, 0), (0, HEIGHT), (500, 500)])
def test_out_of_bounds_raises(stored_video: dict, x: int, y: int) -> None:
    with pytest.raises(ValueError):
        run_pixel_timeline(x, y)


def test_without_video_raises(empty_store: None) -> None:
    with pytest.raises(NoCurrentVideoError):
        run_pixel_timeline(0, 0)


def test_endpoint_returns_timeline(stored_video: dict) -> None:
    response = client.get("/api/experiments/pixel-timeline", params={"x": 3, "y": 5})
    assert response.status_code == 200
    body = response.json()
    assert body["x"] == 3
    assert body["y"] == 5
    assert body["frame_count"] == 20
    assert len(body["frames"]) == 20
    first = body["frames"][0]
    assert set(first) == {"frame_index", "timestamp_seconds", "r", "g", "b"}


def test_endpoint_out_of_bounds_returns_422(stored_video: dict) -> None:
    response = client.get(
        "/api/experiments/pixel-timeline", params={"x": WIDTH, "y": 0}
    )
    assert response.status_code == 422


def test_endpoint_negative_coords_return_422(stored_video: dict) -> None:
    response = client.get(
        "/api/experiments/pixel-timeline", params={"x": -1, "y": 0}
    )
    assert response.status_code == 422


def test_endpoint_without_video_returns_404(empty_store: None) -> None:
    response = client.get("/api/experiments/pixel-timeline", params={"x": 0, "y": 0})
    assert response.status_code == 404
