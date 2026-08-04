/**
 * Per-pixel separation of a video frame into static background and moving
 * foreground, given an already generated background.
 *
 * Diagnostic only: this classifies individual pixels by colour distance.
 * It does not detect, group or track objects.
 *
 * Pure functions over RGBA byte arrays in canvas ImageData layout, so the
 * logic is testable without a DOM and every view is derived from the same
 * frame, background and mask in one pass.
 */

// Largest possible Euclidean distance between two RGB colours, sqrt(3) * 255.
export const MAX_RGB_DISTANCE = Math.sqrt(3) * 255

export const DEFAULT_MOVEMENT_THRESHOLD = 30

/**
 * How much of its brightness the static background keeps in the "moving pixels
 * in colour" view — dark enough to be almost invisible, so the foreground
 * carries the image, while still leaving enough of the scene to place the
 * moving pixels in.
 *
 * Presentation only. It is applied after a pixel has been classified, to
 * background pixels of that one view: the classification, the counts and every
 * other view are unaffected.
 */
export const HIGHLIGHT_BACKGROUND_BRIGHTNESS = 0.2

export interface MovementViews {
  /** Distance from the background as grayscale, clipped at 255. */
  difference: Uint8ClampedArray
  /**
   * Heavily dimmed grayscale background, with foreground pixels in their
   * original colour. See `HIGHLIGHT_BACKGROUND_BRIGHTNESS`.
   */
  highlight: Uint8ClampedArray
  /** Binary mask: white where foreground, black where background. */
  mask: Uint8ClampedArray
  /** Foreground pixels only; background pixels are fully transparent. */
  foreground: Uint8ClampedArray
  /** Number of pixels classified as foreground. */
  foregroundCount: number
  /** Total number of pixels compared. */
  pixelCount: number
}

/**
 * Classify each pixel by the Euclidean RGB distance between the frame and
 * the background, and derive every view from that one comparison.
 *
 * A pixel is foreground when its distance is strictly greater than
 * ``threshold``, so an unchanged pixel is never foreground, even at 0.
 */
export function computeMovementViews(
  frame: Uint8ClampedArray,
  background: Uint8ClampedArray,
  threshold: number,
): MovementViews {
  if (frame.length !== background.length) {
    throw new Error(
      `Frame and background must have the same dimensions (got ${frame.length} and ${background.length} bytes).`,
    )
  }

  const difference = new Uint8ClampedArray(frame.length)
  const highlight = new Uint8ClampedArray(frame.length)
  const mask = new Uint8ClampedArray(frame.length)
  const foreground = new Uint8ClampedArray(frame.length)
  let foregroundCount = 0

  for (let i = 0; i < frame.length; i += 4) {
    const dr = frame[i] - background[i]
    const dg = frame[i + 1] - background[i + 1]
    const db = frame[i + 2] - background[i + 2]
    const distance = Math.sqrt(dr * dr + dg * dg + db * db)
    const isForeground = distance > threshold
    if (isForeground) foregroundCount += 1

    difference[i] = difference[i + 1] = difference[i + 2] = distance
    difference[i + 3] = 255

    mask[i] = mask[i + 1] = mask[i + 2] = isForeground ? 255 : 0
    mask[i + 3] = 255

    if (isForeground) {
      highlight[i] = frame[i]
      highlight[i + 1] = frame[i + 1]
      highlight[i + 2] = frame[i + 2]

      foreground[i] = frame[i]
      foreground[i + 1] = frame[i + 1]
      foreground[i + 2] = frame[i + 2]
      foreground[i + 3] = 255
    } else {
      // Rec. 601 luma of the background, dimmed to a fraction of its
      // brightness, so static areas read as a very dark reference the moving
      // pixels stand out against rather than competing with them.
      const luma =
        0.299 * background[i] +
        0.587 * background[i + 1] +
        0.114 * background[i + 2]
      highlight[i] = highlight[i + 1] = highlight[i + 2] =
        luma * HIGHLIGHT_BACKGROUND_BRIGHTNESS

      // foreground stays zeroed: transparent.
    }
    highlight[i + 3] = 255
  }

  return {
    difference,
    highlight,
    mask,
    foreground,
    foregroundCount,
    pixelCount: frame.length / 4,
  }
}
