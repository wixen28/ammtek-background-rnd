/**
 * Clock and prefetch lanes for movement-visualization playback.
 *
 * Two halves that meet at the cache in `framePrefetch.ts`:
 *
 * - the lanes keep `PREFETCH_CONCURRENCY` requests in flight ahead of the
 *   playhead and decode each frame to RGBA before storing it, so both the
 *   network wait and the image decode are off the playback path;
 * - the clock runs at the source video's own frame rate and reads the next
 *   frame straight out of the cache.
 *
 * The clock never skips a frame. When the next one is not buffered it holds
 * the current frame and waits, so playback degrades to the supply rate
 * instead of dropping frames — which matters for a diagnostic where each
 * frame is something to look at.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { getVideoFrame } from './api'
import { decodeImage, type Pixels } from './imageData'
import {
  capacityForGrid,
  consecutiveAhead,
  FrameCache,
  nextFetchTargets,
  prefetchWindow,
  PREFETCH_CONCURRENCY,
  PREWARM_FRAMES,
} from './framePrefetch'

/**
 * A stall shorter than this is ordinary supply jitter and is not surfaced, so
 * the indicator does not flicker when supply sits just under the frame rate.
 * Underruns are counted regardless of whether they were shown.
 */
const BUFFERING_VISIBLE_MS = 150

/** How often the readout is refreshed; the clock itself sets no state. */
const STATS_INTERVAL_MS = 500

export interface PlaybackStats {
  /** Frames currently buffered, and the most the budget allows at this grid. */
  buffered: number
  capacity: number
  bytes: number
  /** Decoded frames per second the lanes sustained since playback started. */
  supplyFps: number
  /** Frames per second actually shown over the same period. */
  playbackFps: number
  /** Times the clock ran out of buffered frames, and how long it waited. */
  underruns: number
  stalledMs: number
  /** Time spent filling the buffer before the first frame was shown. */
  prewarmMs: number
  inFlight: number
}

const EMPTY_STATS: PlaybackStats = {
  buffered: 0,
  capacity: 0,
  bytes: 0,
  supplyFps: 0,
  playbackFps: 0,
  underruns: 0,
  stalledMs: 0,
  prewarmMs: 0,
  inFlight: 0,
}

interface Options {
  playing: boolean
  /** Playhead, owned by the caller because the scrubber shares it. */
  frameIndex: number
  lastFrame: number
  /** Source frame rate; playback targets this. */
  fps: number
  /**
   * The processing grid. Frames are requested at this width so they land on
   * the same grid as the background. Null until the first frame is decoded,
   * which also means prefetching cannot start yet.
   */
  gridWidth: number | null
  gridHeight: number | null
  /** Identity of video and grid; a change invalidates every cached frame. */
  cacheKey: string
  /** Show frame `index` from prefetched pixels. */
  onAdvance: (index: number, pixels: Pixels) => void
  /** Playback reached the end of the video. */
  onEnd: () => void
  /** The frame already on screen, so starting does not refetch it. */
  seed: { index: number; pixels: Pixels } | null
}

