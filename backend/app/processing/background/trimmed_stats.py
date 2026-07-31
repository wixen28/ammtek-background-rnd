"""Shared median-anchored outlier rejection over a stack of sampled frames.

Every background method that trims foreground out of a per-pixel sample set
needs the same three things: the per-channel temporal median as a robust
reference, the Euclidean RGB distance of each sample from it, and a keep
mask cutting that distance at a threshold. This module owns that pass so
RGB Mean and Background Variation compute it identically instead of each
carrying a copy.

The median needs every sample at once, so callers stack all sampled frames
in memory (N x H x W x 3 uint8). The pass then runs in row bands to keep
the float32 temporaries bounded regardless of resolution. Banding cannot
change the result: the median runs along the time axis, so every pixel is
independent of every other.

Several thresholds are evaluated in a single call. The float32 cast, the
temporal median and the distance matrix do not depend on the threshold, so
each band computes them once and only the keep mask and the masked
reductions repeat per threshold -- far cheaper than re-running the whole
pass (which would also re-decode the video) once per threshold.

Optionally the same pass reports, per pixel, the mean Euclidean distance of
the *kept* samples from the median: how much variation survives rejection.
That costs one extra square root per band and one masked sum per
threshold, so it is opt-in and methods that do not need it pay nothing.
"""

from collections.abc import Sequence
from dataclasses import dataclass

import numpy as np

# Per-band float32 working-set budget for the rejection pass.
BAND_FLOAT_BUDGET = 64 * 1024 * 1024


@dataclass
class TrimmedStats:
    """One threshold's outcome from the shared banded pass."""

    # Per-pixel mean of the kept samples; the median where none were kept.
    background: np.ndarray  # (height, width, channels) uint8
    rejected_samples: int  # count of rejected pixel samples
    fallback_pixels: int  # pixels where every sample was rejected
    # Mean Euclidean RGB distance of the kept samples from the median, and
    # the number of samples that mean is over. Both None unless the caller
    # asked for deviation; both are per-pixel (height, width).
    deviation: np.ndarray | None = None  # float32
    kept_counts: np.ndarray | None = None  # int32


def validate_thresholds(thresholds: Sequence[float]) -> None:
    """Raise ValueError unless every threshold is a usable RGB distance.

    Exposed so callers can fail before decoding a video, rather than after
    paying for the sampling pass.
    """
    if not thresholds:
        raise ValueError("At least one rejection threshold is required.")
    if any(threshold < 0 for threshold in thresholds):
        raise ValueError("rejection_thresholds must be non-negative.")


def trimmed_stats(
    stack: np.ndarray,
    thresholds: Sequence[float],
    with_deviation: bool = False,
) -> list[TrimmedStats]:
    """Reject outliers at each threshold, from a single pass over the stack.

    ``stack`` is (frames, height, width, channels) uint8. Returns one
    ``TrimmedStats`` per threshold, in the given order.

    For each pixel the per-channel temporal median is the reference; samples
    farther from it than the threshold (Euclidean distance in RGB) count as
    foreground and are dropped, and the background is the mean of the rest.
    Where every sample is rejected the median is used instead -- the median
    vector need not coincide with any actual sample, so this can happen for
    e.g. bimodal pixels.

    With ``with_deviation`` each result also carries the per-pixel mean
    distance of the kept samples from the median. Pixels with no kept
    samples get 0.0 there; ``kept_counts`` is how callers tell those apart
    from pixels that genuinely do not vary.
    """
    validate_thresholds(thresholds)

    frames, height, width, channels = stack.shape
    backgrounds = [
        np.empty((height, width, channels), dtype=np.uint8) for _ in thresholds
    ]
    rejected = [0] * len(thresholds)
    fallback = [0] * len(thresholds)
    deviations = (
        [np.empty((height, width), dtype=np.float32) for _ in thresholds]
        if with_deviation
        else None
    )
    kept_counts = (
        [np.empty((height, width), dtype=np.int32) for _ in thresholds]
        if with_deviation
        else None
    )

    # Every float32 temporary held at once, per row of a band: the frame
    # chunk (one plane per channel), the squared-distance matrix, and the
    # distance matrix when deviation is requested.
    planes = channels + 1 + (1 if with_deviation else 0)
    band = max(1, BAND_FLOAT_BUDGET // (frames * width * planes * 4))

    for y0 in range(0, height, band):
        chunk = stack[:, y0 : y0 + band].astype(np.float32)
        median = np.median(chunk, axis=0)
        distance_sq = ((chunk - median) ** 2).sum(axis=3)
        # Shared by every threshold, so the square root is paid once a band.
        distance = np.sqrt(distance_sq) if with_deviation else None

        for i, threshold in enumerate(thresholds):
            keep = distance_sq <= threshold * threshold
            counts = keep.sum(axis=0)
            sums = (chunk * keep[..., np.newaxis]).sum(axis=0)
            mean = sums / np.maximum(counts, 1)[..., np.newaxis]
            resolved = np.where((counts == 0)[..., np.newaxis], median, mean)
            backgrounds[i][y0 : y0 + band] = resolved.round().astype(np.uint8)
            rejected[i] += int(counts.size * frames - counts.sum())
            fallback[i] += int((counts == 0).sum())

            if deviations is not None and kept_counts is not None:
                # Where nothing was kept the masked sum is 0, so the pixel
                # lands on 0.0 without a synthetic value being written in.
                deviation_sums = (distance * keep).sum(axis=0)
                deviations[i][y0 : y0 + band] = deviation_sums / np.maximum(
                    counts, 1
                )
                kept_counts[i][y0 : y0 + band] = counts

    return [
        TrimmedStats(
            background=backgrounds[i],
            rejected_samples=rejected[i],
            fallback_pixels=fallback[i],
            deviation=deviations[i] if deviations is not None else None,
            kept_counts=kept_counts[i] if kept_counts is not None else None,
        )
        for i in range(len(thresholds))
    ]
