import { describe, expect, it } from 'vitest'
import {
  CACHE_BUDGET_BYTES,
  capacityForGrid,
  consecutiveAhead,
  FrameCache,
  MAX_CAPACITY,
  MIN_CAPACITY,
  nextFetchTargets,
  prefetchWindow,
} from './framePrefetch'

const pixels = (width: number, height: number) => ({
  data: new Uint8ClampedArray(width * height * 4),
  width,
  height,
})

const presentIn = (indices: number[]) => (index: number) =>
  indices.includes(index)

describe('capacityForGrid', () => {
  it('divides the budget by the RGBA size of one frame', () => {
    // 960x540 RGBA is 2,073,600 bytes; 128 MiB holds 64 of them.
    expect(capacityForGrid(960, 540)).toBe(64)
  })

  it('caps a small grid rather than buffering seconds it will not use', () => {
    // 640x360 would fit 145 frames in the budget.
    expect(capacityForGrid(640, 360)).toBe(MAX_CAPACITY)
  })

  it('keeps a floor at a grid large enough to exceed the budget', () => {
    expect(capacityForGrid(8000, 8000)).toBe(MIN_CAPACITY)
  })

  it('scales with an explicit budget', () => {
    expect(capacityForGrid(100, 100, 40 * 100 * 100 * 4)).toBe(40)
  })

  it('reports zero for a degenerate grid', () => {
    expect(capacityForGrid(0, 0)).toBe(0)
  })

  it('never exceeds the budget at the grids the experiments produce', () => {
    for (const [w, h] of [
      [640, 360],
      [960, 540],
      [1280, 720],
      [1920, 1080],
    ]) {
      const bytes = capacityForGrid(w, h) * w * h * 4
      // The MIN_CAPACITY floor is allowed to overshoot; nothing else is.
      if (capacityForGrid(w, h) > MIN_CAPACITY) {
        expect(bytes).toBeLessThanOrEqual(CACHE_BUDGET_BYTES)
      }
    }
  })
})

describe('prefetchWindow', () => {
  it('retains a few frames behind the playhead and spends the rest on lead', () => {
    expect(prefetchWindow(100, 64, 524)).toEqual({ start: 96, end: 159 })
  })

  it('is never wider than the capacity, which is what bounds the cache', () => {
    for (const playhead of [0, 1, 3, 4, 50, 520, 524]) {
      const { start, end } = prefetchWindow(playhead, 64, 524)
      expect(end - start + 1).toBeLessThanOrEqual(64)
    }
  })

  it('gives the unused behind-slots to lead at the start of the video', () => {
    // Nothing to retain behind frame 0, so all 64 slots go forward.
    expect(prefetchWindow(0, 64, 524)).toEqual({ start: 0, end: 63 })
    expect(prefetchWindow(2, 64, 524)).toEqual({ start: 0, end: 63 })
  })

  it('clamps to the last frame at the end of the video', () => {
    expect(prefetchWindow(524, 64, 524)).toEqual({ start: 520, end: 524 })
  })

  it('always contains the playhead', () => {
    for (const playhead of [0, 5, 300, 524]) {
      const { start, end } = prefetchWindow(playhead, 64, 524)
      expect(playhead).toBeGreaterThanOrEqual(start)
      expect(playhead).toBeLessThanOrEqual(end)
    }
  })
})

describe('nextFetchTargets', () => {
  it('requests in playback order from the playhead forward', () => {
    const targets = nextFetchTargets(10, { start: 6, end: 40 }, () => false, 4)
    expect(targets).toEqual([10, 11, 12, 13])
  })

  it('skips frames that are already buffered or in flight', () => {
    const targets = nextFetchTargets(
      10,
      { start: 6, end: 40 },
      presentIn([10, 11, 13]),
      3,
    )
    expect(targets).toEqual([12, 14, 15])
  })

  it('never fetches behind the playhead', () => {
    const targets = nextFetchTargets(10, { start: 6, end: 40 }, () => false, 8)
    expect(Math.min(...targets)).toBe(10)
  })

  it('stops at the end of the window', () => {
    expect(nextFetchTargets(10, { start: 6, end: 11 }, () => false, 4)).toEqual([
      10, 11,
    ])
  })

  it('returns nothing when no lane is free', () => {
    expect(nextFetchTargets(10, { start: 6, end: 40 }, () => false, 0)).toEqual(
      [],
    )
  })
})

describe('consecutiveAhead', () => {
  it('counts the unbroken run after the playhead', () => {
    expect(consecutiveAhead(10, presentIn([11, 12, 13]), 40)).toBe(3)
  })

  it('stops at a hole, ignoring frames beyond it', () => {
    // Lanes complete out of order, so 15 and 16 can land before 14.
    expect(consecutiveAhead(10, presentIn([11, 12, 15, 16]), 40)).toBe(2)
  })

  it('is zero when the very next frame is missing', () => {
    expect(consecutiveAhead(10, presentIn([12, 13]), 40)).toBe(0)
  })

  it('does not count past the end of the video', () => {
    expect(consecutiveAhead(10, () => true, 13)).toBe(3)
  })
})

describe('FrameCache', () => {
  it('tracks size and bytes as frames are added and removed', () => {
    const cache = new FrameCache()
    cache.set(1, pixels(10, 10))
    cache.set(2, pixels(10, 10))
    expect(cache.size).toBe(2)
    expect(cache.bytes).toBe(2 * 10 * 10 * 4)

    cache.delete(1)
    expect(cache.size).toBe(1)
    expect(cache.bytes).toBe(10 * 10 * 4)
  })

  it('does not double-count a replaced frame', () => {
    const cache = new FrameCache()
    cache.set(1, pixels(10, 10))
    cache.set(1, pixels(10, 10))
    expect(cache.size).toBe(1)
    expect(cache.bytes).toBe(10 * 10 * 4)
  })

  it('prunes everything outside the window', () => {
    const cache = new FrameCache()
    for (let i = 0; i < 20; i += 1) cache.set(i, pixels(4, 4))
    cache.prune({ start: 5, end: 9 })
    expect(cache.size).toBe(5)
    expect(cache.has(4)).toBe(false)
    expect(cache.has(5)).toBe(true)
    expect(cache.has(9)).toBe(true)
    expect(cache.has(10)).toBe(false)
    expect(cache.bytes).toBe(5 * 4 * 4 * 4)
  })

  it('stays within capacity when pruned on every playhead move', () => {
    // The invariant the eviction policy rests on: inserts only ever happen
    // inside the window, and the window is never wider than the capacity.
    const capacity = 16
    const cache = new FrameCache()
    for (let playhead = 0; playhead <= 200; playhead += 1) {
      const window = prefetchWindow(playhead, capacity, 200)
      cache.prune(window)
      for (let i = Math.max(playhead, window.start); i <= window.end; i += 1) {
        cache.set(i, pixels(4, 4))
      }
      expect(cache.size).toBeLessThanOrEqual(capacity)
    }
  })

  it('clears', () => {
    const cache = new FrameCache()
    cache.set(1, pixels(10, 10))
    cache.clear()
    expect(cache.size).toBe(0)
    expect(cache.bytes).toBe(0)
    expect(cache.get(1)).toBeNull()
  })
})
