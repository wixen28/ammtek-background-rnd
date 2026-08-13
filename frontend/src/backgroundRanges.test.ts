import { describe, expect, it } from 'vitest'
import type { PixelSample } from './api'
import {
  acceptanceRuns,
  acceptingRangeIndex,
  bestCut,
  centralInterval,
  computeBackgroundRanges,
  DEFAULT_RANGE_SETTINGS,
  MAX_BACKGROUND_RANGES,
  otsuSplit,
} from './backgroundRanges'

/** Build timeline samples from [r, g, b] triples, one per frame. */
function samples(triples: [number, number, number][]): PixelSample[] {
  return triples.map(([r, g, b], i) => ({
    frame_index: i,
    timestamp_seconds: i / 10,
    r,
    g,
    b,
  }))
}

const repeat = (
  colour: [number, number, number],
  times: number,
): [number, number, number][] => new Array(times).fill(colour)

/** 256-bin counts from [value, count] pairs. */
function counts(pairs: [number, number][]): number[] {
  const bins = new Array<number>(256).fill(0)
  for (const [value, count] of pairs) bins[value] = count
  return bins
}

/** Prefix sums of a sorted array, as `bestCut` expects them. */
function prefixOf(sorted: number[]): number[] {
  const prefix = [0]
  for (const value of sorted) prefix.push(prefix[prefix.length - 1] + value)
  return prefix
}

/**
 * The hall's floor pixel (326, 227): a bright state for the first two thirds
 * of the video and a darker one after the crane/lighting change, which then
 * holds to the end. Shares match the measured 64 % / 34 % closely enough to
 * exercise the same decisions.
 */
const twoStatePixel = samples([
  ...repeat([190, 200, 198], 64),
  ...repeat([159, 168, 171], 36),
])

describe('otsuSplit', () => {
  it('splits two separated states at the gap between them', () => {
    const split = otsuSplit(counts([[159, 36], [190, 64]]))

    expect(split).not.toBeNull()
    // Every threshold from 159 to 189 separates the states equally well; the
    // lowest is reported so repeated runs agree.
    expect(split!.value).toBe(159)
    // Neither state has any spread, so all the variance is between them.
    expect(split!.separation).toBeCloseTo(1)
  })

  it('reports low separability for one spread-out state', () => {
    // A smooth hill, not two states: a split cuts through it, so most of the
    // variance stays inside the two halves.
    const split = otsuSplit(
      counts([
        [100, 1],
        [101, 4],
        [102, 10],
        [103, 14],
        [104, 10],
        [105, 4],
        [106, 1],
      ]),
    )

    expect(split!.separation).toBeLessThan(0.75)
  })

  it('has nothing to split for a constant or empty channel', () => {
    expect(otsuSplit(counts([[128, 40]]))).toBeNull()
    expect(otsuSplit(counts([]))).toBeNull()
  })
})

describe('bestCut', () => {
  const sorted = [10, 10, 10, 90, 90, 200, 200, 200]
  const prefix = prefixOf(sorted)

  it('cuts the whole run at its widest gap', () => {
    expect(bestCut(sorted, prefix, 0, sorted.length)?.cut).toBe(5)
  })

  // The point of the window form: a state is a contiguous slice of the sorted
  // order, so splitting it again is the same computation on fewer positions.
  it('cuts only inside the window it is given', () => {
    expect(bestCut(sorted, prefix, 0, 5)?.cut).toBe(3)
    expect(bestCut(sorted, prefix, 5, 8)).toBeNull()
  })

  it('never cuts between two equal values', () => {
    // A cut inside a run of one value is not realizable by a threshold.
    expect(bestCut([7, 7, 7], prefixOf([7, 7, 7]), 0, 3)).toBeNull()
  })
})

