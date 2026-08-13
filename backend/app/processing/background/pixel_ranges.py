"""Accepted background ranges for *every* pixel, not just one selected one.

The browser already derives up to three accepted colour states for a single
pixel from its frame history (``frontend/src/backgroundRanges.ts``). That is
the diagnostic; this is the same derivation run for the whole grid, so a
frame can be judged pixel-by-pixel against ranges belonging to that pixel.
The previous frame test applied *one* pixel's boxes to every pixel, which is
why large parts of a uniform floor read as rejected: the floor is not that
one shade everywhere.

The output is deliberately not a verdict but a **model**: per pixel, up to
``max_ranges`` axis-aligned RGB boxes. Classifying a frame against it is a
handful of byte comparisons per pixel, so the browser can do that on its
existing playback clock while the expensive part — reading the video and
clustering each pixel's history — is paid once here.

Same algorithm as the single-pixel path, in the same order:

1. Per channel, the Otsu threshold of that pixel's values and its
   separability (between-class variance over total variance). The channel
   with the highest separability splits the **frames**, so every box stays a
   colour the pixel actually had; three independent per-channel splits would
   describe eight corners, most of them never taken.
2. Up to ``max(2, max_ranges)`` candidate states by splitting recursively:
   whichever state currently holds the most frames and can still be split is
   split again, on the same channel. Two candidates are always produced even
   when only one range is allowed — capping at one range means "accept only
   the strongest state", not "treat the whole history as one state".
3. Each state becomes a box from the central ``range_width`` quantile of its
   own values per channel, then dilated by ``tolerance``.
4. Ranges are accepted strongest-first, and the next one only while the boxes
   so far accept less than ``signal`` of the pixel's frames.

``signal`` and ``range_width`` are separate on purpose: the first is a global
stopping rule over the union of the boxes (*how many states are worth
keeping*), the second a local trimming quantile inside one state (*how much
variation around a state is tolerated*). One number driving both cannot
loosen a box without also buying more boxes.

Cost is dominated by sorting each pixel's samples: three sorts to pick the
channel, one for the chosen channel, and one per (range, channel) to take
quantiles. Row banding keeps the working set bounded regardless of
resolution — the derivation runs along the time axis, so pixels are
independent and banding cannot change the result.
"""

import time
from dataclasses import dataclass

import numpy as np

from app.processing.background.previews import PREVIEW_MAX, thumbnail
from app.processing.video import store
from app.processing.video.frames import scaled_size
from app.processing.video.sampling import (
    NoCurrentVideoError,
    sample_current_video,
    spread_every_n,
)

METHOD = (
    "Per-pixel accepted background ranges: up to three Otsu-separated colour "
    "states per pixel, each trimmed to a central quantile of its own values."
)

# Hard cap on the states a pixel may be given. Three is what the analysis UI
# offers; the number is a research question, not a limit of the method.
MAX_RANGES = 3

# Defaults sized so a build stays a few seconds on the hall clip (720x480,
# 2721 frames): a 360 px grid is enough to see whether the floor is accepted,
# and 240 frames spread over the whole video still contain both lighting
# states with plenty of samples per state for a quantile.
DEFAULT_MAX_WIDTH = 360
DEFAULT_TARGET_FRAMES = 240

DEFAULT_SIGNAL = 0.9
DEFAULT_RANGE_WIDTH = 0.9
DEFAULT_TOLERANCE = 0
MAX_TOLERANCE = 64

# Per-band working-set budget. The band pass holds roughly thirty bytes per
# (frame, pixel): the uint8 samples, two int32 prefix sums and the float32
# split temporaries, which are the largest of them.
BAND_BYTE_BUDGET = 64 * 1024 * 1024
_BYTES_PER_SAMPLE = 32

# Bounds written where a range is not used by a pixel. An empty box (lower
# above upper) accepts nothing on any channel, so the client needs no
# per-pixel count alongside the bounds to know how many ranges are real.
UNUSED_LOWER = 255
UNUSED_UPPER = 0


