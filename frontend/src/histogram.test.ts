import { describe, expect, it } from 'vitest'
import type { PixelSample } from './api'
import {
  assertBucketWidth,
  bucketIndexOf,
  computePixelHistogram,
  DEFAULT_BUCKET_WIDTH,
} from './histogram'

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

/** Repeat one colour `times` times. */
const repeat = (
  colour: [number, number, number],
  times: number,
): [number, number, number][] => new Array(times).fill(colour)

/** The channel histogram for one channel key. */
const channel = (
  histogram: ReturnType<typeof computePixelHistogram>,
  key: 'r' | 'g' | 'b',
) => histogram.channels.find((c) => c.channel === key)!

/** Buckets that actually hold samples, as [start, count] pairs. */
const occupied = (
  histogram: ReturnType<typeof computePixelHistogram>,
  key: 'r' | 'g' | 'b',
) =>
  channel(histogram, key)
    .buckets.filter((b) => b.count > 0)
    .map((b) => [b.start, b.count])

describe('bucketIndexOf', () => {
  it('places values in fixed-width buckets from 0', () => {
    expect(bucketIndexOf(0, 16)).toBe(0)
    expect(bucketIndexOf(15, 16)).toBe(0)
    expect(bucketIndexOf(16, 16)).toBe(1)
    expect(bucketIndexOf(255, 16)).toBe(15)
  })

  it('rounds fractional values and clamps outside 0–255', () => {
    expect(bucketIndexOf(15.4, 16)).toBe(0)
    expect(bucketIndexOf(15.6, 16)).toBe(1)
    expect(bucketIndexOf(-10, 16)).toBe(0)
    expect(bucketIndexOf(999, 16)).toBe(15)
  })
})

describe('assertBucketWidth', () => {
  it('accepts the widths offered in the UI', () => {
    for (const width of [4, 8, 16, 32]) {
      expect(() => assertBucketWidth(width)).not.toThrow()
    }
  })

  // A non-divisor would leave a narrower last bucket whose count is not
  // comparable with the rest — a false dip at the top of the range.
  it('rejects widths that do not divide 256', () => {
    expect(() => assertBucketWidth(10)).toThrow(/divide 256/)
    expect(() => assertBucketWidth(24)).toThrow(/divide 256/)
  })

  it('rejects non-positive and fractional widths', () => {
    expect(() => assertBucketWidth(0)).toThrow(/positive integer/)
    expect(() => assertBucketWidth(-16)).toThrow(/positive integer/)
    expect(() => assertBucketWidth(1.5)).toThrow(/positive integer/)
  })
})

