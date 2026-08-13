/**
 * Which colours of one pixel are accepted as background.
 *
 * The histogram answers *which values occurred how often*; this answers *which
 * of them we would call background*, and draws the boundary the frame
 * simulation is then tested against.
 *
 * Three deliberate departures from a plain colour-distance threshold:
 *
 * - **Up to three accepted ranges, not one.** At the hall's floor pixel
 *   (326, 227) the crane/lighting change moves the floor from ~(190, 200, 198)
 *   to ~(159, 168, 171) and it stays there: both are the background, each for
 *   its own stretch of the video. One range cannot be right for the whole clip.
 * - **How many ranges is decided by frequency.** `signal` is the share of the
 *   pixel's frames the accepted set has to explain. A distance threshold asks
 *   "how far from one anchor colour may a pixel be", which cannot express a
 *   pixel that legitimately has two separated states — the anchor sits between
 *   them and the tolerance has to swallow both plus the empty gap.
 * - **How wide each range is is a separate control.** `width` trims each state
 *   to the central share of *its own* values, and `tolerance` then dilates the
 *   finished box by a fixed number of RGB values. These are different
 *   questions from `signal`: one asks which states are worth keeping, the
 *   other how much variation around a kept state is tolerated. One number
 *   driving both cannot loosen a box without also buying more boxes.
 *
 * Diagnostic only: nothing here feeds background generation. The same
 * derivation runs per pixel over the whole grid in
 * `backend/app/processing/background/pixel_ranges.py`, which is what the
 * whole-frame simulation classifies against.
 */

import type { PixelSample } from './api'
import { clampChannelValue, DOMAIN, medianOfSorted } from './histogram'
import { RGB_SERIES, type ChannelKey } from './rgbSeries'

/** Below this the control stops meaning "the strongest signal". */
export const MIN_SIGNAL = 0.5
export const MAX_SIGNAL = 1

/**
 * Enough that a second state is picked up whenever the strongest one leaves a
 * real remainder (at (326, 227) the bright state covers 64 %), while still
 * leaving the settings that produced the recorded runs as the starting point.
 */
export const DEFAULT_SIGNAL = 0.9

/** Below this a box keeps less than half its state and stops describing it. */
export const MIN_RANGE_WIDTH = 0.5
export const MAX_RANGE_WIDTH = 1
/** Trims the sparse tails — a passing object, codec outliers — off a state. */
export const DEFAULT_RANGE_WIDTH = 0.9

/**
 * Extra RGB values allowed on each side of a finished box.
 *
 * `width` is relative to a state's own spread, so a pixel that barely varies
 * gets almost no headroom from it and its ordinary sensor noise reads as
 * movement. `tolerance` is the absolute headroom that fixes, and it cannot be
 * expressed as a quantile.
 */
export const MIN_TOLERANCE = 0
export const MAX_TOLERANCE = 32
export const DEFAULT_TOLERANCE = 0

/** Matches `MAX_RANGES` in the backend model builder. */
export const MAX_BACKGROUND_RANGES = 3

/**
 * Separability difference below which two channels count as equally good at
 * separating the states, so the tie is broken by RGB order rather than by
 * float error. Far smaller than any difference worth acting on.
 */
const SEPARATION_TIE = 1e-9

/** What the accepted set has to explain, and how wide each box is. */
export interface RangeSettings {
  /** Share of the pixel's frames the accepted ranges together must cover. */
  signal: number
  /** Share of a single state's own values its box keeps, per channel. */
  width: number
  /** RGB values added to each side of a finished box. */
  tolerance: number
  /** Upper bound on how many ranges may be accepted. */
  maxRanges: number
}

export const DEFAULT_RANGE_SETTINGS: RangeSettings = {
  signal: DEFAULT_SIGNAL,
  width: DEFAULT_RANGE_WIDTH,
  tolerance: DEFAULT_TOLERANCE,
  maxRanges: MAX_BACKGROUND_RANGES,
}

/** One accepted colour state, as an axis-aligned box in RGB. */
export interface BackgroundRange {
  /** 1 = the state with the most frames. */
  rank: number
  /** Inclusive accepted bounds per channel. */
  r: [number, number]
  g: [number, number]
  b: [number, number]
  /** Per-channel median of the state's frames — its centre, and the swatch. */
  color: { r: number; g: number; b: number }
  /** Frames in this state before the box was trimmed. */
  modeFrames: number
  /** Frames the trimmed box actually accepts; ties go to the lower rank. */
  acceptedFrames: number
  /** `modeFrames` as a share of all analyzed frames. */
  share: number
  /** Frame indices the state spans — a temporal split shows up here. */
  firstFrame: number
  lastFrame: number
}

