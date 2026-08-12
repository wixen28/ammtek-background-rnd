/**
 * Bucketed value distribution of one pixel's RGB samples over time.
 *
 * The timeline answers *when* values occurred; this answers *which values
 * occurred how often*. Two representations are produced, deliberately:
 *
 * - **Per-channel marginals** — one histogram per channel over fixed-width
 *   buckets on the full 0–255 domain. Per channel because that is the unit
 *   the background methods actually work in (the temporal median is taken
 *   per channel), and fixed-width on the full domain — never scaled to the
 *   observed range — so histograms stay comparable between pixels: a stable
 *   pixel must read as one narrow spike, not as a spread-out distribution
 *   stretched to fill the axis.
 * - **Joint colour clusters** — the same bucketing applied to the (R, G, B)
 *   triple, counted as one key. Three independent marginals can each look
 *   single-peaked while the joint distribution has two clear modes (a floor
 *   colour plus whatever passes over it), so marginals alone would hide
 *   exactly the multi-mode case this diagnostic exists to find.
 *
 * Diagnostic only: nothing here feeds background generation.
 */

import type { PixelSample } from './api'
import { RGB_SERIES, type ChannelKey } from './rgbSeries'

/** Number of distinct 8-bit values a channel can take. */
export const DOMAIN = 256
const VALUE_MAX = DOMAIN - 1

/**
 * Bucket widths offered in the UI, from fine to coarse. All divide 256 (see
 * `assertBucketWidth`) and cover a useful range: 1 → no grouping at all, one
 * bar per 8-bit value, 4 → 64 buckets resolves codec noise, 32 → 8 buckets
 * shows only gross structure.
 *
 * Width 1 is the ungrouped reference view. Every wider bucketing imposes
 * boundaries the data knows nothing about, so a single physical state whose
 * values straddle a boundary splits into two adjacent bars and reads as two
 * modes. Width 1 has no boundaries to straddle: it is the only setting that
 * shows the raw frequency pattern, against which a split seen at 8/16/32 can
 * be judged as an artifact of the grid rather than a second state.
 */
export const BUCKET_WIDTHS = [1, 4, 8, 16, 32] as const
export type BucketWidth = (typeof BUCKET_WIDTHS)[number]

/** 16 → 16 buckets: fine enough to separate two modes, coarse enough that
 *  a few hundred frames fill the occupied buckets visibly. */
export const DEFAULT_BUCKET_WIDTH: BucketWidth = 16

export interface HistogramBucket {
  index: number
  /** Inclusive value bounds of the bucket. */
  start: number
  end: number
  /** Number of analyzed frames whose value fell in this bucket. */
  count: number
}

export interface ChannelHistogram {
  channel: ChannelKey
  /** One entry per bucket, always the full domain — empty buckets included,
   *  so gaps between modes are visible rather than closed up. */
  buckets: HistogramBucket[]
  /** Exact median of this channel's samples (may end in .5 for an even
   *  sample count). Shown as a reference marker only — this recomputes what
   *  the background methods use per channel, it does not feed them. */
  median: number
  min: number
  max: number
  /** Index of the fullest bucket; the lowest index wins ties. */
  peakIndex: number
}

/** One occupied bucket of the joint (R, G, B) distribution. */
export interface ColorCluster {
  /** Inclusive bucket bounds per channel. */
  r: [number, number]
  g: [number, number]
  b: [number, number]
  /** Bucket centre — a swatch colour for display, not an observed sample. */
  color: { r: number; g: number; b: number }
  count: number
  /** Fraction of all analyzed frames, 0–1. */
  share: number
}

export interface PixelHistogram {
  bucketWidth: number
  bucketCount: number
  /** Frames the distribution is over. */
  sampleCount: number
  /** In `RGB_SERIES` order: red, green, blue. */
  channels: ChannelHistogram[]
  /** Largest bucket count across all three channels — the shared y scale,
   *  so channel heights stay comparable. */
  maxCount: number
  /** Occupied joint buckets, most frequent first; ties broken by value so
   *  the order is stable. */
  clusters: ColorCluster[]
}

/**
 * Reject bucket widths that would make the histogram lie.
 *
 * A width that does not divide 256 leaves a narrower final bucket, whose
 * count is then not comparable with the others — it would show a false dip
 * at the top of the range. Requiring a divisor keeps every bar the same
 * width, which is the whole basis for reading bar heights against each other.
 */
