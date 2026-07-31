import math

import numpy as np
import pytest

from app.processing.background import trimmed_stats as ts
from app.processing.background.trimmed_stats import trimmed_stats

# Euclidean RGB distance can be at most sqrt(3) * 255 ~= 441.7, so this
# threshold keeps every sample and yields the plain mean.
KEEP_ALL = 500.0

SQRT3 = math.sqrt(3)


def test_removes_foreground_pass() -> None:
    # 18 background samples at 10 plus 2 foreground samples at 200: the
    # plain mean would be 29; rejection recovers the background value.
    stack = np.full((20, 4, 6, 3), 10, dtype=np.uint8)
    stack[5] = 200
    stack[11] = 200
    [stats] = trimmed_stats(stack, [30.0])
    assert np.array_equal(stats.background, np.full((4, 6, 3), 10, dtype=np.uint8))
    assert stats.rejected_samples == 2 * 4 * 6
    assert stats.fallback_pixels == 0


def test_median_fallback() -> None:
    # Bimodal pixel: the median vector (127.5) is far from both actual
    # samples, so everything is rejected and the median is used instead.
    stack = np.zeros((2, 2, 2, 3), dtype=np.uint8)
    stack[1] = 255
    [stats] = trimmed_stats(stack, [100.0])
    assert np.array_equal(stats.background, np.full((2, 2, 3), 128, dtype=np.uint8))
    assert stats.rejected_samples == 2 * 2 * 2
    assert stats.fallback_pixels == 2 * 2


def test_ignores_mild_noise() -> None:
    # Samples within the threshold are all kept and averaged.
    stack = np.zeros((4, 1, 1, 3), dtype=np.uint8)
    stack[:, 0, 0] = [[100] * 3, [102] * 3, [104] * 3, [106] * 3]
    [stats] = trimmed_stats(stack, [30.0])
    assert stats.background[0, 0].tolist() == [103, 103, 103]
    assert stats.rejected_samples == 0
    assert stats.fallback_pixels == 0


def test_multiple_thresholds() -> None:
    # One pixel per outcome, evaluated in a single pass: a tight threshold
    # rejects the 200s (background 10, one fallback pixel where the median
    # sits between the two modes) while a wide one keeps everything.
    stack = np.full((4, 1, 2, 3), 10, dtype=np.uint8)
    stack[3, 0, 0] = 200  # minority outlier
    stack[2:, 0, 1] = 200  # bimodal: median 105 matches no sample
    outcomes = trimmed_stats(stack, [30.0, KEEP_ALL])
    assert len(outcomes) == 2

    tight, wide = outcomes
    assert tight.background[0, 0].tolist() == [10, 10, 10]  # outlier dropped
    assert tight.background[0, 1].tolist() == [105, 105, 105]  # median fallback
    # 1 outlier sample + all 4 of the bimodal pixel.
    assert tight.rejected_samples == 1 + 4
    assert tight.fallback_pixels == 1

    # sqrt(3) * 190 ~= 329 < 500, so nothing is rejected anywhere.
    assert wide.background[0, 0].tolist() == [58, 58, 58]  # (10*3 + 200) / 4
    assert wide.background[0, 1].tolist() == [105, 105, 105]
    assert wide.rejected_samples == 0
    assert wide.fallback_pixels == 0


def test_deviation_is_opt_in() -> None:
    stack = np.full((4, 2, 2, 3), 10, dtype=np.uint8)
    [without] = trimmed_stats(stack, [30.0])
    assert without.deviation is None
    assert without.kept_counts is None

    [with_it] = trimmed_stats(stack, [30.0], with_deviation=True)
    assert with_it.deviation is not None
    assert with_it.kept_counts is not None
    assert with_it.deviation.shape == (2, 2)
    assert with_it.deviation.dtype == np.float32


def test_deviation_is_zero_for_constant_samples() -> None:
    # Every sample equals the median, so nothing deviates from it.
    stack = np.full((5, 3, 4, 3), 77, dtype=np.uint8)
    [stats] = trimmed_stats(stack, [30.0], with_deviation=True)
    assert np.array_equal(stats.deviation, np.zeros((3, 4), dtype=np.float32))
    assert np.array_equal(stats.kept_counts, np.full((3, 4), 5, dtype=np.int32))


def test_deviation_of_known_jitter() -> None:
    # Samples 100/102/104/106 in all channels -> median 103, per-sample
    # distances 3*sqrt(3), sqrt(3), sqrt(3), 3*sqrt(3) -> mean 2*sqrt(3).
    stack = np.zeros((4, 1, 1, 3), dtype=np.uint8)
    stack[:, 0, 0] = [[100] * 3, [102] * 3, [104] * 3, [106] * 3]
    [stats] = trimmed_stats(stack, [30.0], with_deviation=True)
    assert stats.deviation[0, 0] == pytest.approx(2 * SQRT3, abs=1e-4)
    assert stats.kept_counts[0, 0] == 4