describe('centralInterval', () => {
  it('keeps the full range at width 1', () => {
    expect(centralInterval([10, 11, 12, 13, 14], 1)).toEqual([10, 14])
  })

  it('trims both tails by frame count, not by value', () => {
    // 10 samples, width 0.6 → keep 6, drop 2 from each end.
    expect(centralInterval([0, 1, 2, 3, 4, 5, 6, 7, 8, 200], 0.6)).toEqual([2, 7])
  })

  it('drops the extra sample from the low side on an odd trim', () => {
    // 10 samples, width 0.8 → keep 8, drop 2: one low, one high.
    expect(centralInterval([0, 1, 2, 3, 4, 5, 6, 7, 8, 9], 0.75)).toEqual([1, 8])
  })

  it('never returns an empty interval', () => {
    expect(centralInterval([42], 0.5)).toEqual([42, 42])
  })

  // Float error in `width * n` must not buy an extra frame.
  it('keeps exactly the requested share when it divides evenly', () => {
    const sorted = Array.from({ length: 10 }, (_, i) => i)
    expect(centralInterval(sorted, 0.9)).toEqual([0, 8])
  })
})

describe('computeBackgroundRanges — how many ranges (Accepted signal)', () => {
  it('keeps one range for a pixel that never changes', () => {
    const result = computeBackgroundRanges(samples(repeat([128, 130, 132], 20)))

    expect(result.split).toBeNull()
    expect(result.modeCount).toBe(1)
    expect(result.ranges).toHaveLength(1)
    expect(result.ranges[0].r).toEqual([128, 128])
    expect(result.achievedCoverage).toBe(1)
  })

  // The iteration's central case: the same pixel, the same data, two answers.
  it('accepts only the strongest state when it already covers the request', () => {
    const result = computeBackgroundRanges(twoStatePixel, {
      signal: 0.5,
      width: 0.5,
    })

    expect(result.ranges).toHaveLength(1)
    expect(result.ranges[0].modeFrames).toBe(64)
    expect(result.ranges[0].r).toEqual([190, 190])
    // The darker third is left rejected — which is the failure to look at.
    expect(result.achievedCoverage).toBeCloseTo(0.64)
    expect(result.verdicts[0]).toBe(0)
    expect(result.verdicts[99]).toBe(-1)
  })

  it('adds the second state when the strongest one falls short', () => {
    const result = computeBackgroundRanges(twoStatePixel, { signal: 0.9 })

    expect(result.ranges).toHaveLength(2)
    expect(result.ranges[0].modeFrames).toBe(64)
    expect(result.ranges[1].modeFrames).toBe(36)
    expect(result.ranges[1].r).toEqual([159, 159])
    expect(result.achievedCoverage).toBe(1)
    expect([...result.verdicts.slice(60, 70)]).toEqual([
      0, 0, 0, 0, 1, 1, 1, 1, 1, 1,
    ])
  })

  // Three ranges is what the cap at two used to make impossible: the third
  // state was absorbed into the box of whichever state it was grouped with,
  // gap and all. Both behaviours are pinned, because the cap is the control
  // that shows why the extra range exists.
  it('separates a third state when three ranges are allowed', () => {
    const threeStates = samples([
      ...repeat([20, 20, 20], 10),
      ...repeat([120, 120, 120], 10),
      ...repeat([220, 220, 220], 10),
    ])

    const three = computeBackgroundRanges(threeStates, { signal: 1, width: 1 })
    expect(three.modeCount).toBe(3)
    expect(three.ranges).toHaveLength(3)
    expect(three.ranges.map((range) => range.r).sort((a, b) => a[0] - b[0])).toEqual(
      [
        [20, 20],
        [120, 120],
        [220, 220],
      ],
    )
    // Nothing between the states is background any more.
    expect(acceptingRangeIndex(three.ranges, 170, 170, 170)).toBe(-1)

    const two = computeBackgroundRanges(threeStates, {
      signal: 1,
      width: 1,
      maxRanges: 2,
    })
    expect(two.ranges[0].r).toEqual([120, 220])
    expect(acceptingRangeIndex(two.ranges, 170, 170, 170)).toBe(0)
  })

  it('never accepts more than the cap', () => {
    const result = computeBackgroundRanges(
      samples([
        ...repeat([10, 10, 10], 6),
        ...repeat([90, 90, 90], 6),
        ...repeat([170, 170, 170], 6),
        ...repeat([250, 250, 250], 6),
      ]),
      { signal: 1, width: 1 },
    )

    expect(result.ranges.length).toBeLessThanOrEqual(MAX_BACKGROUND_RANGES)
  })

  // The state is big enough to satisfy the request on paper, but trimming it
  // to the central width leaves the box accepting far fewer frames than that.
  // The decision has to read what is accepted, or the control promises
  // coverage it never delivers — measured at 28.6 % accepted for a requested
  // 50 % on the hall's (326, 227) before this was fixed.
  it('adds a second range when the first box under-delivers on its state', () => {
    const spreadState = Array.from(
      { length: 14 },
      (_, i) => [180 + i, 0, 0] as [number, number, number],
    )
    const result = computeBackgroundRanges(
      samples([...spreadState, ...repeat([100, 0, 0], 6)]),
      { signal: 0.6, width: 0.6, maxRanges: 2 },
    )

    // The strongest state holds 70 % of the frames, over the requested 60 %…
    expect(result.ranges[0].share).toBeCloseTo(0.7)
    // …but its trimmed box accepts under 60 %, so the second range is added.
    expect(result.ranges[0].acceptedFrames / result.sampleCount).toBeLessThan(0.6)
    expect(result.ranges).toHaveLength(2)
  })

  // Capping at one range must still isolate a state: the comparison is
  // "the strongest state alone", not "the whole history as one state".
  it('honours a lower cap without widening the box to the whole history', () => {
    const result = computeBackgroundRanges(twoStatePixel, {
      signal: 0.9,
      maxRanges: 1,
    })

    expect(result.ranges).toHaveLength(1)
    expect(result.ranges[0].r).toEqual([190, 190])
    expect(result.achievedCoverage).toBeCloseTo(0.64)
  })

  it('reports which channel separated the states, and where', () => {
    const result = computeBackgroundRanges(twoStatePixel, { signal: 0.9 })

    // All three channels separate perfectly here, so red wins the tie.
    expect(result.split!.channel).toBe('r')
    expect(result.split!.value).toBe(159)
    expect(result.split!.separation).toBeCloseTo(1)
  })

  it('splits on the channel that separates best, not the widest one', () => {
    // Red drifts over a wide range without structure; blue holds two states.
    const result = computeBackgroundRanges(
      samples([
        [10, 100, 40],
        [90, 100, 41],
        [170, 100, 40],
        [250, 100, 41],
        [10, 100, 200],
        [90, 100, 201],
        [170, 100, 200],
        [250, 100, 201],
      ]),
      { signal: 0.9, maxRanges: 2 },
    )

    expect(result.split!.channel).toBe('b')
    expect(result.ranges).toHaveLength(2)
  })

  it('records the frame span of each state, so a temporal split is visible', () => {
    const result = computeBackgroundRanges(twoStatePixel, { signal: 0.9 })

    expect([result.ranges[0].firstFrame, result.ranges[0].lastFrame]).toEqual([
      0, 63,
    ])
    expect([result.ranges[1].firstFrame, result.ranges[1].lastFrame]).toEqual([
      64, 99,
    ])
  })
})

