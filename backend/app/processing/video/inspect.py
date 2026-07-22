"""Read basic metadata from a video file using OpenCV."""

from dataclasses import dataclass
from pathlib import Path

import cv2


class VideoReadError(Exception):
    """Raised when a file cannot be opened or read as a video."""


@dataclass
class VideoMetadata:
    width: int
    height: int
    fps: float
    frame_count: int
    duration_seconds: float


def inspect_video(path: Path) -> VideoMetadata:
    capture = cv2.VideoCapture(str(path))
    try:
        if not capture.isOpened():
            raise VideoReadError("File could not be opened as a video.")

        width = int(capture.get(cv2.CAP_PROP_FRAME_WIDTH))
        height = int(capture.get(cv2.CAP_PROP_FRAME_HEIGHT))
        fps = float(capture.get(cv2.CAP_PROP_FPS))
        frame_count = int(capture.get(cv2.CAP_PROP_FRAME_COUNT))

        # Container metadata can be present but bogus; requiring a decodable
        # first frame filters out non-video files OpenCV nominally "opens".
        ok, _ = capture.read()
        if not ok or width <= 0 or height <= 0:
            raise VideoReadError("File does not contain decodable video frames.")

        duration_seconds = frame_count / fps if fps > 0 else 0.0

        return VideoMetadata(
            width=width,
            height=height,
            fps=fps,
            frame_count=frame_count,
            duration_seconds=duration_seconds,
        )
    finally:
        capture.release()
