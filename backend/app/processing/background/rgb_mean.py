"""RGB Mean background extraction with outlier rejection.

The pixel-timeline diagnostic shows a simple pattern: a background pixel
holds a stable value with small noise, and brief foreground passes push it
far away for a few frames. The per-channel temporal median is a robust
estimate of that stable value (short passes barely move it), so samples
farther from the median than a threshold (Euclidean distance in RGB) are
rejected as foreground and the background is the mean of the rest. The
median is only the internal reference point — the output stays a mean.

Unlike the previous running mean, the median needs every sample at once,
so all sampled frames are stacked in memory (N × H × W × 3 uint8). The
rejection pass then runs in row bands to keep the float32 temporaries
bounded regardless of resolution.

Several thresholds are evaluated in a single run. The float32 cast, the
temporal median and the distance matrix do not depend on the threshold,
so each band computes them once and only the keep-mask and the masked
mean are repeated per threshold — far cheaper than re-running the whole
experiment (which would also re-decode the video) once per threshold.
"""

import time
from collections.abc import Sequence
from dataclasses import dataclass

import numpy as np

from app.processing.background.previews import PREVIEW_MAX, thumbnail
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

# Per-band float32 working-set budget for the rejection pass.
_BAND_FLOAT_BUDGET = 64 * 1024 * 1024


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


def reject_outliers_and_mean(
    stack: np.ndarray, thresholds: Sequence[float]
) -> list[tuple[np.ndarray, int, int]]:
    """One background per threshold, from a single pass over the stack.

    Each background is the per-pixel mean of the samples lying within that
    threshold of the temporal median.

    ``stack`` is (frames, height, width, channels) uint8. Returns one
    (background, rejected samples, fallback pixels) triple per threshold,
    in the given order. Fallback pixels are those where every sample was
    rejected — the median vector need not coincide with any actual sample,
    so this can happen for e.g. bimodal pixels.

    The per-band median and distance matrix are shared by all thresholds,
    so additional thresholds cost only a mask and a masked mean each.
    """
    frames, height, width, channels = stack.shape
    backgrounds = [
        np.empty((height, width, channels), dtype=np.uint8) for _ in thresholds
    ]
    rejected = [0] * len(thresholds)
    fallback = [0] * len(thresholds)

    band = max(1, _BAND_FLOAT_BUDGET // (frames * width * channels * 4))
    for y0 in range(0, height, band):
        chunk = stack[:, y0 : y0 + band].astype(np.float32)
        median = np.median(chunk, axis=0)
        distance_sq = ((chunk - median) ** 2).sum(axis=3)
        for i, threshold in enumerate(thresholds):
            keep = distance_sq <= threshold * threshold
            counts = keep.sum(axis=0)
            sums = (chunk * keep[..., np.newaxis]).sum(axis=0)
            mean = sums / np.maximum(counts, 1)[..., np.newaxis]
            resolved = np.where((counts == 0)[..., np.newaxis], median, mean)
            backgrounds[i][y0 : y0 + band] = resolved.round().astype(np.uint8)
            rejected[i] += int(counts.size * frames - counts.sum())
            fallback[i] += int((counts == 0).sum())

    return list(zip(backgrounds, rejected, fallback, strict=True))


def run_rgb_mean(
    target_frames: int = 30,
    resize: tuple[int, int] | None = None,
    use_all_frames: bool = True,
    rejection_thresholds: Sequence[float] = DEFAULT_REJECTION_THRESHOLDS,
) -> RgbMeanResult:
    if not rejection_thresholds:
        raise ValueError("At least one rejection threshold is required.")
    if len(rejection_thresholds) > MAX_REJECTION_THRESHOLDS:
        raise ValueError(
            f"At most {MAX_REJECTION_THRESHOLDS} rejection thresholds "
            "can be evaluated in one run."
        )
    if any(threshold < 0 for threshold in rejection_thresholds):
        raise ValueError("rejection_thresholds must be non-negative.")

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
    outcomes = reject_outliers_and_mean(stack, rejection_thresholds)
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
                rejected_fraction=rejected / samples_total,
                fallback_pixels=fallback,
                background=background,
            )
            for threshold, (background, rejected, fallback) in zip(
                rejection_thresholds, outcomes, strict=True
            )
        ],
    )
