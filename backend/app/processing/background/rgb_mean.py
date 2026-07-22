"""RGB Mean background extraction.

Averages sampled frames per pixel. Static background pixels dominate the
mean; moving foreground objects blur into it. Frames are accumulated into
a running float sum, so memory use is one frame regardless of how many
frames are sampled.
"""

import time
from dataclasses import dataclass

import cv2
import numpy as np

from app.processing.video import store
from app.processing.video.sampling import (
    NoCurrentVideoError,
    sample_current_video,
    spread_every_n,
)

PREVIEW_MAX = 6
PREVIEW_WIDTH = 160


@dataclass
class RgbMeanResult:
    target_frames: int
    every_n: int
    sampled_frames: int
    resize: tuple[int, int] | None
    processing_time_seconds: float
    background: np.ndarray
    previews: list[np.ndarray]


def _thumbnail(frame: np.ndarray) -> np.ndarray:
    height = max(1, round(frame.shape[0] * PREVIEW_WIDTH / frame.shape[1]))
    return cv2.resize(frame, (PREVIEW_WIDTH, height), interpolation=cv2.INTER_AREA)


def run_rgb_mean(
    target_frames: int = 30,
    resize: tuple[int, int] | None = None,
) -> RgbMeanResult:
    record = store.load_current()
    if record is None:
        raise NoCurrentVideoError("No video uploaded yet.")

    every_n = spread_every_n(record["frame_count"], target_frames)
    preview_stride = max(1, target_frames // PREVIEW_MAX)

    start = time.perf_counter()
    total: np.ndarray | None = None
    count = 0
    previews: list[np.ndarray] = []

    frames = sample_current_video(
        every_n=every_n, max_frames=target_frames, resize=resize
    )
    for frame in frames:
        if total is None:
            total = np.zeros(frame.shape, dtype=np.float64)
        total += frame
        if count % preview_stride == 0 and len(previews) < PREVIEW_MAX:
            previews.append(_thumbnail(frame))
        count += 1

    if total is None:
        raise ValueError("No frames could be sampled from the current video.")

    background = (total / count).round().astype(np.uint8)
    elapsed = time.perf_counter() - start

    return RgbMeanResult(
        target_frames=target_frames,
        every_n=every_n,
        sampled_frames=count,
        resize=resize,
        processing_time_seconds=elapsed,
        background=background,
        previews=previews,
    )
