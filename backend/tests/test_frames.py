import base64
from pathlib import Path

import cv2
import numpy as np
import pytest
from fastapi.testclient import TestClient

from app.main import create_app
from app.processing.video import store
from app.processing.video.frames import read_current_frame, read_frame_at
from app.processing.video.sampling import NoCurrentVideoError
from tests.conftest import HEIGHT, WIDTH, make_video

client = TestClient(create_app())

FRAMES = 20


@pytest.fixture
def stored_video(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> dict:
    monkeypatch.setattr(store, "VIDEOS_DIR", tmp_path / "videos")
    return store.save_video(
        make_video(tmp_path / "in.avi", frames=FRAMES), "in.avi"
    )


@pytest.fixture
def empty_store(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(store, "VIDEOS_DIR", tmp_path / "videos")


def decode_data_url(data_url: str) -> np.ndarray:
    prefix, payload = data_url.split(",", 1)
    assert prefix.startswith("data:image/")
    raw = np.frombuffer(base64.b64decode(payload), dtype=np.uint8)
    return cv2.imdecode(raw, cv2.IMREAD_COLOR)


def test_read_frame_at_returns_the_requested_frame(stored_video: dict) -> None:
    # conftest fills frame i with value i * 5, so the fill identifies it.
    path = store.current_video_path()
    assert path is not None
    for index in (0, 7, 19):
        frame = read_frame_at(path, index)
        assert frame.shape == (HEIGHT, WIDTH, 3)
        assert float(frame.mean()) == pytest.approx(index * 5, abs=2.0)


def test_read_frame_at_rejects_negative_index(stored_video: dict) -> None:
    path = store.current_video_path()
    assert path is not None
    with pytest.raises(ValueError):
        read_frame_at(path, -1)


def test_read_current_frame_first_and_last(stored_video: dict) -> None:
    first = read_current_frame(0)
    assert first.frame_index == 0
    assert first.frame_count == FRAMES
    assert float(first.image.mean()) == pytest.approx(0, abs=2.0)

    last = read_current_frame(FRAMES - 1)
    assert last.frame_index == FRAMES - 1
    assert float(last.image.mean()) == pytest.approx((FRAMES - 1) * 5, abs=2.0)


def test_read_current_frame_out_of_range(stored_video: dict) -> None:
    with pytest.raises(ValueError):
        read_current_frame(FRAMES)


def test_read_current_frame_without_video(empty_store: None) -> None:
    with pytest.raises(NoCurrentVideoError):
        read_current_frame(0)


def test_read_current_frame_downscales_above_max_width(stored_video: dict) -> None:
    # Source is 64 x 48; 32 halves it and the aspect ratio is preserved.
    result = read_current_frame(0, max_width=32)
    assert (result.width, result.height) == (32, 24)
    assert result.image.shape == (24, 32, 3)
    assert (result.source_width, result.source_height) == (WIDTH, HEIGHT)


def test_read_current_frame_never_upscales(stored_video: dict) -> None:
    result = read_current_frame(0, max_width=4096)
    assert (result.width, result.height) == (WIDTH, HEIGHT)
    assert (result.source_width, result.source_height) == (WIDTH, HEIGHT)


def test_endpoint_returns_frame(stored_video: dict) -> None:
    response = client.get("/api/videos/current/frame", params={"frame_index": 7})
    assert response.status_code == 200
    body = response.json()
    assert body["frame_index"] == 7
    assert body["frame_count"] == FRAMES
    assert body["width"] == WIDTH
    assert body["height"] == HEIGHT
    assert body["source_width"] == WIDTH
    assert body["source_height"] == HEIGHT

    frame = decode_data_url(body["frame"])
    assert frame.shape == (HEIGHT, WIDTH, 3)
    assert float(frame.mean()) == pytest.approx(35, abs=2.0)


def test_endpoint_defaults_to_first_frame(stored_video: dict) -> None:
    response = client.get("/api/videos/current/frame")
    assert response.status_code == 200
    assert response.json()["frame_index"] == 0


def test_endpoint_last_frame(stored_video: dict) -> None:
    response = client.get(
        "/api/videos/current/frame", params={"frame_index": FRAMES - 1}
    )
    assert response.status_code == 200
    assert response.json()["frame_index"] == FRAMES - 1


def test_endpoint_resizes(stored_video: dict) -> None:
    response = client.get(
        "/api/videos/current/frame", params={"frame_index": 0, "max_width": 32}
    )
    assert response.status_code == 200
    body = response.json()
    assert (body["width"], body["height"]) == (32, 24)
    assert decode_data_url(body["frame"]).shape == (24, 32, 3)


def test_endpoint_out_of_range_returns_422(stored_video: dict) -> None:
    response = client.get(
        "/api/videos/current/frame", params={"frame_index": FRAMES}
    )
    assert response.status_code == 422


def test_endpoint_without_video_returns_404(empty_store: None) -> None:
    response = client.get("/api/videos/current/frame", params={"frame_index": 0})
    assert response.status_code == 404


@pytest.mark.parametrize("params", [{"frame_index": -1}, {"max_width": 0}])
def test_endpoint_invalid_parameters(stored_video: dict, params: dict) -> None:
    response = client.get("/api/videos/current/frame", params=params)
    assert response.status_code == 422
