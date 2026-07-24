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

DEFAULT_REJECTION_THRESHOLD = 30.0

METHOD = (
    "Per-pixel mean of samples within a Euclidean RGB distance threshold of "
    "the per-channel temporal median; the median itself is used for pixels "
    "where every sample is rejected."
)

# Per-band float32 working-set budget for the rejection pass.
_BAND_FLOAT_BUDGET = 64 * 1024 * 1024


@dataclass
class RgbMeanResult:
    use_all_frames: bool
    target_frames: int | None  # None in all-frames mode
    every_n: int
    sampled_frames: int
    resize: tuple[int, int] | None
    rejection_threshold: float
    rejected_fraction: float  # share of all pixel samples rejected
    fallback_pixels: int  # pixels where every sample was rejected
    processing_time_seconds: float
    background: np.ndarray
    previews: list[np.ndarray]


def _thumbnail(frame: np.ndarray) -> np.ndarray:
    height = max(1, round(frame.shape[0] * PREVIEW_WIDTH / frame.shape[1]))
    return cv2.resize(frame, (PREVIEW_WIDTH, height), interpolation=cv2.INTER_AREA)


def reject_outliers_and_mean(
    stack: np.ndarray, threshold: float
) -> tuple[np.ndarray, int, int]:
    """Mean of per-pixel samples within ``threshold`` of the temporal median.

    ``stack`` is (frames, height, width, channels) uint8. Returns the
    background image plus the number of rejected samples and of fallback
    pixels (all samples rejected — the median vector need not coincide with
    any actual sample, so this can happen for e.g. bimodal pixels).
    """
    frames, height, width, channels = stack.shape
    background = np.empty((height, width, channels), dtype=np.uint8)
    rejected = 0
    fallback = 0

    band = max(1, _BAND_FLOAT_BUDGET // (frames * width * channels * 4))
    for y0 in range(0, height, band):
        chunk = stack[:, y0 : y0 + band].astype(np.float32)
        median = np.median(chunk, axis=0)
        distance_sq = ((chunk - median) ** 2).sum(axis=3)
        keep = distance_sq <= threshold * threshold
        counts = keep.sum(axis=0)
        sums = (chunk * keep[..., np.newaxis]).sum(axis=0)
        mean = sums / np.maximum(counts, 1)[..., np.newaxis]
        resolved = np.where((counts == 0)[..., np.newaxis], median, mean)
        background[y0 : y0 + band] = resolved.round().astype(np.uint8)
        rejected += int(counts.size * frames - counts.sum())
        fallback += int((counts == 0).sum())

    return background, rejected, fallback


def run_rgb_mean(
    target_frames: int = 30,
    resize: tuple[int, int] | None = None,
    use_all_frames: bool = True,
    rejection_threshold: float = DEFAULT_REJECTION_THRESHOLD,
) -> RgbMeanResult:
    if rejection_threshold < 0:
        raise ValueError("rejection_threshold must be non-negative.")

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
            previews.append(_thumbnail(frame))
        frames.append(frame)

    if not frames:
        raise ValueError("No frames could be sampled from the current video.")

    stack = np.stack(frames)
    frames.clear()
    background, rejected, fallback = reject_outliers_and_mean(
        stack, rejection_threshold
    )
    count = stack.shape[0]
    samples_total = count * stack.shape[1] * stack.shape[2]
    elapsed = time.perf_counter() - start

    return RgbMeanResult(
        use_all_frames=use_all_frames,
        target_frames=None if use_all_frames else target_frames,
        every_n=every_n,
        sampled_frames=count,
        resize=resize,
        rejection_threshold=rejection_threshold,
        rejected_fraction=rejected / samples_total,
        fallback_pixels=fallback,
        processing_time_seconds=elapsed,
        background=background,
        previews=previews,
    )
