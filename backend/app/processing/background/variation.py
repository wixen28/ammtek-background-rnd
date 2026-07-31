"""Background Variation: how much variation survives outlier rejection.

RGB Mean answers "what is the background here". This answers "how settled
is that answer". Both run the same median-anchored rejection pass; this one
keeps the residual instead of the mean.

For each pixel, the samples within the rejection threshold of the temporal
median are the ones the background estimate rests on. Their mean Euclidean
RGB distance from that median is the variation that rejection did *not*
remove: sensor noise, illumination drift, and any motion small or slow
enough to stay under the threshold. It is deliberately not a map of the
rejected samples -- that would be a per-frame motion occupancy map, dense
and speckled, and it is already covered by the movement diagnostic.

The scalar is rendered as a single-channel grayscale mask, scaled from true
zero by the largest deviation in the run, so black means a pixel whose kept
samples all agree and brighter means more residual disagreement. The run
reports the actual deviation range, so a gray value maps back to RGB
distance units: ``deviation ~= gray / 255 * deviation_max``.
"""

import time
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

DEFAULT_REJECTION_THRESHOLD = 30.0

METHOD = (
    "Per-pixel mean Euclidean RGB distance from the per-channel temporal "
    "median, over the samples kept by the rejection threshold, rendered as a "
    "grayscale mask scaled from zero by the run's largest deviation."
)


@dataclass
class BackgroundVariationResult:
    use_all_frames: bool
    target_frames: int | None  # None in all-frames mode
    every_n: int
    sampled_frames: int
    resize: tuple[int, int] | None
    processing_time_seconds: float
    rejection_threshold: float
    rejected_fraction: float  # share of all pixel samples rejected
    fallback_pixels: int  # pixels where every sample was rejected
    # Range over pixels that kept at least one sample, in RGB distance units.
    deviation_min: float
    deviation_max: float
    background: np.ndarray  # (height, width, 3) uint8, for reference
    variation_mask: np.ndarray  # (height, width) uint8, single channel
    previews: list[np.ndarray]


def deviation_range(
    deviation: np.ndarray, kept_counts: np.ndarray
) -> tuple[float, float]:
    """Min and max deviation over pixels that kept at least one sample.

    Pixels where every sample was rejected sit at 0.0 without ever having
    had an inlier, so including them would report a minimum of 0 for a
    range they are not part of. Returns (0.0, 0.0) when no pixel kept a
    sample at all, which only happens at a degenerate threshold.
    """
    measured = kept_counts > 0
    if not measured.any():
        return 0.0, 0.0
    values = deviation[measured]
    return float(values.min()), float(values.max())


def to_grayscale_mask(deviation: np.ndarray, deviation_max: float) -> np.ndarray:
    """Scale a deviation map to 0-255, linearly from true zero.

    Anchoring at zero rather than at the observed minimum keeps black
    meaning "these samples agree" instead of "least varying pixel in this
    particular video", so masks stay readable on their own terms. A run
    with no variation at all (a single frame, or static synthetic footage)
    maps to a uniformly black mask instead of dividing by zero.
    """
    if deviation_max <= 0:
        return np.zeros(deviation.shape, dtype=np.uint8)
    scaled = deviation / deviation_max * 255.0
    return scaled.round().clip(0, 255).astype(np.uint8)


def run_background_variation(
    target_frames: int = 30,
    resize: tuple[int, int] | None = None,
    use_all_frames: bool = True,
    rejection_threshold: float = DEFAULT_REJECTION_THRESHOLD,
) -> BackgroundVariationResult:
    # Validated before decoding, so a bad threshold does not cost a full
    # sampling pass first.
    validate_thresholds([rejection_threshold])

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
    [stats] = trimmed_stats(stack, [rejection_threshold], with_deviation=True)
    assert stats.deviation is not None and stats.kept_counts is not None

    count = stack.shape[0]
    samples_total = count * stack.shape[1] * stack.shape[2]
    minimum, maximum = deviation_range(stats.deviation, stats.kept_counts)
    mask = to_grayscale_mask(stats.deviation, maximum)
    elapsed = time.perf_counter() - start

    return BackgroundVariationResult(
        use_all_frames=use_all_frames,
        target_frames=None if use_all_frames else target_frames,
        every_n=every_n,
        sampled_frames=count,
        resize=resize,
        processing_time_seconds=elapsed,
        rejection_threshold=rejection_threshold,
        rejected_fraction=stats.rejected_samples / samples_total,
        fallback_pixels=stats.fallback_pixels,
        deviation_min=minimum,
        deviation_max=maximum,
        background=stats.background,
        variation_mask=mask,
        previews=previews,
    )
