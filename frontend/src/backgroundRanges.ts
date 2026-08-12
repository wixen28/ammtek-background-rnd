/**
 * Which colours of one pixel are accepted as background.
 *
 * The histogram answers *which values occurred how often*; this answers *which
 * of them we would call background*, and draws a boundary the frame simulation
 * can then be tested against.
 *
 * Two deliberate departures from the existing movement threshold:
 *
 * - **The control is a frequency, not a distance.** `coverage` is the share of
 *   the pixel's frames the accepted set has to explain. A distance threshold
 *   asks "how far from one anchor colour may a pixel be", which cannot express
 *   a pixel that legitimately has two separated states — the anchor sits
 *   between them and the tolerance has to swallow both plus everything in
 *   between. A frequency asks "how much of what this pixel actually did counts
 *   as background", which is answerable for one state or for two.
 * - **Up to two accepted ranges, not one.** At the hall's floor pixel
 *   (326, 227) the crane/lighting change moves the floor from ~(190, 200, 198)
 *   to ~(159, 168, 171) and it stays there: both are the background, each for
 *   its own stretch of the video. One range cannot be right for the whole clip.
 *   Deliberately capped at two — an arbitrary number of modes is the next
 *   question, not this one.
 *
 * Diagnostic only: nothing here feeds background generation.
 */

import type { PixelSample } from './api'
import { clampChannelValue, DOMAIN, medianOfSorted } from './histogram'
import { RGB_SERIES, type ChannelKey } from './rgbSeries'

/** Below this the control stops meaning "the strongest signal". */
export const MIN_COVERAGE = 0.5
export const MAX_COVERAGE = 1

/**
 * Enough that a second state is picked up whenever the strongest one leaves a
 * real remainder (at (326, 227) the bright state covers 64 %), while still
 * trimming the sparse tails each state has.
 */
export const DEFAULT_COVERAGE = 0.9

/** See the module note: two states, not an arbitrary number. */
export const MAX_BACKGROUND_RANGES = 2

/**
 * Separability difference below which two channels count as equally good at
 * separating the states, so the tie is broken by RGB order rather than by
 * float error. Far smaller than any difference worth acting on.
 */
const SEPARATION_TIE = 1e-9

/**
 * How much of its brightness a rejected pixel keeps in the frame simulation.
 * The same dimming the movement view applies to its background, so the two
 * diagnostics read alike — only the roles are swapped, since here it is the
 * *accepted* set that carries the image.
 */
export const REJECTED_BRIGHTNESS = 0.08

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
  /** Frames in this state before the box was trimmed to `coverage`. */
  modeFrames: number
  /** Frames the trimmed box actually accepts; ties go to the lower rank. */
  acceptedFrames: number
  /** `modeFrames` as a share of all analyzed frames. */
  share: number
  /** Frame indices the state spans — a temporal split shows up here. */
  firstFrame: number
  lastFrame: number
}

/** How the candidate states were separated. */
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
  /** The requested share of frames, 0–1. */
  coverage: number
  sampleCount: number
  /** One or two, most frequent state first. */
  ranges: BackgroundRange[]
  /** Frames the union of the boxes accepts. */
  acceptedFrames: number
  /** `acceptedFrames / sampleCount` — what the setting actually achieved. */
  achievedCoverage: number
  /** Per sample, the index of the accepting range, or -1. Input order. */
  verdicts: Int8Array
  /** Null when no channel could be split (a pixel that never changes). */
  split: ModeSplit | null
  /** States found, before the coverage rule chose from them. */
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
 * The central `coverage` of already sorted values, as inclusive bounds.
 *
 * Trims both tails by the same number of samples rather than by value, so the
 * interval is defined by how many frames it keeps — the whole point of a
 * frequency control. At coverage 1 it is the full observed range.
 */