describe('computePixelHistogram — buckets', () => {
  it('covers the whole 0–255 domain regardless of the observed range', () => {
    const histogram = computePixelHistogram(samples(repeat([100, 100, 100], 5)), 16)

    expect(histogram.bucketCount).toBe(16)
    expect(histogram.channels).toHaveLength(3)
    for (const c of histogram.channels) {
      expect(c.buckets).toHaveLength(16)
      expect(c.buckets[0].start).toBe(0)
      expect(c.buckets[0].end).toBe(15)
      expect(c.buckets[15].start).toBe(240)
      expect(c.buckets[15].end).toBe(255)
      // Every bucket the same width — the basis for comparing bar heights.
      expect(c.buckets.every((b) => b.end - b.start === 15)).toBe(true)
    }
  })

  it('keeps empty buckets, so a gap between two modes stays visible', () => {
    const histogram = computePixelHistogram(
      samples([...repeat([10, 10, 10], 3), ...repeat([200, 200, 200], 2)]),
      16,
    )

    expect(occupied(histogram, 'r')).toEqual([
      [0, 3],
      [192, 2],
    ])
    // The buckets between the two modes exist and are empty.
    expect(
      channel(histogram, 'r')
        .buckets.slice(1, 12)
        .every((b) => b.count === 0),
    ).toBe(true)
  })

  it('counts every sample exactly once per channel', () => {
    const histogram = computePixelHistogram(
      samples([
        [0, 1, 2],
        [255, 254, 253],
        [128, 127, 126],
        [7, 8, 9],
      ]),
    )

    expect(histogram.sampleCount).toBe(4)
    for (const c of histogram.channels) {
      expect(c.buckets.reduce((sum, b) => sum + b.count, 0)).toBe(4)
    }
    expect(histogram.bucketWidth).toBe(DEFAULT_BUCKET_WIDTH)
  })

  it('rebuckets the same samples at a different width', () => {
    const input = samples([
      [10, 10, 10],
      [20, 20, 20],
    ])

    // Width 32 puts both in one bucket; width 8 separates them.
    expect(occupied(computePixelHistogram(input, 32), 'r')).toEqual([[0, 2]])
    expect(occupied(computePixelHistogram(input, 8), 'r')).toEqual([
      [8, 1],
      [16, 1],
    ])
  })

  it('separates the three channels', () => {
    const histogram = computePixelHistogram(samples(repeat([200, 100, 10], 3)), 16)

    expect(occupied(histogram, 'r')).toEqual([[192, 3]])
    expect(occupied(histogram, 'g')).toEqual([[96, 3]])
    expect(occupied(histogram, 'b')).toEqual([[0, 3]])
  })

  it('clamps out-of-range values into the edge buckets', () => {
    const histogram = computePixelHistogram(
      samples([
        [-5, 300, 128],
        [400, -1, 128],
      ]),
      16,
    )

    expect(occupied(histogram, 'r')).toEqual([
      [0, 1],
      [240, 1],
    ])
    expect(channel(histogram, 'r').min).toBe(0)
    expect(channel(histogram, 'r').max).toBe(255)
  })

  it('throws without samples rather than inventing an empty distribution', () => {
    expect(() => computePixelHistogram([])).toThrow(/at least one sample/)
  })

  it('propagates an unusable bucket width', () => {
    expect(() => computePixelHistogram(samples(repeat([1, 1, 1], 1)), 10)).toThrow(
      /divide 256/,
    )
  })
})

describe('computePixelHistogram — per-channel statistics', () => {
  it('reports the median of an odd sample count', () => {
    const histogram = computePixelHistogram(
      samples([
        [10, 0, 0],
        [200, 0, 0],
        [30, 0, 0],
      ]),
    )
    expect(channel(histogram, 'r').median).toBe(30)
  })

  it('averages the two middle samples for an even count', () => {
    const histogram = computePixelHistogram(
      samples([
        [10, 0, 0],
        [20, 0, 0],
        [30, 0, 0],
        [41, 0, 0],
      ]),
    )
    // Kept unrounded: 25 here, and .5 values are reported as such.
    expect(channel(histogram, 'r').median).toBe(25)
    expect(
      channel(
        computePixelHistogram(
          samples([
            [10, 0, 0],
            [11, 0, 0],
          ]),
        ),
        'r',
      ).median,
    ).toBe(10.5)
  })

  it('reports the observed min and max', () => {
    const histogram = computePixelHistogram(
      samples([
        [10, 5, 200],
        [250, 6, 100],
      ]),
    )
    expect(channel(histogram, 'r').min).toBe(10)
    expect(channel(histogram, 'r').max).toBe(250)
    expect(channel(histogram, 'b').min).toBe(100)
    expect(channel(histogram, 'b').max).toBe(200)
  })

  it('picks the fullest bucket, lowest index on a tie', () => {
    const histogram = computePixelHistogram(
      samples([...repeat([10, 0, 0], 2), ...repeat([200, 0, 0], 2)]),
      16,
    )
    const red = channel(histogram, 'r')
    // Buckets 0 and 12 both hold 2 samples.
    expect(red.peakIndex).toBe(0)
    expect(red.buckets[red.peakIndex].count).toBe(2)
  })

  it('shares one y scale across the channels', () => {
    // Red spreads over two buckets, blue is concentrated in one.
    const histogram = computePixelHistogram(
      samples([
        [10, 10, 10],
        [200, 10, 10],
      ]),
      16,
    )
    expect(histogram.maxCount).toBe(2)
    expect(channel(histogram, 'r').buckets[0].count).toBe(1)
    expect(channel(histogram, 'b').buckets[0].count).toBe(2)
  })
})

