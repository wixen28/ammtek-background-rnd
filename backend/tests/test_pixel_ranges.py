"""Per-pixel accepted background ranges.

The stacks here are tiny and hand-built so the expected boxes can be read off
by hand — the point is that the vectorized whole-grid derivation makes the
same decisions as the single-pixel one in the browser, pixel for pixel.

Channel order is the frames' own (OpenCV's B, G, R), so a triple written here
as ``(b, g, r)`` is what the client sees as ``rgb(r, g, b)``.
"""

import numpy as np
import pytest

from app.processing.background.pixel_ranges import (
    UNUSED_LOWER,
    UNUSED_UPPER,
    build_pixel_ranges,
)


def stack_of(histories: list[list[tuple[int, int, int]]]) -> np.ndarray:
    """A (frames, 1, pixels, 3) stack from one colour history per pixel."""
    frames = len(histories[0])
    assert all(len(history) == frames for history in histories)
    array = np.zeros((frames, 1, len(histories), 3), dtype=np.uint8)
    for pixel, history in enumerate(histories):
        for index, colour in enumerate(history):
            array[index, 0, pixel] = colour
    return array


def repeat(colour: tuple[int, int, int], times: int) -> list[tuple[int, int, int]]:
    return [colour] * times


# The hall's floor pixel: a bright state for the first two thirds of the clip
# and a darker one after the crane/lighting change, which then holds. Written
# as (b, g, r) — rgb(190, 200, 198) and rgb(159, 168, 171).
BRIGHT = (198, 200, 190)
DARK = (171, 168, 159)
TWO_STATE = repeat(BRIGHT, 64) + repeat(DARK, 36)


def test_single_state_pixel_uses_one_range():
    planes, share, by_count = build_pixel_ranges(
        stack_of([repeat((132, 130, 128), 20)]), max_ranges=3
    )

    assert by_count == [1, 0, 0]
    assert share == 1.0
    assert planes[0].pixels == 1
    assert list(planes[0].lower[0, 0]) == [132, 130, 128]
    assert list(planes[0].upper[0, 0]) == [132, 130, 128]
    # Unused ranges are empty boxes, so the client rejects against them
    # without needing to be told how many ranges the pixel has.
    for plane in planes[1:]:
        assert plane.pixels == 0
        assert list(plane.lower[0, 0]) == [UNUSED_LOWER] * 3
        assert list(plane.upper[0, 0]) == [UNUSED_UPPER] * 3


def test_second_state_earned_only_when_the_first_falls_short():
    """The iteration's central case: same pixel, same data, two answers."""
    weak, _, weak_counts = build_pixel_ranges(
        stack_of([TWO_STATE]), signal=0.5, range_width=0.5, max_ranges=3
    )
    strong, _, strong_counts = build_pixel_ranges(
        stack_of([TWO_STATE]), signal=0.9, range_width=0.9, max_ranges=3
    )

    # 64 % of frames are the bright state, which already covers a 50 % ask.
    assert weak_counts == [1, 0, 0]
    assert list(weak[0].lower[0, 0]) == list(BRIGHT)
    # 90 % is more than the bright state can explain, so the dark state is
    # accepted too — and only two states exist, so the cap of three is unused.
    assert strong_counts == [0, 1, 0]
    assert list(strong[1].lower[0, 0]) == list(DARK)
    assert strong[2].pixels == 0


def test_one_range_cap_keeps_the_strongest_state_not_the_whole_history():
    """Capping at one range must still isolate a state, not span both."""
    planes, share, _ = build_pixel_ranges(
        stack_of([TWO_STATE]), signal=0.9, max_ranges=1
    )

    assert list(planes[0].lower[0, 0]) == list(BRIGHT)
    assert list(planes[0].upper[0, 0]) == list(BRIGHT)
    # The dark tail stays rejected, which is the failure worth seeing.
    assert share == pytest.approx(0.64)