/** How the candidate states were first separated. */
export interface ModeSplit {
  channel: ChannelKey
  /** Values ≤ this fall in the low state. */
  value: number
  /**
   * Otsu separability of that channel, 0–1: the share of its total variance
   * that lies *between* the two states. Near 1 means two clean states, near 0
   * means the split cuts through one spread-out state.
   */
  separation: number
}

export interface BackgroundRanges {
  /** The settings this derivation ran with. */
  settings: RangeSettings
  sampleCount: number
  /** One to three, most frequent state first. */
  ranges: BackgroundRange[]
  /** Frames the union of the boxes accepts. */
  acceptedFrames: number
  /** `acceptedFrames / sampleCount` — what the settings actually achieved. */
  achievedCoverage: number
  /** Per sample, the index of the accepting range, or -1. Input order. */
  verdicts: Int8Array
  /** Null when no channel could be split (a pixel that never changes). */
  split: ModeSplit | null
  /** Candidate states found, before the signal rule chose from them. */
  modeCount: number
}

/**
 * Otsu's threshold over a 256-bin count array: the split that maximizes the
 * variance *between* the two sides.
 *
 * Returned alongside its separability, which is what makes the three channels
 * comparable — the raw between-class variance of a wide channel beats a narrow
 * one even when the narrow one separates far more cleanly.
 *
 * Null when there is nothing to split: no samples, or every sample on one
 * value.
 */
export function otsuSplit(
  counts: readonly number[],
): { value: number; separation: number } | null {
  let total = 0
  let sum = 0
  for (let value = 0; value < counts.length; value += 1) {
    total += counts[value]
    sum += value * counts[value]
  }
  if (total === 0) return null

  const mean = sum / total
  let variance = 0
  for (let value = 0; value < counts.length; value += 1) {
    variance += counts[value] * (value - mean) ** 2
  }
  variance /= total
  // A constant channel has no split, and no scale to measure one against.
  if (variance === 0) return null

  let weightLow = 0
  let sumLow = 0
  let best = 0
  let bestValue = -1
  for (let value = 0; value < counts.length; value += 1) {
    weightLow += counts[value]
    sumLow += value * counts[value]
    const weightHigh = total - weightLow
    if (weightLow === 0 || weightHigh === 0) continue

    const meanLow = sumLow / weightLow
    const meanHigh = (sum - sumLow) / weightHigh
    const between =
      (weightLow / total) * (weightHigh / total) * (meanLow - meanHigh) ** 2
    // Strictly greater: of the equally good thresholds between two clean
    // states, the lowest wins, so repeated runs report the same value.
    if (between > best) {
      best = between
      bestValue = value
    }
  }
  if (bestValue < 0) return null

  return { value: bestValue, separation: best / variance }
}

/**
 * Best Otsu cut of the sorted window `[low, high)`, as a sorted position.
 *
 * Recursion is cheap in this form: a state produced by thresholding a channel
 * is always a contiguous slice of that channel's sorted values, so splitting
 * it again is the same computation on a narrower window. `prefix[i]` is the
 * sum of the first `i` sorted values.
 *
 * Null when the window cannot be split — fewer than two distinct values in it.
 */
export function bestCut(
  sorted: readonly number[],
  prefix: readonly number[],
  low: number,
  high: number,
): { cut: number; between: number } | null {
  let best = 0
  let bestCutIndex = -1
  const span = high - low
  for (let cut = low + 1; cut < high; cut += 1) {
    // Never cut between two equal values: the state is defined by a value
    // threshold, so a cut inside a run of one value is not realizable.
    if (sorted[cut - 1] === sorted[cut]) continue
    const countLow = cut - low
    const countHigh = high - cut
    const meanLow = (prefix[cut] - prefix[low]) / countLow
    const meanHigh = (prefix[high] - prefix[cut]) / countHigh
    const between =
      ((countLow * countHigh) / (span * span)) * (meanLow - meanHigh) ** 2
    if (between > best) {
      best = between
      bestCutIndex = cut
    }
  }
  return bestCutIndex < 0 ? null : { cut: bestCutIndex, between: best }
}

/**
 * The central `width` of already sorted values, as inclusive bounds.
 *
 * Trims both tails by the same number of samples rather than by value, so the
 * interval is defined by how many frames it keeps — the whole point of a
 * frequency control. At width 1 it is the full observed range.
 */
export function centralInterval(
  sorted: readonly number[],
  width: number,
): [number, number] {
  const n = sorted.length
  // The epsilon absorbs float error in `width * n`, so a width that divides
  // the sample count evenly does not keep one extra frame.
  const keep = Math.min(n, Math.max(1, Math.ceil(width * n - 1e-9)))
  const dropLow = Math.floor((n - keep) / 2)
  return [sorted[dropLow], sorted[dropLow + keep - 1]]
}