export function assertBucketWidth(bucketWidth: number): void {
  if (!Number.isInteger(bucketWidth) || bucketWidth < 1) {
    throw new Error('bucketWidth must be a positive integer.')
  }
  if (DOMAIN % bucketWidth !== 0) {
    throw new Error(
      `bucketWidth must divide ${DOMAIN} so every bucket is the same width; got ${bucketWidth}.`,
    )
  }
}

/**
 * Round and clamp one channel value into the 0–255 domain, so an out-of-range
 * value lands on the edge instead of outside the array. Shared with the
 * accepted-range derivation, which must read the samples exactly as the
 * histogram does or its markings would sit beside the bars they describe.
 */
export function clampChannelValue(value: number): number {
  return Math.min(VALUE_MAX, Math.max(0, Math.round(value)))
}

/** Bucket a single channel value. */
export function bucketIndexOf(value: number, bucketWidth: number): number {
  return Math.floor(clampChannelValue(value) / bucketWidth)
}

export function medianOfSorted(sorted: number[]): number {
  const mid = sorted.length >> 1
  return sorted.length % 2 === 1
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2
}

/** Compute both representations from one pass over the samples. */
export function computePixelHistogram(
  samples: PixelSample[],
  bucketWidth: number = DEFAULT_BUCKET_WIDTH,
): PixelHistogram {
  assertBucketWidth(bucketWidth)
  if (samples.length === 0) {
    throw new Error('A histogram needs at least one sample.')
  }

  const bucketCount = DOMAIN / bucketWidth
  const counts = new Map<ChannelKey, number[]>(
    RGB_SERIES.map((series) => [
      series.key,
      new Array<number>(bucketCount).fill(0),
    ]),
  )
  const values = new Map<ChannelKey, number[]>(
    RGB_SERIES.map((series) => [series.key, [] as number[]]),
  )
  // Joint counts keyed by the bucket triple packed into one integer.
  const jointCounts = new Map<number, number>()

  for (const sample of samples) {
    let jointKey = 0
    for (const series of RGB_SERIES) {
      const index = bucketIndexOf(sample[series.key], bucketWidth)
      counts.get(series.key)![index] += 1
      values.get(series.key)!.push(clampChannelValue(sample[series.key]))
      jointKey = jointKey * bucketCount + index
    }
    jointCounts.set(jointKey, (jointCounts.get(jointKey) ?? 0) + 1)
  }

  const channels: ChannelHistogram[] = RGB_SERIES.map((series) => {
    const channelCounts = counts.get(series.key)!
    const sorted = [...values.get(series.key)!].sort((a, b) => a - b)
    let peakIndex = 0
    for (let i = 1; i < channelCounts.length; i++) {
      if (channelCounts[i] > channelCounts[peakIndex]) peakIndex = i
    }
    return {
      channel: series.key,
      buckets: channelCounts.map((count, index) => ({
        index,
        start: index * bucketWidth,
        end: index * bucketWidth + bucketWidth - 1,
        count,
      })),
      median: medianOfSorted(sorted),
      min: sorted[0],
      max: sorted[sorted.length - 1],
      peakIndex,
    }
  })

  const maxCount = channels.reduce(
    (max, channel) =>
      channel.buckets.reduce((rowMax, bucket) => Math.max(rowMax, bucket.count), max),
    0,
  )

  const bounds = (index: number): [number, number] => [
    index * bucketWidth,
    index * bucketWidth + bucketWidth - 1,
  ]
  const centre = (index: number) => index * bucketWidth + (bucketWidth - 1) / 2

  const clusters: ColorCluster[] = [...jointCounts.entries()]
    .map(([jointKey, count]) => {
      const bi = jointKey % bucketCount
      const gi = Math.floor(jointKey / bucketCount) % bucketCount
      const ri = Math.floor(jointKey / (bucketCount * bucketCount))
      return {
        r: bounds(ri),
        g: bounds(gi),
        b: bounds(bi),
        color: {
          r: Math.round(centre(ri)),
          g: Math.round(centre(gi)),
          b: Math.round(centre(bi)),
        },
        count,
        share: count / samples.length,
      }
    })
    // Most frequent first; value order breaks ties so repeated runs on the
    // same pixel always list clusters identically.
    .sort(
      (a, b) =>
        b.count - a.count ||
        a.r[0] - b.r[0] ||
        a.g[0] - b.g[0] ||
        a.b[0] - b.b[0],
    )

  return {
    bucketWidth,
    bucketCount,
    sampleCount: samples.length,
    channels,
    maxCount,
    clusters,
  }
}