def test_three_states_get_three_ranges_and_two_ranges_absorb_one():
    history = (
        repeat((20, 20, 20), 10) + repeat((120, 120, 120), 10) + repeat((220, 220, 220), 10)
    )

    three, three_share, _ = build_pixel_ranges(
        stack_of([history]), signal=1, range_width=1, max_ranges=3
    )
    two, _, _ = build_pixel_ranges(
        stack_of([history]), signal=1, range_width=1, max_ranges=2
    )

    # Every state gets its own box, so nothing between them is accepted.
    assert three_share == 1.0
    bounds = sorted(int(plane.lower[0, 0, 0]) for plane in three)
    assert bounds == [20, 120, 220]
    # Capped at two, the third state shares a box with whichever state it was
    # split from, and that box spans the gap between them.
    spans = [
        (int(plane.lower[0, 0, 0]), int(plane.upper[0, 0, 0]))
        for plane in two
        if plane.pixels
    ]
    assert (120, 220) in spans


def test_range_width_trims_the_state_and_tolerance_widens_it():
    # A featureless drift, so the only structure is the spread itself. Otsu
    # still cuts it in half — a state is whatever the split produced, and
    # capping at one range accepts the lower half (the tie goes to the lower
    # values), which is why `wide` ends at 189 rather than at 199.
    drift = [(100, 100, 180 + i) for i in range(20)]

    wide, _, _ = build_pixel_ranges(stack_of([drift]), range_width=1, max_ranges=1)
    narrow, _, _ = build_pixel_ranges(stack_of([drift]), range_width=0.5, max_ranges=1)
    padded, _, _ = build_pixel_ranges(
        stack_of([drift]), range_width=0.5, tolerance=4, max_ranges=1
    )

    assert (int(wide[0].lower[0, 0, 2]), int(wide[0].upper[0, 0, 2])) == (180, 189)
    low, high = int(narrow[0].lower[0, 0, 2]), int(narrow[0].upper[0, 0, 2])
    # 10 frames, keep the central 5, drop 2 from each side.
    assert (low, high) == (182, 186)
    # Tolerance dilates the finished box by a fixed number of values, which is
    # what `range_width` cannot express: a quantile is relative to the state's
    # spread, so a pixel with almost no spread gets almost no headroom.
    assert int(padded[0].lower[0, 0, 2]) == low - 4
    assert int(padded[0].upper[0, 0, 2]) == high + 4


def test_pixels_are_judged_against_their_own_ranges():
    """The whole point: neighbouring pixels get different boxes."""
    planes, _, by_count = build_pixel_ranges(
        stack_of(
            [
                repeat((10, 10, 10), 12),
                repeat((250, 250, 250), 12),
                repeat(BRIGHT, 8) + repeat(DARK, 4),
            ]
        ),
        signal=0.9,
        max_ranges=2,
    )

    assert list(planes[0].lower[0, 0]) == [10, 10, 10]
    assert list(planes[0].lower[0, 1]) == [250, 250, 250]
    assert list(planes[0].lower[0, 2]) == list(BRIGHT)
    assert by_count == [2, 1]


def test_banding_cannot_change_the_result():
    rng = np.random.default_rng(7)
    stack = rng.integers(0, 256, size=(24, 40, 9, 3), dtype=np.uint8)

    whole, whole_share, whole_counts = build_pixel_ranges(stack, max_ranges=3)
    # Same grid, one row at a time: pixels are independent along the time
    # axis, so the band size must not be able to move a single bound.
    banded_top, _, _ = build_pixel_ranges(stack[:, :20], max_ranges=3)
    banded_bottom, _, _ = build_pixel_ranges(stack[:, 20:], max_ranges=3)

    for rank in range(3):
        assert np.array_equal(whole[rank].lower[:20], banded_top[rank].lower)
        assert np.array_equal(whole[rank].upper[20:], banded_bottom[rank].upper)
    assert sum(whole_counts) <= stack.shape[1] * stack.shape[2]
    assert 0 <= whole_share <= 1


def test_guards():
    with pytest.raises(ValueError, match="two sampled frames"):
        build_pixel_ranges(stack_of([repeat((1, 2, 3), 1)]))
    with pytest.raises(ValueError, match="signal"):
        build_pixel_ranges(stack_of([repeat((1, 2, 3), 4)]), signal=0)
    with pytest.raises(ValueError, match="range_width"):
        build_pixel_ranges(stack_of([repeat((1, 2, 3), 4)]), range_width=1.5)
    with pytest.raises(ValueError, match="max_ranges"):
        build_pixel_ranges(stack_of([repeat((1, 2, 3), 4)]), max_ranges=4)