describe('computeBackgroundRanges — how wide each range is (Range width)', () => {
  it('spans the full observed spread of a state at width 1', () => {
    // One bright state with codec-scale jitter, plus a clearly separate dark
    // one so the split falls between the states rather than inside the jitter.
    const result = computeBackgroundRanges(
      samples([
        [188, 0, 0],
        [190, 0, 0],
        [192, 0, 0],
        [200, 0, 0],
        [100, 0, 0],
        [100, 0, 0],
      ]),
      { signal: 1, width: 1, maxRanges: 2 },
    )

    expect(result.ranges[0].r).toEqual([188, 200])
    expect(result.achievedCoverage).toBe(1)
  })

  it('trims the tails of a state as the width drops', () => {
    const spread = samples(
      Array.from(
        { length: 20 },
        (_, i) => [180 + i, 100, 100] as [number, number, number],
      ),
    )

    // One range only, so the trim is the only thing that moves.
    const wide = computeBackgroundRanges(spread, { width: 1, maxRanges: 1 })
    const narrow = computeBackgroundRanges(spread, { width: 0.5, maxRanges: 1 })

    expect(narrow.ranges[0].r[0]).toBeGreaterThan(wide.ranges[0].r[0])
    expect(narrow.ranges[0].r[1]).toBeLessThan(wide.ranges[0].r[1])
  })

  // The separation that makes the two controls worth having: the signal is
  // what buys ranges, the width is what widens them, and neither does the
  // other's job.
  it('changing the width alone never changes how many states were found', () => {
    for (const width of [0.5, 0.7, 0.9, 1]) {
      const result = computeBackgroundRanges(twoStatePixel, {
        signal: 0.9,
        width,
      })
      expect(result.modeCount).toBe(2)
      expect(result.ranges[0].modeFrames).toBe(64)
    }
  })

  it('changing the signal alone never changes a box', () => {
    const loose = computeBackgroundRanges(twoStatePixel, {
      signal: 1,
      width: 0.8,
    })
    const tight = computeBackgroundRanges(twoStatePixel, {
      signal: 0.5,
      width: 0.8,
    })

    expect(tight.ranges[0].r).toEqual(loose.ranges[0].r)
    // …only how many of them there are.
    expect(tight.ranges).toHaveLength(1)
    expect(loose.ranges).toHaveLength(2)
  })

  it('dilates a finished box by the tolerance, clamped to the domain', () => {
    const result = computeBackgroundRanges(
      samples(repeat([2, 128, 254], 10)),
      { tolerance: 5 },
    )

    expect(result.ranges[0].r).toEqual([0, 7])
    expect(result.ranges[0].g).toEqual([123, 133])
    expect(result.ranges[0].b).toEqual([249, 255])
  })

  // Tolerance is what a quantile cannot express: a pixel with no spread gets
  // no headroom from `width` at all, so its ordinary noise would be movement.
  it('lets a zero-spread pixel accept nearby noise', () => {
    const bare = computeBackgroundRanges(samples(repeat([100, 100, 100], 10)))
    const padded = computeBackgroundRanges(samples(repeat([100, 100, 100], 10)), {
      tolerance: 3,
    })

    expect(acceptingRangeIndex(bare.ranges, 102, 99, 100)).toBe(-1)
    expect(acceptingRangeIndex(padded.ranges, 102, 99, 100)).toBe(0)
  })

  it('leaves trimmed frames rejected, so the achieved coverage is honest', () => {
    // One state, one far outlier frame.
    const result = computeBackgroundRanges(
      samples([...repeat([100, 100, 100], 19), [10, 10, 10]]),
      { signal: 0.9, width: 0.9, maxRanges: 1 },
    )

    expect(result.ranges[0].r).toEqual([100, 100])
    expect(result.achievedCoverage).toBeCloseTo(0.95)
    expect(result.verdicts[19]).toBe(-1)
  })

  it('carries the state centre as a swatch colour', () => {
    const result = computeBackgroundRanges(twoStatePixel, { signal: 0.9 })

    expect(result.ranges[0].color).toEqual({ r: 190, g: 200, b: 198 })
    expect(result.ranges[1].color).toEqual({ r: 159, g: 168, b: 171 })
  })

  it('counts accepted frames per range and in total consistently', () => {
    const result = computeBackgroundRanges(twoStatePixel, { signal: 0.9 })

    const perRange = result.ranges.reduce((sum, r) => sum + r.acceptedFrames, 0)
    expect(perRange).toBe(result.acceptedFrames)
    expect(result.acceptedFrames).toBe(
      [...result.verdicts].filter((v) => v >= 0).length,
    )
  })

  it('is monotone: widening a box never rejects a frame it had accepted', () => {
    const noisy = samples([
      ...repeat([190, 200, 198], 30),
      ...repeat([191, 201, 199], 20),
      ...repeat([159, 168, 171], 15),
      ...repeat([40, 40, 40], 5),
    ])

    let previous = -1
    for (const width of [0.5, 0.6, 0.7, 0.8, 0.9, 1]) {
      const { acceptedFrames } = computeBackgroundRanges(noisy, {
        signal: 1,
        width,
      })
      expect(acceptedFrames).toBeGreaterThanOrEqual(previous)
      previous = acceptedFrames
    }
  })
})

