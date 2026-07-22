from pathlib import Path

import numpy as np
import pytest

from app.processing.video import store
from app.processing.video.inspect import VideoReadError
from app.processing.video.sampling import (
    NoCurrentVideoError,
    sample_current_video,
    sample_frames,
)
from tests.conftest import HEIGHT, WIDTH, make_video


@pytest.fixture
def video(tmp_path: Path) -> Path:
    return make_video(tmp_path / "sample.avi", frames=20)


def frame_values(frames: list[np.ndarray]) -> list[float]:
    """Mean pixel value per frame — encodes the source frame index (i * 5)."""
    return [float(f.mean()) for f in frames]


def assert_sampled_indices(frames: list[np.ndarray], expected: list[int]) -> None:
    assert frame_values(frames) == pytest.approx(
        [i * 5 for i in expected], abs=2.0
    )


def test_every_nth_frame(video: Path) -> None:
    frames = list(sample_frames(video, every_n=3))
    assert len(frames) == 7  # frames 0, 3, 6, 9, 12, 15, 18
    assert_sampled_indices(frames, [0, 3, 6, 9, 12, 15, 18])


def test_default_samples_all_frames(video: Path) -> None:
    frames = list(sample_frames(video))
    assert len(frames) == 20
    assert frames[0].shape == (HEIGHT, WIDTH, 3)
    assert frames[0].dtype == np.uint8


def test_max_frames_limit(video: Path) -> None:
    frames = list(sample_frames(video, every_n=2, max_frames=4))
    assert_sampled_indices(frames, [0, 2, 4, 6])


def test_resize(video: Path) -> None:
    frames = list(sample_frames(video, max_frames=2, resize=(32, 16)))
    assert all(f.shape == (16, 32, 3) for f in frames)


def test_short_video(tmp_path: Path) -> None:
    short = make_video(tmp_path / "short.avi", frames=3)
    frames = list(sample_frames(short, every_n=2))
    assert_sampled_indices(frames, [0, 2])


def test_max_frames_beyond_available(video: Path) -> None:
    frames = list(sample_frames(video, every_n=5, max_frames=100))
    assert_sampled_indices(frames, [0, 5, 10, 15])


@pytest.mark.parametrize(
    "kwargs",
    [
        {"every_n": 0},
        {"every_n": -2},
        {"max_frames": 0},
        {"max_frames": -1},
        {"resize": (0, 16)},
        {"resize": (32, -1)},
    ],
)
def test_invalid_parameters_raise_eagerly(video: Path, kwargs: dict) -> None:
    with pytest.raises(ValueError):
        sample_frames(video, **kwargs)  # no iteration — must raise at call time


def test_unreadable_file_raises(tmp_path: Path) -> None:
    bogus = tmp_path / "notes.txt"
    bogus.write_text("this is not a video")
    with pytest.raises(VideoReadError):
        list(sample_frames(bogus))


def test_sample_current_video(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(store, "VIDEOS_DIR", tmp_path / "videos")
    store.save_video(make_video(tmp_path / "in.avi", frames=6), "in.avi")

    frames = list(sample_current_video(every_n=2))
    assert_sampled_indices(frames, [0, 2, 4])


def test_sample_current_video_without_upload(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(store, "VIDEOS_DIR", tmp_path / "videos")
    with pytest.raises(NoCurrentVideoError):
        sample_current_video()
