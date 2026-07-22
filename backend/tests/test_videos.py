import json
from pathlib import Path

import cv2
import numpy as np
import pytest
from fastapi.testclient import TestClient

from app.main import create_app
from app.processing.video import store

client = TestClient(create_app())

WIDTH, HEIGHT, FPS, FRAMES = 64, 48, 10.0, 20


def make_video(path: Path, frames: int = FRAMES) -> Path:
    writer = cv2.VideoWriter(
        str(path), cv2.VideoWriter_fourcc(*"MJPG"), FPS, (WIDTH, HEIGHT)
    )
    assert writer.isOpened()
    for i in range(frames):
        frame = np.full((HEIGHT, WIDTH, 3), i * 10 % 255, dtype=np.uint8)
        writer.write(frame)
    writer.release()
    return path


@pytest.fixture(autouse=True)
def isolated_store(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    videos_dir = tmp_path / "videos"
    monkeypatch.setattr(store, "VIDEOS_DIR", videos_dir)
    return videos_dir


def upload(path: Path, name: str = "sample.avi"):
    with path.open("rb") as f:
        return client.post(
            "/api/videos", files={"file": (name, f, "video/x-msvideo")}
        )


def test_upload_returns_id_and_metadata(tmp_path: Path) -> None:
    response = upload(make_video(tmp_path / "in.avi"))
    assert response.status_code == 200
    body = response.json()
    assert body["video_id"]
    assert body["filename"] == "sample.avi"
    assert body["width"] == WIDTH
    assert body["height"] == HEIGHT
    assert body["fps"] == pytest.approx(FPS)
    assert body["frame_count"] == FRAMES
    assert body["duration_seconds"] == pytest.approx(FRAMES / FPS)


def test_upload_persists_file_and_metadata(
    tmp_path: Path, isolated_store: Path
) -> None:
    body = upload(make_video(tmp_path / "in.avi")).json()
    video_file = isolated_store / f"{body['video_id']}.avi"
    assert video_file.exists()
    assert video_file.stat().st_size > 0
    saved = json.loads((isolated_store / "metadata.json").read_text())
    assert saved == body


def test_new_upload_replaces_previous(
    tmp_path: Path, isolated_store: Path
) -> None:
    first = upload(make_video(tmp_path / "a.avi"), name="a.avi").json()
    second = upload(make_video(tmp_path / "b.avi"), name="b.avi").json()

    assert second["video_id"] != first["video_id"]
    assert not (isolated_store / f"{first['video_id']}.avi").exists()
    assert (isolated_store / f"{second['video_id']}.avi").exists()
    assert client.get("/api/videos/current").json()["video_id"] == second["video_id"]


def test_invalid_file_returns_422_and_keeps_store(
    tmp_path: Path, isolated_store: Path
) -> None:
    previous = upload(make_video(tmp_path / "in.avi")).json()

    response = client.post(
        "/api/videos",
        files={"file": ("notes.txt", b"this is not a video", "text/plain")},
    )
    assert response.status_code == 422

    assert client.get("/api/videos/current").json() == previous
    assert (isolated_store / f"{previous['video_id']}.avi").exists()


def test_current_without_upload_returns_404() -> None:
    response = client.get("/api/videos/current")
    assert response.status_code == 404
