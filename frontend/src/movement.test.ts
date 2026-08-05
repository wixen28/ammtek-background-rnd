import { describe, expect, it } from 'vitest'
import { computeMovementViews } from './movement'

/** Build an RGBA buffer from [r, g, b] triples, one per pixel. */
function rgba(pixels: [number, number, number][]): Uint8ClampedArray {
  const data = new Uint8ClampedArray(pixels.length * 4)
  pixels.forEach(([r, g, b], i) => {
    data[i * 4] = r
    data[i * 4 + 1] = g
    data[i * 4 + 2] = b
    data[i * 4 + 3] = 255
  })
  return data
}

/** The mask value of pixel ``i`` (0 or 255). */
const maskAt = (mask: Uint8ClampedArray, i: number) => mask[i * 4]

/** The RGBA tuple of pixel ``i``. */
const pixelAt = (data: Uint8ClampedArray, i: number) =>
  Array.from(data.slice(i * 4, i * 4 + 4))

describe('computeMovementViews', () => {
  it('marks nothing as foreground when frame and background are identical', () => {
    const image = rgba([
      [10, 20, 30],
      [200, 100, 50],
      [0, 0, 0],
      [255, 255, 255],
    ])
    const views = computeMovementViews(image, image.slice(), 30)

    expect(views.foregroundCount).toBe(0)
    expect(views.pixelCount).toBe(4)
    expect([...views.mask].filter((_, i) => i % 4 !== 3)).toEqual(
      new Array(12).fill(0),
    )
    // Difference is uniformly black when there is nothing to show.
    expect([...views.difference].filter((_, i) => i % 4 !== 3)).toEqual(
      new Array(12).fill(0),
    )
  })

  it('marks nothing as foreground for identical images even at threshold 0', () => {
    const image = rgba([[10, 20, 30]])
    expect(computeMovementViews(image, image.slice(), 0).foregroundCount).toBe(0)
  })

  it('marks a changed pixel as foreground above the threshold', () => {
    const background = rgba([
      [10, 10, 10],
      [10, 10, 10],
    ])
    // Pixel 1 differs by 100 in one channel: distance 100 > 30.
    const frame = rgba([
      [10, 10, 10],
      [110, 10, 10],
    ])
    const views = computeMovementViews(frame, background, 30)

    expect(views.foregroundCount).toBe(1)
    expect(maskAt(views.mask, 0)).toBe(0)
    expect(maskAt(views.mask, 1)).toBe(255)
    // Difference is the distance as grayscale, clipped at 255.
    expect(pixelAt(views.difference, 0)).toEqual([0, 0, 0, 255])
    expect(pixelAt(views.difference, 1)).toEqual([100, 100, 100, 255])
  })

  it('clips the difference view at 255 for very large distances', () => {
    const views = computeMovementViews(
      rgba([[255, 255, 255]]),
      rgba([[0, 0, 0]]),
      30,
    )
    // Actual distance is sqrt(3) * 255 ~= 441.7, displayed as saturated white.
    expect(pixelAt(views.difference, 0)).toEqual([255, 255, 255, 255])
  })

  it('reclassifies the same pixel when the threshold changes', () => {
    const background = rgba([[10, 10, 10]])
    const frame = rgba([[60, 10, 10]]) // distance exactly 50

    expect(computeMovementViews(frame, background, 30).foregroundCount).toBe(1)
    expect(computeMovementViews(frame, background, 80).foregroundCount).toBe(0)
    // Strictly greater than: a distance equal to the threshold is background.
    expect(computeMovementViews(frame, background, 50).foregroundCount).toBe(0)
    expect(computeMovementViews(frame, background, 49).foregroundCount).toBe(1)
  })

  it('keeps foreground in colour and renders the background in grayscale', () => {
    const background = rgba([
      [200, 100, 0], // static: becomes its own luma
      [200, 100, 0], // moving: replaced by the frame colour
    ])
    const frame = rgba([
      [200, 100, 0],
      [0, 0, 255],
    ])
    const views = computeMovementViews(frame, background, 30)

    // Rec. 601 luma of (200, 100, 0) = 0.299*200 + 0.587*100 + 0.114*0 = 118.4,
    // dimmed to 8 %: 118.4 * 0.08 = 9.472, rounded by Uint8ClampedArray to 9.
    const [r, g, b, a] = pixelAt(views.highlight, 0)
    expect([r, g, b]).toEqual([9, 9, 9])
    expect(a).toBe(255)

    // The moving pixel keeps the frame's original colour, not the background's.
    expect(pixelAt(views.highlight, 1)).toEqual([0, 0, 255, 255])
  })

  it('removes background pixels from the foreground-only view', () => {
    const background = rgba([
      [10, 10, 10],
      [10, 10, 10],
    ])
    const frame = rgba([
      [10, 10, 10],
      [210, 20, 30],
    ])
    const views = computeMovementViews(frame, background, 30)

    // Background pixel is fully transparent.
    expect(pixelAt(views.foreground, 0)).toEqual([0, 0, 0, 0])
    // Foreground pixel keeps its colour and is fully opaque.
    expect(pixelAt(views.foreground, 1)).toEqual([210, 20, 30, 255])
  })

  it('rejects a background whose size differs from the frame', () => {
    expect(() =>
      computeMovementViews(rgba([[0, 0, 0]]), rgba([[0, 0, 0], [1, 1, 1]]), 30),
    ).toThrow(/same dimensions/)
  })
})