@dataclass
class RangePlane:
    """One accepted range, as per-pixel bounds over the whole grid."""

    rank: int  # 1 = the state holding the most frames
    lower: np.ndarray  # (height, width, 3) uint8, same channel order as frames
    upper: np.ndarray
    pixels: int  # pixels that actually use this range


@dataclass
class PixelRangeModelResult:
    use_all_frames: bool
    target_frames: int | None
    every_n: int
    sampled_frames: int
    width: int
    height: int
    source_width: int
    source_height: int
    signal: float
    range_width: float
    tolerance: int
    max_ranges: int
    processing_time_seconds: float
    ranges: list[RangePlane]
    # Share of all (pixel, frame) samples the finished model accepts. The
    # whole-grid equivalent of the single pixel's achieved coverage, and the
    # one number that says whether these settings explain the video.
    accepted_sample_share: float
    # Pixels using exactly 1, 2, ... ranges, so a mostly-single-state grid is
    # distinguishable from one where the second state is everywhere.
    pixels_by_range_count: list[int]
    previews: list[np.ndarray]


def validate_settings(
    signal: float, range_width: float, tolerance: int, max_ranges: int
) -> None:
    """Reject settings before a video is decoded rather than after."""
    if not 0 < signal <= 1:
        raise ValueError(f"signal must be in (0, 1]; got {signal}.")
    if not 0 < range_width <= 1:
        raise ValueError(f"range_width must be in (0, 1]; got {range_width}.")
    if not 0 <= tolerance <= MAX_TOLERANCE:
        raise ValueError(f"tolerance must be in 0–{MAX_TOLERANCE}; got {tolerance}.")
    if not 1 <= max_ranges <= MAX_RANGES:
        raise ValueError(f"max_ranges must be in 1–{MAX_RANGES}; got {max_ranges}.")


def _otsu(
    srt: np.ndarray, prefix: np.ndarray, low: np.ndarray, high: np.ndarray
) -> tuple[np.ndarray, np.ndarray]:
    """Best split of the sorted window ``[low, high)`` of each pixel.

    ``srt`` is (frames, pixels), ascending along axis 0; ``prefix`` is
    (frames + 1, pixels) with ``prefix[i]`` the sum of the first ``i``
    samples. ``low`` and ``high`` are per-pixel window bounds as positions in
    the sorted order — which is what makes recursion cheap: a state produced
    by thresholding a channel is always a contiguous slice of that channel's
    sorted values, so a sub-split is the same computation on a narrower
    window.

    Returns the cut (how many of the window's samples fall in its low part,
    as an absolute sorted position) and the between-class variance of that
    cut. A non-positive variance means the window could not be split.
    """
    n = srt.shape[0]
    # Candidate cuts, as positions: cut j puts sorted samples [low, j) low.
    j = np.arange(1, n, dtype=np.float32)[:, None]
    lo = low.astype(np.float32)[None, :]
    hi = high.astype(np.float32)[None, :]

    n_low = j - lo
    n_high = hi - j
    span = hi - lo
    # Never cut between two equal values: the states are defined by a value
    # threshold, so a cut inside a run of one value is not realizable.
    usable = (n_low > 0) & (n_high > 0) & (srt[: n - 1] < srt[1:])

    sum_low = prefix[1:n].astype(np.float32) - np.take_along_axis(
        prefix, low[None, :], 0
    ).astype(np.float32)
    sum_high = (
        np.take_along_axis(prefix, high[None, :], 0).astype(np.float32)
        - prefix[1:n].astype(np.float32)
    )
    mean_low = sum_low / np.maximum(n_low, 1)
    mean_high = sum_high / np.maximum(n_high, 1)
    between = (n_low * n_high / np.maximum(span * span, 1)) * (mean_low - mean_high) ** 2
    between = np.where(usable, between, -1.0)

    index = np.argmax(between, axis=0)
    best = np.take_along_axis(between, index[None, :], 0)[0]
    # `index` is the row of cut j = index + 1.
    return (index + 1).astype(np.int32), best


