/**
 * Frame buffer for movement-visualization playback.
 *
 * Playback used to be self-clocking: it asked for frame N+1 only once N was
 * on screen, so it ran at whatever rate the backend returned frames — around
 * 7 fps for an HD source, well under normal speed. This module is the supply
 * side of the replacement: a bounded cache of *decoded* frames that a few
 * concurrent requests keep filled ahead of the playhead, so the playback
 * clock reads pixels out of memory instead of waiting on the network.
 *
 * Pure and DOM-free on purpose — the capacity and eviction window are the
 * parts worth unit-testing. Requests, decoding and the clock live in
 * `useFramePlayback.ts`.
 */

import { pixelBytes, type Pixels } from './imageData'

/**
 * Cache budget for decoded frames. Frames are held as RGBA, so one 960×540
 * frame is ~2.1 MB and one 1920×1080 frame ~8.3 MB. Sizing the buffer in
 * bytes rather than in frames keeps one policy working at every grid.
 */
export const CACHE_BUDGET_BYTES = 128 * 1024 * 1024

/** Floor, so a very large grid still buffers enough to smooth out jitter. */
export const MIN_CAPACITY = 8
/** Ceiling, so a small grid does not hold seconds of video it will not use. */
export const MAX_CAPACITY = 90

/** Frames retained behind the playhead, so pausing and nudging back is free. */
export const KEEP_BEHIND = 4

/**
 * Concurrent in-flight requests. The backend reopens and seeks the video per
 * request (~124 ms of the measured per-frame cost, independent of the
 * requested width), which caps a single request at roughly 7 fps for an HD
 * source. The route is a sync `def`, so FastAPI runs it in its threadpool and
 * OpenCV releases the GIL while decoding — four lanes therefore multiply
 * supply rather than queueing. More lanes would only contend with the browser
 * for CPU, since it is decoding and comparing frames at the same time.
 */
export const PREFETCH_CONCURRENCY = 4

/**
 * Consecutive frames that must be buffered before the clock starts, so
 * playback does not begin straight into a stall.
 */
export const PREWARM_FRAMES = 12

/** Inclusive range of frame indices the cache is allowed to hold. */
export interface FrameWindow {
  start: number
  end: number
}

/**
 * How many decoded frames fit in the budget at this grid, clamped to a
 * sensible range. Returns 0 for a degenerate grid, which callers treat as
 * "prefetching not possible yet".
 */
export function capacityForGrid(
  width: number,
  height: number,
  budgetBytes: number = CACHE_BUDGET_BYTES,
): number {
  const perFrame = pixelBytes(width, height)
  if (perFrame <= 0) return 0
  const fits = Math.floor(budgetBytes / perFrame)
  return Math.min(MAX_CAPACITY, Math.max(MIN_CAPACITY, fits))
}

/**
 * The range of frames worth holding for a playhead at `playhead`: a few
 * frames behind it plus as much lead as the capacity allows, clamped to the
 * video. Never wider than `capacity`, which is what bounds the cache.
 *
 * Near the start of the video there is nothing behind the playhead to retain,
 * so those slots go to lead instead of being wasted.
 */
export function prefetchWindow(
  playhead: number,
  capacity: number,
  lastFrame: number,
  keepBehind: number = KEEP_BEHIND,
): FrameWindow {
  if (capacity <= 0) return { start: playhead, end: playhead - 1 }
  const behind = Math.min(keepBehind, capacity - 1, playhead)
  const start = playhead - behind
  return { start, end: Math.min(lastFrame, start + capacity - 1) }
}

/**
 * Up to `count` frames to request next, in playback order from the playhead
 * forward. Frames behind the playhead are retained when already present but
 * never fetched — `KEEP_BEHIND` is a retention policy, not a fetch policy.
 */
export function nextFetchTargets(
  playhead: number,
  window: FrameWindow,
  isPresent: (index: number) => boolean,
  count: number,
): number[] {
  const targets: number[] = []
  const from = Math.max(playhead, window.start)
  for (let i = from; i <= window.end && targets.length < count; i += 1) {
    if (!isPresent(i)) targets.push(i)
  }
  return targets
}

/**
 * Length of the unbroken run of buffered frames immediately after
 * `playhead`, up to and including `end`.
 *
 * Lanes complete out of order, so the plain buffered count can include
 * frames beyond a hole. Playback never skips, so only a contiguous run is
 * actually playable and it is that run the prewarm gate measures.
 */
export function consecutiveAhead(
  playhead: number,
  isPresent: (index: number) => boolean,
  end: number,
): number {
  let run = 0
  while (playhead + 1 + run <= end && isPresent(playhead + 1 + run)) run += 1
  return run
}

/**
 * Decoded frames keyed by frame index.
 *
 * Holds pixels only: the ~1 MB base64 data URL each frame arrives as is
 * discarded once decoded, which halves what the buffer costs and keeps the
 * browser from retaining a per-frame image resource of its own.
 */
export class FrameCache {
  private frames = new Map<number, Pixels>()
  private byteCount = 0

  get size(): number {
    return this.frames.size
  }

  /** Bytes currently held, for the buffer readout. */
  get bytes(): number {
    return this.byteCount
  }

  has(index: number): boolean {
    return this.frames.has(index)
  }

  get(index: number): Pixels | null {
    return this.frames.get(index) ?? null
  }

  set(index: number, pixels: Pixels): void {
    const existing = this.frames.get(index)
    if (existing) this.byteCount -= existing.data.length
    this.frames.set(index, pixels)
    this.byteCount += pixels.data.length
  }

  delete(index: number): void {
    const existing = this.frames.get(index)
    if (!existing) return
    this.byteCount -= existing.data.length
    this.frames.delete(index)
  }

  /**
   * Drop everything outside `window`. This is the whole eviction policy:
   * nothing is ever inserted outside the window and the window is never
   * wider than `capacity`, so pruning on every playhead move bounds the
   * cache at capacity by construction.
   */
  prune(window: FrameWindow): void {
    for (const index of [...this.frames.keys()]) {
      if (index < window.start || index > window.end) this.delete(index)
    }
  }

  clear(): void {
    this.frames.clear()
    this.byteCount = 0
  }
}
