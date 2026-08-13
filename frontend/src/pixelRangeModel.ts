/**
 * Classify a whole frame against per-pixel accepted background ranges.
 *
 * The single-pixel derivation in `backgroundRanges.ts` answers "which colours
 * of *this* pixel are background". The backend runs that same derivation for
 * every pixel and ships the result as bound planes — one lower-bound and one
 * upper-bound image per range, in the frame's own grid. This module is the
 * other half: given a frame and those planes, each pixel is judged against
 * *its own* boxes.
 *
 * That is the difference from the frame test this replaces, which applied one
 * selected pixel's boxes to the whole grid and therefore rejected most of a
 * uniform floor — the floor is not that one shade everywhere. Here a pixel is
 * only ever compared with colours it was itself observed to hold.
 *
 * Pure functions over RGBA byte arrays in canvas ImageData layout, so the
 * logic is testable without a DOM and the same call serves a scrub and a
 * playback frame.
 */

/**
 * How much of its brightness an accepted pixel keeps. The same dimming the
 * movement view gives its background, so the two diagnostics read alike.
 */
export const BACKGROUND_BRIGHTNESS = 0.08

/**
 * Floor brightness of a rejected pixel.
 *
 * Rejected pixels are lifted rather than scaled, because scaling leaves black
 * black: a dark object crossing a dark floor is exactly the detection worth
 * confirming, and it has to be visible to be confirmed. The lift is additive
 * and equal on all three channels, so hue survives and only lightness moves.
 */
export const MOVEMENT_FLOOR = 110

/** Rec. 601 luma — the same weights the movement views use. */
function luma(r: number, g: number, b: number): number {
  return 0.299 * r + 0.587 * g + 0.114 * b
}

/** Per-pixel bounds for one accepted range, as decoded RGBA planes. */
export interface RangePlane {
  /** Inclusive lower bound per channel, RGBA layout. */
  lower: Uint8ClampedArray
  /** Inclusive upper bound per channel, RGBA layout. */
  upper: Uint8ClampedArray
}

/** One frame classified against the per-pixel model. */
export interface DetectionView {
  /** Accepted pixels darkened, rejected ones lifted into visible brightness. */
  detection: Uint8ClampedArray
  /** Pixels accepted, per range, in range order. */
  acceptedByRange: number[]
  acceptedCount: number
  pixelCount: number
}

/**
 * Judge every pixel of `frame` against its own boxes.
 *
 * First match wins, the same rule the single-pixel path applies to its own
 * frames, so a pixel attributed to range 2 here is one range 1 did not take.
 *
 * A range a pixel does not use arrives as an empty box (lower above upper),
 * which accepts nothing on any channel — so the planes carry how many ranges
 * each pixel has without a separate count to keep in step.
 */
export function computeDetectionView(
  frame: Uint8ClampedArray,
  planes: readonly RangePlane[],
): DetectionView {
  for (const plane of planes) {
    if (plane.lower.length !== frame.length || plane.upper.length !== frame.length) {
      throw new Error(
        `Frame and range planes must have the same dimensions (got ${frame.length}, ${plane.lower.length} and ${plane.upper.length} bytes).`,
      )
    }
  }

  const detection = new Uint8ClampedArray(frame.length)
  const acceptedByRange = new Array<number>(planes.length).fill(0)
  let acceptedCount = 0

  for (let i = 0; i < frame.length; i += 4) {
    const r = frame[i]
    const g = frame[i + 1]
    const b = frame[i + 2]

    let accepted = -1
    for (let p = 0; p < planes.length; p += 1) {
      const { lower, upper } = planes[p]
      if (
        r >= lower[i] &&
        r <= upper[i] &&
        g >= lower[i + 1] &&
        g <= upper[i + 1] &&
        b >= lower[i + 2] &&
        b <= upper[i + 2]
      ) {
        accepted = p
        break
      }
    }

    if (accepted >= 0) {
      const dim = luma(r, g, b) * BACKGROUND_BRIGHTNESS
      detection[i] = detection[i + 1] = detection[i + 2] = dim
      acceptedByRange[accepted] += 1
      acceptedCount += 1
    } else {
      // Map the pixel's own luma into [MOVEMENT_FLOOR, 255] and shift all
      // three channels by the difference: a bright object stays roughly where
      // it was, a black one becomes mid grey, and both keep their colour.
      const value = luma(r, g, b)
      const lift = MOVEMENT_FLOOR + ((255 - MOVEMENT_FLOOR) * value) / 255 - value
      detection[i] = r + lift
      detection[i + 1] = g + lift
      detection[i + 2] = b + lift
    }
    detection[i + 3] = 255
  }

  return {
    detection,
    acceptedByRange,
    acceptedCount,
    pixelCount: frame.length / 4,
  }
}
