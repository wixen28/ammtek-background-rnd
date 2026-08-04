/**
 * DOM helpers for turning image data URLs into raw RGBA bytes.
 *
 * Shared by the movement diagnostic and its frame prefetcher, which both
 * need pixels rather than an `<img>` element. Kept out of `framePrefetch.ts`
 * so that module stays DOM-free and unit-testable in a node environment.
 */

export interface Pixels {
  data: Uint8ClampedArray
  width: number
  height: number
}

/** Bytes one decoded frame of this grid occupies, held as RGBA. */
export function pixelBytes(width: number, height: number): number {
  return width * height * 4
}

/** Natural width of an image data URL, without decoding its pixels. */
export async function imageWidth(src: string): Promise<number> {
  const image = new Image()
  image.src = src
  await image.decode()
  return image.naturalWidth
}

/** Decode an image data URL to RGBA bytes, optionally rescaled. */
export async function decodeImage(
  src: string,
  width?: number,
  height?: number,
): Promise<Pixels> {
  const image = new Image()
  image.src = src
  await image.decode()

  const w = width ?? image.naturalWidth
  const h = height ?? image.naturalHeight
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const context = canvas.getContext('2d', { willReadFrequently: true })
  if (!context) throw new Error('Canvas 2D context is unavailable.')

  context.drawImage(image, 0, 0, w, h)
  return { data: context.getImageData(0, 0, w, h).data, width: w, height: h }
}
