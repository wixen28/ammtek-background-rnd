"""RGB Median background extraction.

The per-channel temporal median is used directly as the background: for
each pixel, the R, G and B values are the medians of that channel across
the sampled frames. Foreground passes that cover a pixel for well under
half of the frames cannot move the median, so no outlier rejection is
needed — this is the comparison experiment for RGB Mean + rejection,
where the same median only serves as an internal reference.

Like RGB Mean, the median needs every sample at once, so all sampled
frames are stacked in memory (N × H × W × 3 uint8).
"""

import time
from dataclasses import dataclass

import numpy as np

from app.processing.background.previews import PREVIEW_MAX, thumbnail
from app.processing.video import store
from app.processing.video.sampling import (
    NoCurrentVideoError,
    sample_current_video,
    spread_every_n,
)

METHOD = (
    "Per-channel temporal median across the sampled frames, used directly "
    "as the background; no outlier rejection."
)


@dataclass
class RgbMedianResult:
    use_all_frames: bool
    target_frames: int | None  # None in all-frames mode
    every_n: int
    sampled_frames: int
    resize: tuple[int, int] | None
    processing_time_seconds: float
    background: np.ndarray
    previews: list[np.ndarray]


def temporal_median(stack: np.ndarray) -> np.ndarray:
    """Per-channel temporal median of a (frames, height, width, channels) stack.

    With an even number of frames each value is the average of the two
    middle samples, rounded to uint8. Partitions ``stack`` in place
    (overwrite_input) so no frame-stack-sized copy is made.
    """
    median = np.median(stack, axis=0, overwrite_input=True)
    return median.round().astype(np.uint8)


def run_rgb_median(
    target_frames: int = 30,
    resize: tuple[int, int] | None = None,
    use_all_frames: bool = True,
) -> RgbMedianResult:
    record = store.load_current()
    if record is None:
        raise NoCurrentVideoError("No video uploaded yet.")

    if use_all_frames:
        every_n = 1
        max_frames = None
        expected_frames = record["frame_count"]
    else:
        every_n = spread_every_n(record["frame_count"], target_frames)
        max_frames = target_frames
        expected_frames = target_frames
    preview_stride = max(1, expected_frames // PREVIEW_MAX)

    start = time.perf_counter()
    frames: list[np.ndarray] = []
    previews: list[np.ndarray] = []

    for frame in sample_current_video(
        every_n=every_n, max_frames=max_frames, resize=resize
    ):
        if len(frames) % preview_stride == 0 and len(previews) < PREVIEW_MAX:
            previews.append(thumbnail(frame))
        frames.append(frame)

    if not frames:
        raise ValueError("No frames could be sampled from the current video.")

    stack = np.stack(frames)
    frames.clear()
    count = stack.shape[0]
    background = temporal_median(stack)
    elapsed = time.perf_counter() - start

    return RgbMedianResult(
        use_all_frames=use_all_frames,
        target_frames=None if use_all_frames else target_frames,
        every_n=every_n,
        sampled_frames=count,
        resize=resize,
        processing_time_seconds=elapsed,
        background=background,
        previews=previews,
    )