describe('computeBackgroundRanges — guards', () => {
  it('throws without samples rather than inventing a range', () => {
    expect(() => computeBackgroundRanges([])).toThrow(/at least one sample/)
  })

  it('rejects a signal or width outside (0, 1]', () => {
    const input = samples(repeat([100, 100, 100], 4))
    expect(() => computeBackgroundRanges(input, { signal: 0 })).toThrow(/signal/)
    expect(() => computeBackgroundRanges(input, { signal: 1.5 })).toThrow(/signal/)
    expect(() => computeBackgroundRanges(input, { width: 0 })).toThrow(/width/)
    expect(() => computeBackgroundRanges(input, { width: 1.5 })).toThrow(/width/)
  })

  it('rejects a cap outside 1–3', () => {
    const input = samples(repeat([100, 100, 100], 4))
    expect(() => computeBackgroundRanges(input, { maxRanges: 0 })).toThrow(
      /maxRanges/,
    )
    expect(() => computeBackgroundRanges(input, { maxRanges: 4 })).toThrow(
      /maxRanges/,
    )
  })

  it('reports the settings it ran with, defaults included', () => {
    expect(computeBackgroundRanges(twoStatePixel).settings).toEqual(
      DEFAULT_RANGE_SETTINGS,
    )
    expect(
      computeBackgroundRanges(twoStatePixel, { signal: 0.7 }).settings,
    ).toEqual({ ...DEFAULT_RANGE_SETTINGS, signal: 0.7 })
  })
})