/** Index of the first range accepting this colour, or -1. */
export function acceptingRangeIndex(
  ranges: readonly BackgroundRange[],
  r: number,
  g: number,
  b: number,
): number {
  for (let i = 0; i < ranges.length; i += 1) {
    const range = ranges[i]
    if (
      r >= range.r[0] &&
      r <= range.r[1] &&
      g >= range.g[0] &&
      g <= range.g[1] &&
      b >= range.b[0] &&
      b <= range.b[1]
    ) {
      return i
    }
  }
  return -1
}

/**
 * Derive the accepted background ranges of one pixel from its frame history.
 *
 * 1. **Candidate states.** The channel that separates best (highest Otsu
 *    separability) splits the **frames** in two; if more than two states are
 *    allowed, whichever state then holds the most frames and can still be
 *    split is split again, on the same channel. Splitting the frames rather
 *    than each channel independently is what keeps the boxes real colours:
 *    three independent two-way splits would describe eight corners, most of
 *    which the pixel never took. Two candidates are always produced, even when
 *    only one range is allowed — capping at one means "accept only the
 *    strongest state", not "treat the whole history as one state".
 * 2. **How wide each box is** — `width` and `tolerance`, per state, never
 *    touching how many states there are.
 * 3. **How many ranges** — `signal`. The strongest state is always accepted;
 *    the next only while the boxes so far accept less than `signal` of the
 *    frames.
 *
 * Always computed on raw values, never on the histogram's display bucket
 * width: the marked boundaries must not move when the bucketing is changed
 * for reading.
 */