export function useFramePlayback({
  playing,
  frameIndex,
  lastFrame,
  fps,
  gridWidth,
  gridHeight,
  cacheKey,
  onAdvance,
  onEnd,
  seed,
}: Options) {
  const [buffering, setBuffering] = useState(false)
  const [stats, setStats] = useState<PlaybackStats>(EMPTY_STATS)

  const cacheRef = useRef(new FrameCache())
  const inFlightRef = useRef(new Map<number, AbortController>())
  /** Lowest index that failed to read; treated as the end of the stream. */
  const endIndexRef = useRef<number | null>(null)
  /** Whether lanes may run. False while paused, closed or unmounted. */
  const activeRef = useRef(false)
  const playheadRef = useRef(frameIndex)
  const pumpRef = useRef<() => void>(() => {})
  const stallStartRef = useRef<number | null>(null)
  const countsRef = useRef({
    decoded: 0,
    advanced: 0,
    underruns: 0,
    stalledMs: 0,
    prewarmMs: 0,
    startedAt: 0,
  })

  // Latest props for the animation loop and the lanes, which must not be torn
  // down and rebuilt as the playhead moves. Mirrored in an effect declared
  // before the loop's, so it is always current by the time the loop ticks.
  const optsRef = useRef({
    lastFrame,
    fps,
    capacity: 0,
    gridWidth,
    onAdvance,
    onEnd,
    seed,
  })
  const capacity =
    gridWidth && gridHeight ? capacityForGrid(gridWidth, gridHeight) : 0
  useEffect(() => {
    optsRef.current = {
      lastFrame,
      fps,
      capacity,
      gridWidth,
      onAdvance,
      onEnd,
      seed,
    }
  }, [lastFrame, fps, capacity, gridWidth, onAdvance, onEnd, seed])

  // The clock writes the playhead here the moment it advances, so a lane
  // completing in the same tick already sees the new position. This effect is
  // then a no-op after an advance and a real resync after a scrub.
  useEffect(() => {
    playheadRef.current = frameIndex
  }, [frameIndex])

  const abortAll = useCallback(() => {
    for (const controller of inFlightRef.current.values()) controller.abort()
    inFlightRef.current.clear()
  }, [])

  const load = useCallback(async (index: number, width: number) => {
    const controller = new AbortController()
    inFlightRef.current.set(index, controller)
    try {
      const result = await getVideoFrame(index, width, controller.signal)
      const pixels = await decodeImage(result.frame)
      if (controller.signal.aborted) return
      cacheRef.current.set(index, pixels)
      countsRef.current.decoded += 1
    } catch {
      if (controller.signal.aborted) return
      // A failed read is the normal way playback finishes: `frame_count`
      // comes from container metadata and can overshoot the real end of the
      // video. Record it as the end of the stream and let the frames already
      // buffered play out, rather than cutting playback off here.
      endIndexRef.current =
        endIndexRef.current === null
          ? index
          : Math.min(endIndexRef.current, index)
    } finally {
      inFlightRef.current.delete(index)
    }
    pumpRef.current()
  }, [])

  /** Top up the lanes and evict what the playhead has left behind. */
  const pump = useCallback(() => {
    if (!activeRef.current) return
    const { capacity: cap, gridWidth: width, lastFrame: last } = optsRef.current
    if (cap <= 0 || !width) return

    const cache = cacheRef.current
    const inFlight = inFlightRef.current
    const end =
      endIndexRef.current === null
        ? last
        : Math.min(last, endIndexRef.current - 1)

    const window = prefetchWindow(playheadRef.current, cap, end)
    cache.prune(window)

    const free = PREFETCH_CONCURRENCY - inFlight.size
    if (free <= 0) return
    const targets = nextFetchTargets(
      playheadRef.current,
      window,
      (index) => cache.has(index) || inFlight.has(index),
      free,
    )
    for (const index of targets) void load(index, width)
  }, [load])

  useEffect(() => {
    pumpRef.current = pump
  }, [pump])

  // Every cached frame belongs to one video at one grid, so a change to
  // either invalidates all of them. Also runs on unmount.
  useEffect(
    () => () => {
      abortAll()
      cacheRef.current.clear()
      endIndexRef.current = null
    },
    [cacheKey, abortAll],
  )

  // Covers an externally driven move — a scrub while playing. The clock's own
  // advances pump directly, since they cause no render.
  useEffect(() => {
    if (playing) pumpRef.current()
  }, [playing, frameIndex])

  useEffect(() => {
    if (!playing) return
    // No grid means no frame has decoded yet, so there is nothing to prefetch
    // at and no clock to run. Stop rather than leaving a dead Pause button.
    if (optsRef.current.capacity <= 0 || !optsRef.current.gridWidth) {
      optsRef.current.onEnd()
      return
    }

    activeRef.current = true
    // The scrub path has already fetched and decoded the frame on screen.
    const seeded = optsRef.current.seed
    if (seeded) cacheRef.current.set(seeded.index, seeded.pixels)

    const startedAt = performance.now()
    countsRef.current = {
      decoded: 0,
      advanced: 0,
      underruns: 0,
      stalledMs: 0,
      prewarmMs: 0,
      startedAt,
    }
    stallStartRef.current = null

    // Has the prewarm gate opened, and when the next advance is due. Local to
    // this run of playback rather than refs, since they mean nothing outside it.
    let running = false
    let nextDue = 0
    let raf = 0

    const beginStall = (now: number) => {
      if (stallStartRef.current === null) {
        stallStartRef.current = now
        countsRef.current.underruns += 1
      } else if (now - stallStartRef.current >= BUFFERING_VISIBLE_MS) {
        setBuffering(true)
      }
    }

    const endStall = (now: number) => {
      if (stallStartRef.current === null) return
      countsRef.current.stalledMs += now - stallStartRef.current
      stallStartRef.current = null
      setBuffering(false)
    }

    const tick = (now: number) => {
      raf = requestAnimationFrame(tick)
      const opts = optsRef.current
      const last = opts.lastFrame
      const interval = 1000 / (opts.fps > 0 ? opts.fps : 30)
      const cache = cacheRef.current
      const playhead = playheadRef.current

      // A read that failed short of `frame_count` is the real end.
      const end =
        endIndexRef.current === null
          ? last
          : Math.min(last, endIndexRef.current - 1)
      if (playhead >= end) {
        opts.onEnd()
        return
      }

      if (!running) {
        // Wait for a contiguous run before the first advance. Reported
        // separately from underruns: filling an empty buffer is expected.
        const wanted = Math.min(PREWARM_FRAMES, end - playhead)
        const ready = consecutiveAhead(
          playhead,
          (index) => cache.has(index),
          Math.min(end, playhead + wanted),
        )
        if (ready < wanted) {
          if (now - startedAt >= BUFFERING_VISIBLE_MS) setBuffering(true)
          return
        }
        countsRef.current.prewarmMs = now - startedAt
        setBuffering(false)
        running = true
        nextDue = now + interval
        return
      }

      if (now < nextDue) return

      const next = playhead + 1
      const pixels = cache.get(next)
      if (!pixels) {
        // Never skip: hold this frame until the next one is decoded.
        beginStall(now)
        return
      }
      endStall(now)

      playheadRef.current = next
      countsRef.current.advanced += 1
      opts.onAdvance(next, pixels)
      // Advancing frees a slot behind the playhead and opens one ahead, so the
      // lanes are topped up here rather than from a `frameIndex` effect: the
      // caller deliberately does not re-render per frame, so no effect fires.
      pumpRef.current()

      // Advancing the due time by exactly one interval keeps the average rate
      // at the source fps despite the ~16.7 ms animation-frame granularity.
      // After a longer wait it is reset instead: catching up on a backlog
      // would mean skipping frames, which is the one thing this must not do.
      nextDue = now - nextDue > interval ? now + interval : nextDue + interval
    }

    raf = requestAnimationFrame(tick)
    pumpRef.current()

    return () => {
      cancelAnimationFrame(raf)
      // Stop the lanes but keep the buffer: resuming from a pause should be
      // instant. The cache is dropped when the view closes or the grid changes.
      activeRef.current = false
      abortAll()
      stallStartRef.current = null
      setBuffering(false)
    }
  }, [playing, abortAll])

  // Sampled rather than pushed, so the clock sets no state of its own.
  useEffect(() => {
    if (!playing) return
    const publish = () => {
      const counts = countsRef.current
      const now = performance.now()
      const elapsed = (now - counts.startedAt) / 1000
      const stalling =
        stallStartRef.current === null ? 0 : now - stallStartRef.current
      setStats({
        buffered: cacheRef.current.size,
        capacity: optsRef.current.capacity,
        bytes: cacheRef.current.bytes,
        supplyFps: elapsed > 0 ? counts.decoded / elapsed : 0,
        playbackFps: elapsed > 0 ? counts.advanced / elapsed : 0,
        underruns: counts.underruns,
        stalledMs: counts.stalledMs + stalling,
        prewarmMs: counts.prewarmMs,
        inFlight: inFlightRef.current.size,
      })
    }
    publish()
    const id = window.setInterval(publish, STATS_INTERVAL_MS)
    return () => window.clearInterval(id)
  }, [playing])

  /** Drop the buffer and stop the lanes; used when the enlarged view closes. */
  const reset = useCallback(() => {
    activeRef.current = false
    abortAll()
    cacheRef.current.clear()
    endIndexRef.current = null
    stallStartRef.current = null
    setBuffering(false)
    setStats(EMPTY_STATS)
  }, [abortAll])

  return { buffering, stats, capacity, reset }
}