describe('acceptingRangeIndex', () => {
  const { ranges } = computeBackgroundRanges(twoStatePixel, { signal: 0.9 })

  it('accepts a colour inside a box on every channel', () => {
    expect(acceptingRangeIndex(ranges, 190, 200, 198)).toBe(0)
    expect(acceptingRangeIndex(ranges, 159, 168, 171)).toBe(1)
  })

  it('rejects a colour that misses on a single channel', () => {
    expect(acceptingRangeIndex(ranges, 190, 200, 120)).toBe(-1)
  })

  it('rejects a colour between the two states', () => {
    expect(acceptingRangeIndex(ranges, 175, 184, 185)).toBe(-1)
  })
})

describe('acceptanceRuns', () => {
  it('collapses consecutive frames with the same verdict', () => {
    expect(acceptanceRuns(new Int8Array([0, 0, -1, -1, -1, 1]))).toEqual([
      { start: 0, end: 1, accepted: true },
      { start: 2, end: 4, accepted: false },
      { start: 5, end: 5, accepted: true },
    ])
  })

  // Which range accepted a frame does not break the run: the strip plots
  // accepted vs rejected, and a state change inside "accepted" is not a gap.
  it('treats every accepting range alike', () => {
    expect(acceptanceRuns(new Int8Array([0, 1, 0]))).toEqual([
      { start: 0, end: 2, accepted: true },
    ])
  })

  it('covers every frame exactly once', () => {
    const verdicts = new Int8Array([0, -1, 0, 0, -1])
    const runs = acceptanceRuns(verdicts)

    expect(runs[0].start).toBe(0)
    expect(runs[runs.length - 1].end).toBe(verdicts.length - 1)
    expect(runs.reduce((sum, run) => sum + (run.end - run.start + 1), 0)).toBe(
      verdicts.length,
    )
  })

  it('returns nothing for no frames', () => {
    expect(acceptanceRuns(new Int8Array(0))).toEqual([])
  })
})