def _band_bounds(
    samples: np.ndarray,
    signal: float,
    range_width: float,
    tolerance: int,
    max_ranges: int,
) -> tuple[np.ndarray, np.ndarray, np.ndarray, int]:
    """Derive per-pixel range bounds for one band of pixels.

    ``samples`` is (frames, pixels, channels) uint8. Returns the lower and
    upper bounds as (max_ranges, pixels, channels) uint8, how many ranges
    each pixel ended up using, and the number of accepted (pixel, frame)
    samples.
    """
    n, pixels, channels = samples.shape
    state_count = max(2, max_ranges)

    # --- 1. Which channel separates this pixel's states best ----------------
    # Iterated red-first so an exact tie — two states that separate perfectly
    # on all three channels — falls to R, G, B order rather than to float
    # noise, the same tie-break the single-pixel derivation makes. Channel
    # order here is the frames' own (OpenCV's B, G, R), so red is last.
    best_separation = np.full(pixels, -1.0, dtype=np.float32)
    best_channel = np.zeros(pixels, dtype=np.intp)
    for channel in reversed(range(channels)):
        srt = np.sort(samples[:, :, channel], axis=0)
        values = srt.astype(np.int32)
        prefix = np.zeros((n + 1, pixels), dtype=np.int32)
        np.cumsum(values, axis=0, out=prefix[1:])
        squares = np.zeros((n + 1, pixels), dtype=np.int64)
        np.cumsum(values.astype(np.int64) ** 2, axis=0, out=squares[1:])

        _, between = _otsu(
            srt,
            prefix,
            np.zeros(pixels, dtype=np.int32),
            np.full(pixels, n, dtype=np.int32),
        )
        mean = prefix[n].astype(np.float64) / n
        variance = squares[n].astype(np.float64) / n - mean * mean
        separation = np.where(
            (between > 0) & (variance > 0),
            between / np.maximum(variance, 1e-9),
            -1.0,
        ).astype(np.float32)
        # Strictly greater, so the earlier (redder) channel keeps a tie.
        better = separation > best_separation
        best_separation = np.where(better, separation, best_separation)
        best_channel = np.where(better, channel, best_channel)

    # --- 2. Cut the chosen channel into up to `state_count` states ----------
    chosen = np.take_along_axis(samples, best_channel[None, :, None], axis=2)[:, :, 0]
    srt = np.sort(chosen, axis=0)
    prefix = np.zeros((n + 1, pixels), dtype=np.int32)
    np.cumsum(srt.astype(np.int32), axis=0, out=prefix[1:])

    zero = np.zeros(pixels, dtype=np.int32)
    full = np.full(pixels, n, dtype=np.int32)
    cut, between = _otsu(srt, prefix, zero, full)
    # A pixel that never changes has nothing to split: its single state is
    # the whole history, which the cut `n` expresses.
    first = np.where(between > 0, cut, full).astype(np.int32)

    cut_low = first
    cut_high = full.copy()
    if state_count >= 3:
        # Split whichever of the two states holds more frames; on a tie the
        # lower-valued one, so the result does not depend on float noise.
        # If that one cannot be split, the other is tried.
        cut_a, between_a = _otsu(srt, prefix, zero, first)
        cut_b, between_b = _otsu(srt, prefix, first, full)
        ok_a = between_a > 0
        ok_b = between_b > 0
        prefer_a = first >= (n - first)
        use_a = (prefer_a & ok_a) | (~prefer_a & ~ok_b & ok_a)
        use_b = (~prefer_a & ok_b) | (prefer_a & ~ok_a & ok_b)
        cut_low = np.where(use_a, cut_a, first).astype(np.int32)
        cut_high = np.where(use_a, first, np.where(use_b, cut_b, full)).astype(np.int32)

    # Value thresholds equivalent to those sorted positions. `_otsu` never
    # cuts between equal values, so thresholding by value reproduces the cut
    # exactly. A cut at `n` means "no boundary": 255 accepts every value.
    threshold_low = np.where(
        cut_low < n, np.take_along_axis(srt, np.maximum(cut_low - 1, 0)[None, :], 0)[0], 255
    ).astype(np.int32)
    threshold_high = np.where(
        cut_high < n,
        np.take_along_axis(srt, np.maximum(cut_high - 1, 0)[None, :], 0)[0],
        255,
    ).astype(np.int32)

    state = np.where(
        chosen <= threshold_low[None, :],
        0,
        np.where(chosen <= threshold_high[None, :], 1, 2),
    ).astype(np.int8)
    counts = np.stack(
        [cut_low, cut_high - cut_low, n - cut_high], axis=1
    )  # (pixels, 3)

    # --- 3 & 4. Boxes, strongest state first, added while below `signal` ----
    # Stable order, so two equally sized states keep the lower-valued one
    # first and repeated builds agree.
    order = np.argsort(-counts, axis=1, kind="stable")

    lower = np.full((max_ranges, pixels, channels), UNUSED_LOWER, dtype=np.uint8)
    upper = np.full((max_ranges, pixels, channels), UNUSED_UPPER, dtype=np.uint8)
    taken = np.zeros((n, pixels), dtype=bool)
    accepted = np.zeros(pixels, dtype=np.int32)
    used = np.zeros(pixels, dtype=np.int32)
    # Whether this pixel is still short of the requested signal. Checked
    # before every range after the first, exactly as the single-pixel path
    # breaks out of its loop.
    adding = np.ones(pixels, dtype=bool)

    for rank in range(max_ranges):
        state_index = order[:, rank].astype(np.int8)
        member = state == state_index[None, :]
        size = np.take_along_axis(counts, order[:, rank : rank + 1], 1)[:, 0]
        if rank > 0:
            adding &= accepted < signal * n
        active = adding & (size > 0)
        if not active.any():
            break

        box_low = np.empty((pixels, channels), dtype=np.int32)
        box_high = np.empty((pixels, channels), dtype=np.int32)
        # Trim to the central `range_width` of the state's own values by
        # *count*, not by value, so the interval is defined by how many
        # frames it keeps. The 1e-9 absorbs float error in `width * size`, so
        # a share dividing the count evenly does not keep an extra frame.
        keep = np.minimum(size, np.maximum(1, np.ceil(range_width * size - 1e-9)))
        keep = keep.astype(np.int32)
        drop_low = ((size - keep) // 2).astype(np.int32)
        for channel in range(channels):
            # Non-members are pushed past every real value by the sentinel, so
            # the state's own values occupy the first `size` sorted positions.
            masked = np.where(
                member, samples[:, :, channel].astype(np.uint16), np.uint16(256)
            )
            state_sorted = np.sort(masked, axis=0)
            low = np.take_along_axis(state_sorted, drop_low[None, :], 0)[0]
            high = np.take_along_axis(
                state_sorted, (drop_low + keep - 1)[None, :], 0
            )[0]
            box_low[:, channel] = np.clip(low.astype(np.int32) - tolerance, 0, 255)
            box_high[:, channel] = np.clip(high.astype(np.int32) + tolerance, 0, 255)

        inside = np.ones((n, pixels), dtype=bool)
        for channel in range(channels):
            values = samples[:, :, channel].astype(np.int32)
            inside &= (values >= box_low[None, :, channel]) & (
                values <= box_high[None, :, channel]
            )
        # First match wins, the same rule the client applies per pixel, so a
        # frame counted here is a frame the client would attribute to this
        # range too.
        newly = inside & ~taken & active[None, :]
        taken |= newly
        accepted += newly.sum(axis=0, dtype=np.int32)
        used += active

        lower[rank] = np.where(active[:, None], box_low, UNUSED_LOWER).astype(np.uint8)
        upper[rank] = np.where(active[:, None], box_high, UNUSED_UPPER).astype(np.uint8)

    return lower, upper, used, int(accepted.sum())


def build_pixel_ranges(
    stack: np.ndarray,
    signal: float = DEFAULT_SIGNAL,
    range_width: float = DEFAULT_RANGE_WIDTH,
    tolerance: int = DEFAULT_TOLERANCE,
    max_ranges: int = MAX_RANGES,
) -> tuple[list[RangePlane], float, list[int]]:
    """Per-pixel range planes for a (frames, height, width, channels) stack.

    Returns the planes rank-first, the share of (pixel, frame) samples the
    model accepts, and how many pixels use exactly 1, 2, ... ranges.
    """
    validate_settings(signal, range_width, tolerance, max_ranges)
    if stack.ndim != 4:
        raise ValueError("stack must be (frames, height, width, channels).")
    frames, height, width, channels = stack.shape
    if frames < 2:
        raise ValueError("Per-pixel ranges need at least two sampled frames.")

    lower = [
        np.full((height, width, channels), UNUSED_LOWER, dtype=np.uint8)
        for _ in range(max_ranges)
    ]
    upper = [
        np.full((height, width, channels), UNUSED_UPPER, dtype=np.uint8)
        for _ in range(max_ranges)
    ]
    used = np.zeros((height, width), dtype=np.int32)
    accepted = 0

    band = max(1, BAND_BYTE_BUDGET // (frames * width * _BYTES_PER_SAMPLE))
    for y0 in range(0, height, band):
        rows = stack[:, y0 : y0 + band]
        band_height = rows.shape[1]
        samples = np.ascontiguousarray(rows).reshape(frames, -1, channels)

        band_lower, band_upper, band_used, band_accepted = _band_bounds(
            samples, signal, range_width, tolerance, max_ranges
        )
        for rank in range(max_ranges):
            lower[rank][y0 : y0 + band_height] = band_lower[rank].reshape(
                band_height, width, channels
            )
            upper[rank][y0 : y0 + band_height] = band_upper[rank].reshape(
                band_height, width, channels
            )
        used[y0 : y0 + band_height] = band_used.reshape(band_height, width)
        accepted += band_accepted

    planes = [
        RangePlane(
            rank=rank + 1,
            lower=lower[rank],
            upper=upper[rank],
            pixels=int((used > rank).sum()),
        )
        for rank in range(max_ranges)
    ]
    by_count = [int((used == count + 1).sum()) for count in range(max_ranges)]
    return planes, accepted / (frames * height * width), by_count


def run_pixel_range_model(
    use_all_frames: bool = False,
    target_frames: int = DEFAULT_TARGET_FRAMES,
    max_width: int = DEFAULT_MAX_WIDTH,
    signal: float = DEFAULT_SIGNAL,
    range_width: float = DEFAULT_RANGE_WIDTH,
    tolerance: int = DEFAULT_TOLERANCE,
    max_ranges: int = MAX_RANGES,
) -> PixelRangeModelResult:
    """Build the per-pixel range model for the current input video."""
    validate_settings(signal, range_width, tolerance, max_ranges)

    record = store.load_current()
    if record is None:
        raise NoCurrentVideoError("No video uploaded yet.")

    source_width, source_height = record["width"], record["height"]
    # The grid single frames are served at, so the model and the frames the
    # client tests against it are the same pixels.
    resize = scaled_size(source_width, source_height, max_width)

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

    if len(frames) < 2:
        raise ValueError(
            "Per-pixel ranges need at least two sampled frames from the video."
        )

    stack = np.stack(frames)
    frames.clear()
    planes, accepted_share, by_count = build_pixel_ranges(
        stack, signal, range_width, tolerance, max_ranges
    )
    sampled = stack.shape[0]
    elapsed = time.perf_counter() - start

    return PixelRangeModelResult(
        use_all_frames=use_all_frames,
        target_frames=None if use_all_frames else target_frames,
        every_n=every_n,
        sampled_frames=sampled,
        width=resize[0],
        height=resize[1],
        source_width=source_width,
        source_height=source_height,
        signal=signal,
        range_width=range_width,
        tolerance=tolerance,
        max_ranges=max_ranges,
        processing_time_seconds=elapsed,
        ranges=planes,
        accepted_sample_share=accepted_share,
        pixels_by_range_count=by_count,
        previews=previews,
    )
