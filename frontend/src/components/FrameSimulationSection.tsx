import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  getVideoFrame,
  runPixelRangeModel,
  type PixelRangeModelResult,
  type VideoFrame,
  type VideoRecord,
} from '../api'
import type { RangeSettings } from '../backgroundRanges'
import { decodeImage, type Pixels } from '../imageData'
import {
  computeDetectionView,
  type DetectionView,
  type RangePlane,
} from '../pixelRangeModel'
import { useFramePlayback } from '../useFramePlayback'
import { formatShare } from './histogramFormat'

// Matches the throttle used for pixel scrubbing and the movement view.
const THROTTLE_MS = 250

// Grid the model is built on. Smaller than the source on purpose: the model
// holds up to three boxes per pixel and the build sorts every pixel's samples,
// so halving the width quarters both. 360 px is enough to see whether the hall
// floor is accepted.
const MODEL_WIDTHS = [240, 360, 480, 720] as const
// Frames the model is derived from, spread evenly over the whole video so both
// sides of a lighting change are represented.
const MODEL_FRAMES = [120, 240, 480] as const

function paintCanvas(
  canvas: HTMLCanvasElement | null,
  data: Uint8ClampedArray,
  width: number,
  height: number,
) {
  if (!canvas) return
  if (canvas.width !== width) canvas.width = width
  if (canvas.height !== height) canvas.height = height
  canvas
    .getContext('2d')
    ?.putImageData(new ImageData(data, width, height), 0, 0)
}

interface FrameSimulationSectionProps {
  currentVideo: VideoRecord
  /** The settings the model is built with — the same ones the charts mark. */
  settings: RangeSettings
  /** Selected pixel, marked on both views so it can be found in the frame. */
  pixel: { x: number; y: number } | null
  /**
   * The playhead, owned by the page so the acceptance strip can mark it. Only
   * written on a scrub and once when playback stops — playback itself paints
   * imperatively and deliberately causes no render per frame.
   */
  frameIndex: number
  onFrameIndexChange: (index: number) => void
}

/**
 * The whole-frame simulation: every pixel judged against its *own* accepted
 * ranges, frame by frame.
 *
 * The model comes from the backend, which runs the single-pixel derivation for
 * the whole grid over a sampled pass of the video. Building it is seconds of
 * work, so it is an explicit action rather than something a slider triggers —
 * and once built, classifying a frame is a handful of byte comparisons per
 * pixel, which the existing playback clock absorbs without help.
 *
 * Two panels, because "is this background" is only answerable by comparison:
 * the original frame beside the verdict on it.
 */