def test_deviation_counts_only_kept_samples() -> None:
    # 18 samples at 10 (the median) plus 2 at 200. Rejecting the outliers
    # leaves samples that all sit exactly on the median, so the surviving
    # variation is zero; keeping them makes the deviation large.
    stack = np.full((20, 2, 2, 3), 10, dtype=np.uint8)
    stack[5] = 200
    stack[11] = 200

    trimmed, untrimmed = trimmed_stats(
        stack, [30.0, KEEP_ALL], with_deviation=True
    )
    assert np.allclose(trimmed.deviation, 0.0)
    assert np.array_equal(trimmed.kept_counts, np.full((2, 2), 18, dtype=np.int32))
    # 18 samples at distance 0, 2 at 190 * sqrt(3).
    assert untrimmed.deviation[0, 0] == pytest.approx(
        2 * 190 * SQRT3 / 20, abs=1e-3
    )


def test_deviation_is_zero_where_every_sample_was_rejected() -> None:
    # No kept samples means no measured variation; kept_counts is how a
    # caller tells this apart from a genuinely stable pixel.
    stack = np.zeros((2, 2, 2, 3), dtype=np.uint8)
    stack[1] = 255
    [stats] = trimmed_stats(stack, [100.0], with_deviation=True)
    assert stats.fallback_pixels == 4
    assert np.array_equal(stats.deviation, np.zeros((2, 2), dtype=np.float32))
    assert np.array_equal(stats.kept_counts, np.zeros((2, 2), dtype=np.int32))


def test_deviation_does_not_shrink_as_the_threshold_widens() -> None:
    # A wider threshold keeps a superset of the samples, and every added
    # sample is farther from the median than any already kept one.
    stack = np.zeros((20, 1, 1, 3), dtype=np.uint8)
    stack[:, 0, 0] = [[i * 5] * 3 for i in range(20)]
    outcomes = trimmed_stats(
        stack, [10.0, 35.0, 60.0, KEEP_ALL], with_deviation=True
    )
    deviations = [float(stats.deviation[0, 0]) for stats in outcomes]
    assert deviations == sorted(deviations)


def test_threshold_zero_rejects_everything_off_the_median() -> None:
    # Degenerate but valid: the median (47.5) equals no uint8 sample, so
    # every pixel falls back and no variation is measured anywhere.
    stack = np.zeros((20, 2, 2, 3), dtype=np.uint8)
    stack[:] = np.array([i * 5 for i in range(20)], dtype=np.uint8)[
        :, None, None, None
    ]
    [stats] = trimmed_stats(stack, [0.0], with_deviation=True)
    assert stats.fallback_pixels == 4
    assert np.array_equal(stats.kept_counts, np.zeros((2, 2), dtype=np.int32))
    assert np.allclose(stats.deviation, 0.0)


def test_band_size_does_not_change_results(monkeypatch: pytest.MonkeyPatch) -> None:
    # Banding exists only to bound memory: the median runs along the time
    # axis, so every pixel is independent and the split must be invisible.
    rng = np.random.default_rng(0)
    stack = rng.integers(0, 256, size=(6, 9, 5, 3), dtype=np.uint8)

    thresholds = [30.0, 80.0, KEEP_ALL]
    whole = trimmed_stats(stack, thresholds, with_deviation=True)

    # Small enough to force one row per band on this stack.
    monkeypatch.setattr(ts, "BAND_FLOAT_BUDGET", 1)
    banded = trimmed_stats(stack, thresholds, with_deviation=True)

    for one, other in zip(whole, banded, strict=True):
        assert np.array_equal(one.background, other.background)
        assert one.rejected_samples == other.rejected_samples
        assert one.fallback_pixels == other.fallback_pixels
        assert np.allclose(one.deviation, other.deviation, rtol=0, atol=1e-5)
        assert np.array_equal(one.kept_counts, other.kept_counts)


def test_rejects_negative_threshold() -> None:
    stack = np.zeros((2, 1, 1, 3), dtype=np.uint8)
    with pytest.raises(ValueError):
        trimmed_stats(stack, [30.0, -1.0])


def test_rejects_empty_thresholds() -> None:
    stack = np.zeros((2, 1, 1, 3), dtype=np.uint8)
    with pytest.raises(ValueError):
        trimmed_stats(stack, [])