export function computeBackgroundRanges(
  samples: readonly PixelSample[],
  overrides: Partial<RangeSettings> = {},
): BackgroundRanges {
  const settings: RangeSettings = { ...DEFAULT_RANGE_SETTINGS, ...overrides }
  const { signal, width, tolerance, maxRanges } = settings

  if (samples.length === 0) {
    throw new Error('Accepted ranges need at least one sample.')
  }
  if (!(signal > 0 && signal <= 1)) {
    throw new Error(`signal must be greater than 0 and at most 1; got ${signal}.`)
  }
  if (!(width > 0 && width <= 1)) {
    throw new Error(`width must be greater than 0 and at most 1; got ${width}.`)
  }
  if (!(tolerance >= 0)) {
    throw new Error(`tolerance must be zero or positive; got ${tolerance}.`)
  }
  if (maxRanges < 1 || maxRanges > MAX_BACKGROUND_RANGES) {
    throw new Error(
      `maxRanges must be between 1 and ${MAX_BACKGROUND_RANGES}; got ${maxRanges}.`,
    )
  }

  const sampleCount = samples.length
  const values = new Map<ChannelKey, number[]>(
    RGB_SERIES.map((series) => [series.key, [] as number[]]),
  )
  const counts = new Map<ChannelKey, number[]>(
    RGB_SERIES.map((series) => [series.key, new Array<number>(DOMAIN).fill(0)]),
  )

  for (const sample of samples) {
    for (const series of RGB_SERIES) {
      const value = clampChannelValue(sample[series.key])
      values.get(series.key)!.push(value)
      counts.get(series.key)![value] += 1
    }
  }

  let split: ModeSplit | null = null
  for (const series of RGB_SERIES) {
    const candidate = otsuSplit(counts.get(series.key)!)
    // The margin matters: when two clean states separate perfectly in all
    // three channels every separability is 1, and without it float error
    // decides which channel is reported. With it the tie falls to RGB order,
    // so the same pixel always reports the same split.
    if (
      candidate &&
      (split === null || candidate.separation > split.separation + SEPARATION_TIE)
    ) {
      split = { channel: series.key, ...candidate }
    }
  }

  // Sample indices ordered by the splitting channel. Every state is then a
  // contiguous slice of this order, which is what makes a further split a
  // window over the same array rather than a fresh clustering.
  const splitValues = split ? values.get(split.channel)! : null
  const order = Array.from({ length: sampleCount }, (_, i) => i)
  if (splitValues) order.sort((a, b) => splitValues[a] - splitValues[b])
  const sorted = splitValues ? order.map((i) => splitValues[i]) : []
  const prefix = new Array<number>(sorted.length + 1).fill(0)
  for (let i = 0; i < sorted.length; i += 1) prefix[i + 1] = prefix[i] + sorted[i]

  // Cut positions in `order`, ascending, delimiting the candidate states.
  // Two states are always attempted; a third only when it is allowed.
  const cuts: number[] = []
  if (split && splitValues) {
    let firstCut = 0
    while (firstCut < sampleCount && sorted[firstCut] <= split.value) firstCut += 1
    cuts.push(firstCut)

    if (Math.max(2, maxRanges) >= 3) {
      const low = { from: 0, to: firstCut }
      const high = { from: firstCut, to: sampleCount }
      // Split whichever state holds more frames; on a tie the lower-valued
      // one, so the result does not depend on float noise. If that one cannot
      // be split, the other is tried.
      const ordered =
        low.to - low.from >= high.to - high.from ? [low, high] : [high, low]
      for (const window of ordered) {
        const next = bestCut(sorted, prefix, window.from, window.to)
        if (next) {
          cuts.push(next.cut)
          break
        }
      }
    }
    cuts.sort((a, b) => a - b)
  }

  // Sample indices per candidate state, ascending within each state so the
  // frame span reads as first/last.
  const boundaries = [0, ...cuts, sampleCount]
  const modes: number[][] = []
  for (let i = 0; i < boundaries.length - 1; i += 1) {
    const slice = order.slice(boundaries[i], boundaries[i + 1])
    if (slice.length === 0) continue
    modes.push(slice.sort((a, b) => a - b))
  }
  if (modes.length === 0) modes.push(order.slice())
  // Most frequent first. Array.prototype.sort is stable, so two states of
  // equal size keep the lower-valued one first rather than swapping between
  // runs.
  modes.sort((a, b) => b.length - a.length)

  const buildRange = (indices: number[], rank: number): BackgroundRange => {
    const bounds = new Map<ChannelKey, [number, number]>()
    const centre = new Map<ChannelKey, number>()
    for (const series of RGB_SERIES) {
      const channelValues = values.get(series.key)!
      const channelSorted = indices
        .map((i) => channelValues[i])
        .sort((a, b) => a - b)
      const [low, high] = centralInterval(channelSorted, width)
      bounds.set(series.key, [
        clampChannelValue(low - tolerance),
        clampChannelValue(high + tolerance),
      ])
      centre.set(series.key, Math.round(medianOfSorted(channelSorted)))
    }
    return {
      rank,
      r: bounds.get('r')!,
      g: bounds.get('g')!,
      b: bounds.get('b')!,
      color: { r: centre.get('r')!, g: centre.get('g')!, b: centre.get('b')! },
      modeFrames: indices.length,
      acceptedFrames: 0,
      share: indices.length / sampleCount,
      firstFrame: samples[indices[0]].frame_index,
      lastFrame: samples[indices[indices.length - 1]].frame_index,
    }
  }

  // Ranges are added one at a time and each is scored as it lands, because the
  // decision has to be made on what the boxes *accept*, not on how big the
  // state is. The two differ: trimming a state to its central `width` drops
  // frames, and three per-channel intervals accept only their intersection. A
  // rule reading the raw state size would call a request satisfied while the
  // frames it promised to cover were still being rejected.
  const red = values.get('r')!
  const green = values.get('g')!
  const blue = values.get('b')!
  const ranges: BackgroundRange[] = []
  const verdicts = new Int8Array(sampleCount).fill(-1)
  let acceptedFrames = 0

  for (const mode of modes) {
    if (ranges.length >= maxRanges) break
    // Every range after the first is earned, not assumed.
    if (ranges.length > 0 && acceptedFrames / sampleCount >= signal) break

    const range = buildRange(mode, ranges.length + 1)
    const index = ranges.length
    ranges.push(range)
    // Only frames no earlier range took, which is what keeps `verdicts` and
    // the per-range counts first-match-wins — the same rule the whole-frame
    // simulation applies through the per-pixel model.
    for (let i = 0; i < sampleCount; i += 1) {
      if (verdicts[i] >= 0) continue
      if (acceptingRangeIndex([range], red[i], green[i], blue[i]) < 0) continue
      verdicts[i] = index
      range.acceptedFrames += 1
      acceptedFrames += 1
    }
  }

  return {
    settings,
    sampleCount,
    ranges,
    acceptedFrames,
    achievedCoverage: acceptedFrames / sampleCount,
    verdicts,
    split,
    modeCount: modes.length,
  }
}

/** A stretch of consecutive frames with the same verdict. */
export interface AcceptanceRun {
  start: number
  end: number
  accepted: boolean
}

/**
 * Run-length encode per-frame verdicts.
 *
 * A pixel with a sustained state change is a handful of runs over thousands of
 * frames, so the strip draws those instead of one mark per frame — and the
 * runs are what is worth reading anyway: a long rejected band is the failure,
 * a scatter of single rejected frames is a passing object.
 */
export function acceptanceRuns(verdicts: Int8Array): AcceptanceRun[] {
  const runs: AcceptanceRun[] = []
  for (let i = 0; i < verdicts.length; i += 1) {
    const accepted = verdicts[i] >= 0
    const last = runs[runs.length - 1]
    if (last && last.accepted === accepted) last.end = i
    else runs.push({ start: i, end: i, accepted })
  }
  return runs
}