describe('computePixelHistogram — joint colour clusters', () => {
  it('reports one cluster for a pixel that never changes', () => {
    const histogram = computePixelHistogram(samples(repeat([100, 100, 100], 8)), 16)

    expect(histogram.clusters).toHaveLength(1)
    expect(histogram.clusters[0].count).toBe(8)
    expect(histogram.clusters[0].share).toBe(1)
    expect(histogram.clusters[0].r).toEqual([96, 111])
  })

  it('groups near-identical values into the same cluster', () => {
    // Codec noise within one bucket must not read as separate modes.
    const histogram = computePixelHistogram(
      samples([
        [100, 100, 100],
        [102, 98, 101],
        [99, 103, 97],
      ]),
      16,
    )
    expect(histogram.clusters).toHaveLength(1)
    expect(histogram.clusters[0].count).toBe(3)
  })

  it('ranks two modes by frequency, most frequent first', () => {
    const histogram = computePixelHistogram(
      samples([...repeat([200, 200, 200], 3), ...repeat([20, 20, 20], 7)]),
      16,
    )

    expect(histogram.clusters).toHaveLength(2)
    expect(histogram.clusters[0].count).toBe(7)
    expect(histogram.clusters[0].r).toEqual([16, 31])
    expect(histogram.clusters[0].share).toBeCloseTo(0.7)
    expect(histogram.clusters[1].count).toBe(3)
    expect(histogram.clusters[1].share).toBeCloseTo(0.3)
  })

  // The reason the joint view exists: a marginal can look perfectly stable
  // while the pixel is switching between two colours.
  it('finds modes that a single channel marginal hides', () => {
    const histogram = computePixelHistogram(
      samples([...repeat([128, 128, 128], 5), ...repeat([128, 32, 200], 5)]),
      16,
    )

    // Red alone: one bucket, ten samples — indistinguishable from a stable pixel.
    expect(occupied(histogram, 'r')).toEqual([[128, 10]])
    // Jointly: two equally strong modes.
    expect(histogram.clusters).toHaveLength(2)
    expect(histogram.clusters.map((c) => c.count)).toEqual([5, 5])
  })

  it('carries a swatch colour at the bucket centre', () => {
    const histogram = computePixelHistogram(samples(repeat([100, 100, 100], 2)), 16)
    // Bucket 96–111, centre 103.5 → 104.
    expect(histogram.clusters[0].color).toEqual({ r: 104, g: 104, b: 104 })
  })

  it('accounts for every frame across the clusters', () => {
    const histogram = computePixelHistogram(
      samples([
        [10, 20, 30],
        [10, 20, 30],
        [200, 20, 30],
        [90, 200, 30],
        [90, 200, 200],
      ]),
      16,
    )

    expect(histogram.clusters.reduce((sum, c) => sum + c.count, 0)).toBe(5)
    expect(histogram.clusters.reduce((sum, c) => sum + c.share, 0)).toBeCloseTo(1)
  })

  it('orders tied clusters by value, so repeated runs match', () => {
    const histogram = computePixelHistogram(
      samples([
        [200, 0, 0],
        [16, 0, 0],
        [100, 0, 0],
      ]),
      16,
    )

    expect(histogram.clusters.map((c) => c.r[0])).toEqual([16, 96, 192])
  })

  it('keeps clusters distinct at a fine width and merges them at a coarse one', () => {
    const input = samples([...repeat([100, 100, 100], 2), ...repeat([110, 110, 110], 2)])

    expect(computePixelHistogram(input, 4).clusters).toHaveLength(2)
    expect(computePixelHistogram(input, 32).clusters).toHaveLength(1)
  })
})
