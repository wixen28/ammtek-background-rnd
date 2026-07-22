"""Reusable frame sampling for experiments.

Frames are streamed one at a time from disk — only sampled frames are
decoded, and the video is never loaded into memory as a whole.
"""

from collections.abc import Iterator
from pathlib import Path

import cv2
import numpy as np

from app.processing.video import store
from app.processing.video.inspect import VideoReadError


class NoCurrentVideoError(Exception):
    """Raised when sampling is requested but no video has been uploaded."""


def sample_frames(
    path: Path,
    every_n: int = 1,
    max_frames: int | None = None,
    resize: tuple[int, int] | None = None,
) -> Iterator[np.ndarray]:
    """Yield every ``every_n``-th frame of the video as a BGR ndarray.

    - ``max_frames`` caps the number of yielded frames; fewer are yielded
      if the video ends first.
    - ``resize`` scales each yielded frame to ``(width, height)``.

    Parameters are validated here, not lazily on first iteration.
    """
    if every_n < 1:
        raise ValueError("every_n must be at least 1.")
    if max_frames is not None and max_frames < 1:
        raise ValueError("max_frames must be at least 1.")
    if resize is not None and (resize[0] < 1 or resize[1] < 1):
        raise ValueError("resize width and height must be at least 1.")

    return _iter_frames(path, every_n, max_frames, resize)


def _iter_frames(
    path: Path,
    every_n: int,
    max_frames: int | None,
    resize: tuple[int, int] | None,
) -> Iterator[np.ndarray]:
    capture = cv2.VideoCapture(str(path))
    try:
        if not capture.isOpened():
            raise VideoReadError("File could not be opened as a video.")

        index = 0
        yielded = 0
        while max_frames is None or yielded < max_frames:
            if index % every_n == 0:
                ok, frame = capture.read()
                if not ok:
                    break
                if resize is not None:
                    frame = cv2.resize(frame, resize, interpolation=cv2.INTER_AREA)
                yield frame
                yielded += 1
            else:
                # grab() advances without decoding — cheap frame skipping.
                if not capture.grab():
                    break
            index += 1
    finally:
        capture.release()


def spread_every_n(frame_count: int, target_frames: int) -> int:
    """Sampling interval that spreads ~target_frames across the whole video.

    Combining every_n with max_frames alone would take frames only from the
    start of the video; deriving every_n from the total frame count keeps
    the samples distributed over its full duration.
    """
    if target_frames < 1:
        raise ValueError("target_frames must be at least 1.")
    return max(1, frame_count // target_frames)


def sample_current_video(
    every_n: int = 1,
    max_frames: int | None = None,
    resize: tuple[int, int] | None = None,
) -> Iterator[np.ndarray]:
    """Sample frames from the current working input video."""
    path = store.current_video_path()
    if path is None:
        raise NoCurrentVideoError("No video uploaded yet.")
    return sample_frames(path, every_n=every_n, max_frames=max_frames, resize=resize)
