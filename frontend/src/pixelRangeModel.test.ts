import { describe, expect, it } from 'vitest'
import {
  BACKGROUND_BRIGHTNESS,
  computeDetectionView,
  MOVEMENT_FLOOR,
  type RangePlane,
} from './pixelRangeModel'

/** RGBA bytes from [r, g, b] triples, one per pixel. */
function pixels(triples: [number, number, number][]): Uint8ClampedArray {
  const data = new Uint8ClampedArray(triples.length * 4)
  triples.forEach(([r, g, b], i) => {
    data[i * 4] = r
    data[i * 4 + 1] = g
    data[i * 4 + 2] = b
    data[i * 4 + 3] = 255
  })
  return data
}

/** One range's bounds, as the decoded planes arrive. */
function plane(
  lower: [number, number, number][],
  upper: [number, number, number][],
): RangePlane {
  return { lower: pixels(lower), upper: pixels(upper) }
}

/** A plane no pixel uses, as the backend encodes an unused range. */
function unused(count: number): RangePlane {
  const empty: [number, number, number][] = new Array(count).fill([255, 255, 255])
  const zero: [number, number, number][] = new Array(count).fill([0, 0, 0])
  return plane(empty, zero)
}

const luma = (r: number, g: number, b: number) =>
  0.299 * r + 0.587 * g + 0.114 * b

describe('computeDetectionView', () => {
  // The whole reason this replaces the old frame test: neighbouring pixels
  // hold different colours and are judged against different boxes. The second
  // pixel's colour would be rejected by the first pixel's ranges and vice
  // versa, yet both are background.
  it('judges each pixel against its own ranges', () => {
    const frame = pixels([
      [190, 200, 198],
      [60, 62, 61],
    ])
    const model = [
      plane(
        [
          [188, 198, 196],
          [58, 60, 59],
        ],
        [
          [192, 202, 200],
          [62, 64, 63],
        ],
      ),
    ]

    const result = computeDetectionView(frame, model)
    expect(result.acceptedCount).toBe(2)
    expect(result.acceptedByRange).toEqual([2])
  })

  it('darkens accepted pixels to grayscale', () => {
    const frame = pixels([[190, 200, 198]])
    const result = computeDetectionView(frame, [
      plane([[180, 190, 188]], [[200, 210, 208]]),
    ])

    const expected = Math.round(luma(190, 200, 198) * BACKGROUND_BRIGHTNESS)
    expect(result.detection[0]).toBe(expected)
    expect(result.detection[0]).toBe(result.detection[1])
    expect(result.detection[1]).toBe(result.detection[2])
    expect(result.detection[3]).toBe(255)
  })

  // Roman's requirement, and the reason the lift is additive rather than a
  // scale: a black object on a dark floor is exactly the detection worth
  // confirming, and scaling would leave it black.
  it('lifts a pure black moving pixel to visible grey', () => {
    const frame = pixels([[0, 0, 0]])
    const result = computeDetectionView(frame, [unused(1)])

    expect(result.acceptedCount).toBe(0)
    expect(result.detection[0]).toBe(MOVEMENT_FLOOR)
    expect(result.detection[1]).toBe(MOVEMENT_FLOOR)
    expect(result.detection[2]).toBe(MOVEMENT_FLOOR)
  })

  it('keeps a rejected pixel above the floor and keeps its hue', () => {
    const frame = pixels([[40, 10, 10]])
    const result = computeDetectionView(frame, [unused(1)])

    expect(result.detection[0]).toBeGreaterThan(MOVEMENT_FLOOR)
    // Lifted equally on all three channels, so the red cast survives.
    expect(result.detection[0] - result.detection[1]).toBe(30)
    expect(result.detection[1]).toBe(result.detection[2])
  })

  it('takes the first matching range when two boxes overlap', () => {
    const frame = pixels([[100, 100, 100]])
    const result = computeDetectionView(frame, [
      plane([[90, 90, 90]], [[110, 110, 110]]),
      plane([[95, 95, 95]], [[105, 105, 105]]),
    ])

    expect(result.acceptedByRange).toEqual([1, 0])
  })

  // The backend writes lower above upper where a pixel uses fewer ranges than
  // were allowed, so the planes carry the per-pixel count implicitly.
  it('never accepts against an empty box', () => {
    const frame = pixels([
      [0, 0, 0],
      [128, 128, 128],
      [255, 255, 255],
    ])
    const result = computeDetectionView(frame, [unused(3)])

    expect(result.acceptedCount).toBe(0)
    expect(result.pixelCount).toBe(3)
  })

  it('rejects planes that do not match the frame', () => {
    expect(() =>
      computeDetectionView(pixels([[1, 2, 3]]), [unused(2)]),
    ).toThrow(/same dimensions/)
  })
})
