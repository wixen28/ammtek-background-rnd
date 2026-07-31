"""RGB Mean background extraction with outlier rejection.

The pixel-timeline diagnostic shows a simple pattern: a background pixel
holds a stable value with small noise, and brief foreground passes push it
far away for a few frames. The per-channel temporal median is a robust
estimate of that stable value (short passes barely move it), so samples
farther from the median than a threshold (Euclidean distance in RGB) are
rejected as foreground and the background is the mean of the rest. The
median is only the internal reference point -- the output stays a mean.

The median needs every sample at once, so all sampled frames are stacked
in memory (N x H x W x 3 uint8). The rejection pass itself lives in
``trimmed_stats``, shared with Background Variation; see that module for
the banding and multi-threshold sharing it does. What is specific to this
experiment is the sweep presets and the payload cap on how many
backgrounds one run may return.
"""

import time
from collections.abc import Sequence
from dataclasses import dataclass

import numpy as np

from app.processing.background.previews import PREVIEW_MAX, thumbnail
from app.processing.background.trimmed_stats import (
    trimmed_stats,
    validate_thresholds,
)
from app.processing.video import store
from app.processing.video.sampling import (
    NoCurrentVideoError,
    sample_current_video,
    spread_every_n,
)

# Presets swept by default; the frontend sends its own (editable) values.
DEFAULT_REJECTION_THRESHOLDS = (20.0, 30.0, 50.0)

# Every threshold adds a full-resolution PNG to the response payload.
MAX_REJECTION_THRESHOLDS = 5

METHOD = (
    "Per-pixel mean of samples within a Euclidean RGB distance threshold of "
    "the per-channel temporal median; the median itself is used for pixels "
    "where every sample is rejected."
)


@dataclass
class RgbMeanVariant:
    """One threshold's background and its diagnostics."""

    rejection_threshold: float
    rejected_fraction: float  # share of all pixel samples rejected
    fallback_pixels: int  # pixels where every sample was rejected
    background: np.ndarray


@dataclass
class RgbMeanResult:
    use_all_frames: bool
    target_frames: int | None  # None in all-frames mode
    every_n: int
    sampled_frames: int
    resize: tuple[int, int] | None
    processing_time_seconds: float  # whole run, all thresholds together
    previews: list[np.ndarray]
    variants: list[RgbMeanVariant]


def run_rgb_mean(
    target_frames: int = 30,
    resize: tuple[int, int] | None = None,
    use_all_frames: bool = True,
    rejection_thresholds: Sequence[float] = DEFAULT_REJECTION_THRESHOLDS,
) -> RgbMeanResult:
    # Validated before decoding, so a bad threshold does not cost a full
    # sampling pass first.
    validate_thresholds(rejection_thresholds)
    if len(rejection_thresholds) > MAX_REJECTION_THRESHOLDS:
        raise ValueError(
            f"At most {MAX_REJECTION_THRESHOLDS} rejection thresholds "
            "can be evaluated in one run."
        )

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
    outcomes = trimmed_stats(stack, rejection_thresholds)
    count = stack.shape[0]
    samples_total = count * stack.shape[1] * stack.shape[2]
    elapsed = time.perf_counter() - start

    return RgbMeanResult(
        use_all_frames=use_all_frames,
        target_frames=None if use_all_frames else target_frames,
        every_n=every_n,
        sampled_frames=count,
        resize=resize,
        processing_time_seconds=elapsed,
        previews=previews,
        variants=[
            RgbMeanVariant(
                rejection_threshold=threshold,
                rejected_fraction=stats.rejected_samples / samples_total,
                fallback_pixels=stats.fallback_pixels,
                background=stats.background,
            )
            for threshold, stats in zip(
                rejection_thresholds, outcomes, strict=True
            )
        ],
    )