export function centralInterval(
  sorted: readonly number[],
  coverage: number,
): [number, number] {
  const n = sorted.length
  // The epsilon absorbs float error in `coverage * n`, so a coverage that
  // divides the sample count evenly does not keep one extra frame.
  const keep = Math.min(n, Math.max(1, Math.ceil(coverage * n - 1e-9)))
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
 * `coverage` drives both decisions, and only ever by frequency:
 *
 * 1. **How many ranges.** The strongest state is always accepted. The second
 *    is accepted only if the first range still leaves more than `coverage` of
 *    the frames rejected — so a stable pixel keeps one range and a pixel whose
 *    background genuinely changed gets two.
 * 2. **How wide each range is.** Each accepted state is trimmed per channel to
 *    the central `coverage` of its own values, dropping the sparse tails that
 *    are a passing object rather than the state itself.
 *
 * The states themselves come from an Otsu split of the channel that separates
 * best. Splitting the *frames* rather than each channel independently is what
 * keeps the two boxes real colours: three independent two-way splits would
 * describe eight corners, most of which the pixel never took.
 *
 * Always computed on raw values, never on the histogram's display bucket
 * width: the marked boundaries must not move when the bucketing is changed
 * for reading.
 */
export function computeBackgroundRanges(
  samples: readonly PixelSample[],
  coverage: number = DEFAULT_COVERAGE,
  maxRanges: number = MAX_BACKGROUND_RANGES,
): BackgroundRanges {
  if (samples.length === 0) {
    throw new Error('Accepted ranges need at least one sample.')
  }
  if (!(coverage > 0 && coverage <= 1)) {
    throw new Error(`coverage must be greater than 0 and at most 1; got ${coverage}.`)
  }
  if (maxRanges < 1) {
    throw new Error(`maxRanges must be at least 1; got ${maxRanges}.`)
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

  // Sample indices per candidate state, ascending within each state.
  const low: number[] = []
  const high: number[] = []
  if (split) {
    const splitValues = values.get(split.channel)!
    for (let i = 0; i < sampleCount; i += 1) {
      ;(splitValues[i] <= split.value ? low : high).push(i)
    }
  } else {
    for (let i = 0; i < sampleCount; i += 1) low.push(i)
  }

  // Most frequent first. Array.prototype.sort is stable, so two states of
  // equal size keep the low one first rather than swapping between runs.
  const modes = [low, high]
    .filter((mode) => mode.length > 0)
    .sort((a, b) => b.length - a.length)

  const buildRange = (indices: number[], rank: number): BackgroundRange => {
    const bounds = new Map<ChannelKey, [number, number]>()
    const centre = new Map<ChannelKey, number>()
    for (const series of RGB_SERIES) {
      const channelValues = values.get(series.key)!
      const sorted = indices.map((i) => channelValues[i]).sort((a, b) => a - b)
      bounds.set(series.key, centralInterval(sorted, coverage))
      centre.set(series.key, Math.round(medianOfSorted(sorted)))
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
  // state is. The two differ: trimming a state to its central `coverage` drops
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
    // The second state is earned, not assumed.
    if (ranges.length > 0 && acceptedFrames / sampleCount >= coverage) break

    const range = buildRange(mode, ranges.length + 1)
    const index = ranges.length
    ranges.push(range)
    // Only frames no earlier range took, which is what keeps `verdicts` and
    // the per-range counts first-match-wins — the same rule the frame
    // simulation applies through `acceptingRangeIndex`.
    for (let i = 0; i < sampleCount; i += 1) {
      if (verdicts[i] >= 0) continue
      if (acceptingRangeIndex([range], red[i], green[i], blue[i]) < 0) continue
      verdicts[i] = index
      range.acceptedFrames += 1
      acceptedFrames += 1
    }
  }

  return {
    coverage,
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

/** One frame classified against the accepted ranges. */
export interface AcceptanceView {
  /** Accepted pixels in their own colour, rejected ones dimmed grayscale. */
  view: Uint8ClampedArray
  /** Pixels accepted, per range, in range order. */
  acceptedByRange: number[]
  acceptedCount: number
  pixelCount: number
}

/**
 * Apply one pixel's accepted ranges to a whole frame.
 *
 * Note what this is and is not: the ranges describe *one* pixel's history, so
 * this answers "where else in the frame does that pixel's accepted background
 * colour appear", not "which pixels are background". A per-pixel verdict would
 * need per-pixel ranges for the whole grid. The exact per-frame answer for the
 * analyzed pixel itself is in `verdicts`, which this view is consistent with:
 * both go through `acceptingRangeIndex`.
 */
export function computeAcceptanceView(
  frame: Uint8ClampedArray,
  ranges: readonly BackgroundRange[],
): AcceptanceView {
  const view = new Uint8ClampedArray(frame.length)
  const acceptedByRange = new Array<number>(ranges.length).fill(0)
  let acceptedCount = 0

  for (let i = 0; i < frame.length; i += 4) {
    const index = acceptingRangeIndex(
      ranges,
      frame[i],
      frame[i + 1],
      frame[i + 2],
    )
    if (index >= 0) {
      view[i] = frame[i]
      view[i + 1] = frame[i + 1]
      view[i + 2] = frame[i + 2]
      acceptedByRange[index] += 1
      acceptedCount += 1
    } else {
      // Rec. 601 luma, dimmed — the same treatment the movement view gives
      // the pixels it is not showing.
      const luma =
        0.299 * frame[i] + 0.587 * frame[i + 1] + 0.114 * frame[i + 2]
      view[i] = view[i + 1] = view[i + 2] = luma * REJECTED_BRIGHTNESS
    }
    view[i + 3] = 255
  }

  return {
    view,
    acceptedByRange,
    acceptedCount,
    pixelCount: frame.length / 4,
  }
}