function FrameSimulationSection({
  currentVideo,
  settings,
  pixel,
  frameIndex,
  onFrameIndexChange,
}: FrameSimulationSectionProps) {
  const [modelWidth, setModelWidth] = useState<number>(360)
  const [modelFrames, setModelFrames] = useState<number>(240)
  const [model, setModel] = useState<PixelRangeModelResult | null>(null)
  const [planes, setPlanes] = useState<RangePlane[] | null>(null)
  const [building, setBuilding] = useState(false)
  const [stale, setStale] = useState(false)

  const [frame, setFrame] = useState<VideoFrame | null>(null)
  const [framePixels, setFramePixels] = useState<Pixels | null>(null)
  const [renderedIndex, setRenderedIndex] = useState<number | null>(null)
  const [view, setView] = useState<DetectionView | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [playing, setPlaying] = useState(false)

  const requestSeqRef = useRef(0)
  const throttleTimerRef = useRef<number | null>(null)
  const pendingRef = useRef<number | null>(null)

  // --- The imperative playback path -----------------------------------------
  // Playback paints without a React render per frame, for the reason the
  // movement view documents: serialising megabyte props on every commit costs
  // more than the computation itself on the dev server.
  const originalCanvasRef = useRef<HTMLCanvasElement | null>(null)
  const detectionCanvasRef = useRef<HTMLCanvasElement | null>(null)
  const planesRef = useRef(planes)
  const liveIndexRef = useRef(0)
  const liveViewRef = useRef<DetectionView | null>(null)
  const lastAdvancedRef = useRef<{
    index: number
    pixels: Pixels
    view: DetectionView
  } | null>(null)

  useEffect(() => {
    planesRef.current = planes
  }, [planes])

  const lastFrame = Math.max(0, currentVideo.frame_count - 1)
  const gridWidth = model?.width ?? null
  const usable = planes !== null && gridWidth !== null

  // The settings the loaded model was built with no longer match the ones the
  // charts are showing — say so rather than letting the two drift silently.
  useEffect(() => {
    if (!model) return
    setStale(
      model.signal !== settings.signal ||
        model.range_width !== settings.width ||
        model.tolerance !== settings.tolerance ||
        model.max_ranges !== settings.maxRanges,
    )
  }, [model, settings])

  const build = async () => {
    setBuilding(true)
    setError(null)
    setPlaying(false)
    try {
      const result = await runPixelRangeModel({
        use_all_frames: false,
        target_frames: modelFrames,
        max_width: modelWidth,
        signal: settings.signal,
        range_width: settings.width,
        tolerance: settings.tolerance,
        max_ranges: settings.maxRanges,
      })
      // Decoded once here, not per frame: the planes are the model, and they
      // do not change until it is rebuilt.
      const decoded = await Promise.all(
        result.ranges.map(async (plane) => ({
          lower: (await decodeImage(plane.lower)).data,
          upper: (await decodeImage(plane.upper)).data,
        })),
      )
      // Anything decoded at the previous grid is now the wrong size.
      setFrame(null)
      setFramePixels(null)
      setRenderedIndex(null)
      setView(null)
      setModel(result)
      setPlanes(decoded)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Building the model failed.')
    } finally {
      setBuilding(false)
    }
  }

  const fetchFrame = useCallback(async (index: number, maxWidth: number) => {
    const seq = ++requestSeqRef.current
    setLoading(true)
    setError(null)
    try {
      const result = await getVideoFrame(index, maxWidth)
      if (seq !== requestSeqRef.current) return
      setFrame(result)
    } catch (err) {
      if (seq !== requestSeqRef.current) return
      setError(err instanceof Error ? err.message : 'Loading the frame failed.')
    } finally {
      if (seq === requestSeqRef.current) setLoading(false)
    }
  }, [])

  /** Trailing throttle, so a dragged scrubber issues one request per interval. */
  const requestThrottled = useCallback(
    (index: number, maxWidth: number) => {
      pendingRef.current = index
      if (throttleTimerRef.current !== null) return
      const issuePending = () => {
        throttleTimerRef.current = null
        const pending = pendingRef.current
        pendingRef.current = null
        if (pending === null) return
        void fetchFrame(pending, maxWidth)
        throttleTimerRef.current = window.setTimeout(issuePending, THROTTLE_MS)
      }
      issuePending()
    },
    [fetchFrame],
  )

  useEffect(
    () => () => {
      requestSeqRef.current += 1
      if (throttleTimerRef.current !== null) {
        window.clearTimeout(throttleTimerRef.current)
      }
    },
    [],
  )

  // Frames are requested at the model's own grid, so every pixel lands on the
  // boxes derived for it. Playback keeps this path out of the way: it supplies
  // its own frames from the prefetch cache.
  useEffect(() => {
    if (!usable || playing || gridWidth === null) return
    requestThrottled(frameIndex, gridWidth)
  }, [usable, playing, gridWidth, frameIndex, requestThrottled])

  useEffect(() => {
    if (!frame) return
    const index = frame.frame_index
    let cancelled = false
    decodeImage(frame.frame)
      .then((pixels) => {
        if (cancelled) return
        setFramePixels(pixels)
        setRenderedIndex(index)
      })
      .catch(() => {
        if (!cancelled) setError('The frame could not be decoded.')
      })
    return () => {
      cancelled = true
    }
  }, [frame])

  useEffect(() => {
    if (!framePixels || !planes) {
      setView(null)
      return
    }
    setView(computeDetectionView(framePixels.data, planes))
  }, [framePixels, planes])

  const showPrefetched = useCallback((index: number, pixels: Pixels) => {
    const current = planesRef.current
    if (!current) return
    const computed = computeDetectionView(pixels.data, current)

    liveIndexRef.current = index
    liveViewRef.current = computed
    lastAdvancedRef.current = { index, pixels, view: computed }

    paintCanvas(originalCanvasRef.current, pixels.data, pixels.width, pixels.height)
    paintCanvas(
      detectionCanvasRef.current,
      computed.detection,
      pixels.width,
      pixels.height,
    )
  }, [])

  const stopPlayback = useCallback(() => setPlaying(false), [])

  const seed = useMemo(
    () =>
      framePixels !== null && renderedIndex === frameIndex
        ? { index: frameIndex, pixels: framePixels }
        : null,
    [framePixels, renderedIndex, frameIndex],
  )

  const { buffering, stats, capacity, reset: resetPlayback } = useFramePlayback({
    playing,
    frameIndex,
    lastFrame,
    fps: currentVideo.fps,
    gridWidth: framePixels?.width ?? null,
    gridHeight: framePixels?.height ?? null,
    cacheKey: `${currentVideo.video_id}:simulation:${framePixels?.width ?? 0}x${framePixels?.height ?? 0}`,
    onAdvance: showPrefetched,
    onEnd: stopPlayback,
    seed,
  })

  // Losing the model leaves nothing to classify against, so playback stops and
  // its buffer goes rather than holding frames nobody is watching.
  useEffect(() => {
    if (usable) return
    setPlaying(false)
    resetPlayback()
  }, [usable, resetPlayback])

  useEffect(() => {
    if (!playing) return
    liveIndexRef.current = frameIndex
    liveViewRef.current = view
  }, [playing, frameIndex, view])

  // Hand the last played frame back to React once, when playback stops, so the
  // scrubber, the readouts and both canvases agree with what is on screen.
  useEffect(() => {
    if (playing) return
    const last = lastAdvancedRef.current
    if (!last) return
    lastAdvancedRef.current = null
    onFrameIndexChange(last.index)
    setFramePixels(last.pixels)
    setRenderedIndex(last.index)
    setView(last.view)
  }, [playing, onFrameIndexChange])

  // Paints while *not* playing — after a build and on a scrub. Playback paints
  // the same canvases itself.
  useEffect(() => {
    if (playing || !framePixels || !view) return
    paintCanvas(
      originalCanvasRef.current,
      framePixels.data,
      framePixels.width,
      framePixels.height,
    )
    paintCanvas(
      detectionCanvasRef.current,
      view.detection,
      framePixels.width,
      framePixels.height,
    )
  }, [playing, view, framePixels])

  // While playing these come from the imperative path; the buffer readout's
  // interval is what re-renders and refreshes them.
  const displayIndex = playing ? liveIndexRef.current : frameIndex
  const displayView = playing ? liveViewRef.current : view

  const togglePlay = () => {
    if (playing) {
      setPlaying(false)
      return
    }
    if (frameIndex >= lastFrame) onFrameIndexChange(0)
    setPlaying(true)
  }

  const marker = pixel && (
    <span
      className="pixel-marker"
      style={{
        left: `${((pixel.x + 0.5) / currentVideo.width) * 100}%`,
        top: `${((pixel.y + 0.5) / currentVideo.height) * 100}%`,
      }}
    />
  )

  return (
    <section className="simulation-section">
      <div className="simulation-head">
        <h3>Frame simulation</h3>
        <div className="experiment-controls">
          <label>
            Model grid
            <select
              value={modelWidth}
              onChange={(e) => setModelWidth(Number(e.target.value))}
            >
              {MODEL_WIDTHS.map((width) => (
                <option key={width} value={width}>
                  {width} px wide
                </option>
              ))}
            </select>
          </label>
          <label>
            Model frames
            <select
              value={modelFrames}
              onChange={(e) => setModelFrames(Number(e.target.value))}
            >
              {MODEL_FRAMES.map((count) => (
                <option key={count} value={count}>
                  {count} frames
                </option>
              ))}
            </select>
          </label>
          <button type="button" onClick={() => void build()} disabled={building}>
            {building
              ? 'Building…'
              : model
                ? 'Rebuild per-pixel model'
                : 'Build per-pixel model'}
          </button>
        </div>
      </div>

      {error && <p className="video-error">{error}</p>}

      {!model ? (
        <p className="content-hint">
          Build the model to judge every pixel against ranges derived for that
          pixel. Uses the settings above; a build reads the video once and takes
          a few seconds.
        </p>
      ) : (
        <>
          <dl className="ranges-summary">
            <div>
              <dt>Model</dt>
              <dd>
                {model.width} × {model.height} · {model.sampled_frames} frames
                (every {model.every_n}
                <span aria-hidden="true">ᵗʰ</span>) ·{' '}
                {model.processing_time_seconds.toFixed(1)} s
              </dd>
            </div>
            <div>
              <dt>Samples accepted</dt>
              <dd>{formatShare(model.accepted_sample_share)}</dd>
            </div>
            <div>
              <dt>Pixels by ranges used</dt>
              <dd>
                {model.pixels_by_range_count
                  .map((count, i) => `${i + 1}: ${count}`)
                  .join(' · ')}
              </dd>
            </div>
            <div>
              <dt>This frame moving</dt>
              <dd>
                {displayView
                  ? formatShare(
                      1 - displayView.acceptedCount / displayView.pixelCount,
                    )
                  : '—'}
              </dd>
            </div>
          </dl>

          {stale && (
            <p className="content-hint simulation-stale">
              Settings changed since this model was built — rebuild to apply
              them.
            </p>
          )}

          <div className="experiment-controls">
            <label>
              Frame ({displayIndex} of {lastFrame})
              <input
                type="range"
                min={0}
                max={lastFrame}
                value={displayIndex}
                onChange={(e) => onFrameIndexChange(Number(e.target.value))}
              />
            </label>
            <button type="button" onClick={togglePlay}>
              {playing ? 'Pause' : 'Play'}
            </button>
            <span className="content-hint">
              Frame {displayIndex}
              {buffering && ' · buffering…'}
              {loading && !playing && ' · loading…'}
            </span>
          </div>

          <div className="simulation-grid">
            <figure className="simulation-view">
              <div className="pixel-select-wrap">
                <canvas ref={originalCanvasRef} />
                {marker}
              </div>
              <figcaption>Original frame</figcaption>
            </figure>
            <figure className="simulation-view">
              <div className="pixel-select-wrap">
                <canvas ref={detectionCanvasRef} />
                {marker}
              </div>
              <figcaption>
                Background/movement detection — accepted pixels darkened,
                rejected ones lifted to visible brightness
              </figcaption>
            </figure>
          </div>

          {playing && (
            <p className="movement-modal-stats">
              {`buffer ${stats.buffered}/${capacity} frames ` +
                `(${(stats.bytes / 1024 / 1024).toFixed(0)} MB, ${stats.inFlight} in flight) · ` +
                `supply ${stats.supplyFps.toFixed(1)} fps · ` +
                `playback ${stats.playbackFps.toFixed(1)} of ${currentVideo.fps.toFixed(0)} fps · ` +
                `${stats.underruns} underruns (${(stats.stalledMs / 1000).toFixed(1)} s)`}
            </p>
          )}
        </>
      )}
    </section>
  )
}

export default FrameSimulationSection
