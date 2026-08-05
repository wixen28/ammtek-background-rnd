import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { getVideoFrame, type VideoFrame, type VideoRecord } from '../api'
import { decodeImage, imageWidth, type Pixels } from '../imageData'
import {
  computeMovementViews,
  DEFAULT_MOVEMENT_THRESHOLD,
  HIGHLIGHT_BACKGROUND_BRIGHTNESS,
  MAX_RGB_DISTANCE,
  type MovementViews,
} from '../movement'
import { useFramePlayback } from '../useFramePlayback'

type ViewKey =
  | 'frame'
  | 'background'
  | 'difference'
  | 'highlight'
  | 'mask'
  | 'foreground'

// Order of the panels in the grid, with the caption shown under each one.
const VIEWS: { key: ViewKey; title: string; description: string }[] = [
  {
    key: 'frame',
    title: 'Original frame',
    description: 'Selected frame from the input video.',
  },
  {
    key: 'background',
    title: 'Generated background',
    description: 'Background produced by the selected experiment.',
  },
  {
    key: 'difference',
    title: 'Difference',
    description:
      'Per-pixel RGB difference between the frame and the background before thresholding.',
  },
  {
    key: 'highlight',
    title: 'Moving pixels in colour',
    // Percentage read from the constant so the caption cannot drift from it.
    description: `Background pixels are dimmed to ${HIGHLIGHT_BACKGROUND_BRIGHTNESS * 100} % grayscale, moving pixels remain in colour.`,
  },
  {
    key: 'mask',
    title: 'Foreground mask',
    description: 'White = moving pixels, Black = background.',
  },
  {
    key: 'foreground',
    title: 'Foreground only',
    description: 'Only pixels classified as moving are shown.',
  },
]

interface MovementVisualizationSectionProps {
  currentVideo: VideoRecord
  // Generated background (data URL), or null before a run. Deliberately the
  // only input about the background: the section never learns which method
  // produced it, so any experiment can reuse it by passing one.
  backgroundSrc: string | null
  // Experiment name, shown in the "run … first" hint.
  experimentName: string
  // Optional note about which background is in use, e.g. "threshold 30".
  backgroundLabel?: string
}

// Matches the throttle used for pixel-timeline scrubbing.
const THROTTLE_MS = 250

/**
 * Paint one view's bytes into a canvas. Shared by the state-driven path and by
 * playback's imperative one, so both put pixels on screen identically.
 *
 * The backing store is resized only when the grid actually changes: assigning
 * `width`/`height` reallocates and clears it, which is pointless work when the
 * dimensions already match.
 */
function paintCanvas(
  canvas: HTMLCanvasElement,
  data: Uint8ClampedArray,
  width: number,
  height: number,
) {
  if (canvas.width !== width) canvas.width = width
  if (canvas.height !== height) canvas.height = height
  canvas
    .getContext('2d')
    ?.putImageData(new ImageData(data, width, height), 0, 0)
}

/**
 * Paints one derived view in the grid, from React state. The enlarged view uses
 * a single canvas painted directly instead, so that playback can drive it
 * without a render per frame.
 */
function ViewCanvas({
  data,
  width,
  height,
  className,
}: {
  data: Uint8ClampedArray
  width: number
  height: number
  className?: string
}) {
  const ref = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = ref.current
    if (canvas) paintCanvas(canvas, data, width, height)
  }, [data, width, height])

  return <canvas ref={ref} className={className} />
}

function MovementVisualizationSection({
  currentVideo,
  backgroundSrc,
  experimentName,
  backgroundLabel,
}: MovementVisualizationSectionProps) {
  const [frameIndex, setFrameIndex] = useState(0)
  const [threshold, setThreshold] = useState(DEFAULT_MOVEMENT_THRESHOLD)
  const [frame, setFrame] = useState<VideoFrame | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [framePixels, setFramePixels] = useState<Pixels | null>(null)
  // Index of the frame whose pixels are currently decoded and displayed.
  const [renderedIndex, setRenderedIndex] = useState<number | null>(null)
  const [backgroundPixels, setBackgroundPixels] = useState<Pixels | null>(null)
  // The background defines the comparison grid; see the frame-request effect.
  const [backgroundWidth, setBackgroundWidth] = useState<number | null>(null)
  const [views, setViews] = useState<MovementViews | null>(null)
  // Which view is enlarged in the modal, if any.
  const [openView, setOpenView] = useState<ViewKey | null>(null)
  // Frame-by-frame playback, offered only inside the enlarged view.
  const [playing, setPlaying] = useState(false)

  // Sequence guard: only the response to the most recently issued request
  // may update the UI, so a slow earlier response cannot overwrite a newer
  // one. Same approach as the pixel-timeline section.
  const requestSeqRef = useRef(0)
  const throttleTimerRef = useRef<number | null>(null)
  const pendingRef = useRef<{ index: number; maxWidth: number } | null>(null)

  // --- The imperative playback path -----------------------------------------
  // Playback paints without going through React, so everything it needs during
  // a frame has to be reachable without a render. These mirror the state above.
  const modalCanvasRef = useRef<HTMLCanvasElement | null>(null)
  const backgroundPixelsRef = useRef<Pixels | null>(null)
  const thresholdRef = useRef(threshold)
  const openViewRef = useRef<ViewKey | null>(null)
  // Latest displayed frame and its share of moving pixels, read during render.
  const liveIndexRef = useRef(0)
  const liveShareRef = useRef<number | null>(null)
  // The last frame playback painted, handed to React state when it stops.
  const lastAdvancedRef = useRef<{
    index: number
    pixels: Pixels
    views: MovementViews
  } | null>(null)

  useEffect(() => {
    backgroundPixelsRef.current = backgroundPixels
  }, [backgroundPixels])
  useEffect(() => {
    thresholdRef.current = threshold
  }, [threshold])
  useEffect(() => {
    openViewRef.current = openView
  }, [openView])

  const lastFrame = Math.max(0, currentVideo.frame_count - 1)
  const usable = backgroundSrc !== null

  // Scrubbing only. Playback takes its frames from the prefetch cache instead,
  // so this path is unchanged by it.
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

  // Trailing throttle: remember the latest request and issue at most one
  // per THROTTLE_MS while the scrubber is moving. The width is carried in
  // the pending ref, not captured, so a queued request cannot fire against
  // a grid that has since changed.
  const requestThrottled = useCallback(
    (index: number, maxWidth: number) => {
      pendingRef.current = { index, maxWidth }
      if (throttleTimerRef.current !== null) return
      const issuePending = () => {
        throttleTimerRef.current = null
        const pending = pendingRef.current
        pendingRef.current = null
        if (pending === null) return
        void fetchFrame(pending.index, pending.maxWidth)
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

  useEffect(() => {
    if (!backgroundSrc) {
      setBackgroundWidth(null)
      setOpenView(null)
      return
    }
    let cancelled = false
    imageWidth(backgroundSrc)
      .then((width) => {
        if (!cancelled) setBackgroundWidth(width)
      })
      .catch(() => {
        if (!cancelled) setError('The background could not be read.')
      })
    return () => {
      cancelled = true
    }
  }, [backgroundSrc])

  // The frame is requested at the background's own width, so the two are
  // never resampled by different filters. Mixing OpenCV's downscale for the
  // frame with the browser's for the background shifts edge pixels enough to
  // cross the threshold, which would show up as movement along every edge.
  // Run the experiment with `resize` to make this grid (and the payload)
  // smaller. Only the frame comes from the backend, so switching the
  // Low/Recommended/High variant costs no request.
  //
  // The throttle exists to protect against scrubber spam, where a drag can
  // emit dozens of positions a second.
  //
  // Playback does not come through here at all: `useFramePlayback` requests
  // frames on its own lanes and hands over already decoded pixels, so while it
  // is running this effect stays out of the way — otherwise every advance it
  // makes would trigger a second, redundant request for the frame it just
  // displayed. Pausing re-runs it once, which restores the data URL the
  // "Original frame" view prefers.
  useEffect(() => {
    if (!usable || backgroundWidth === null) return
    if (playing) return
    requestThrottled(frameIndex, backgroundWidth)
  }, [usable, playing, backgroundWidth, frameIndex, requestThrottled])

  // Decodes the scrub path's frame. During playback the prefetcher decodes on
  // its own lanes, ahead of time, and writes the result in directly.
  useEffect(() => {
    if (!frame) return
    const index = frame.frame_index
    let cancelled = false
    decodeImage(frame.frame)
      .then((pixels) => {
        if (cancelled) return
        setFramePixels(pixels)
        // Records which frame the decoded pixels belong to, so the enlarged
        // view knows whether its data URL still matches what is on screen.
        setRenderedIndex(index)
      })
      .catch(() => {
        if (!cancelled) setError('The frame could not be decoded.')
      })
    return () => {
      cancelled = true
    }
  }, [frame])

  // Decoded at the frame's grid so the two always have matching dimensions.
  // Normally this is already the background's own size and drawImage is a
  // plain copy; the rescale is only a fallback for odd aspect ratios where
  // the server's rounded height differs by a pixel.
  const targetWidth = framePixels?.width
  const targetHeight = framePixels?.height
  useEffect(() => {
    if (!backgroundSrc || !targetWidth || !targetHeight) {
      setBackgroundPixels(null)
      return
    }
    let cancelled = false
    decodeImage(backgroundSrc, targetWidth, targetHeight)
      .then((pixels) => {
        if (!cancelled) setBackgroundPixels(pixels)
      })
      .catch(() => {
        if (!cancelled) setError('The background could not be decoded.')
      })
    return () => {
      cancelled = true
    }
  }, [backgroundSrc, targetWidth, targetHeight])

  // All four derived views come from one pass over the same frame,
  // background and mask. Recomputed locally when the threshold moves, so
  // the slider needs no requests.
  useEffect(() => {
    if (!framePixels || !backgroundPixels) {
      setViews(null)
      return
    }
    setViews(
      computeMovementViews(framePixels.data, backgroundPixels.data, threshold),
    )
  }, [framePixels, backgroundPixels, threshold])

  // Show a frame the prefetcher has already fetched and decoded.
  //
  // This deliberately sets no state. Routing a frame through React state means
  // a render and commit per frame, and React's dev build instruments those by
  // serialising props for its performance track — with a 2 MB `framePixels` and
  // four 2 MB view arrays that cost ~840 ms per frame on the dev server, versus
  // 4 ms in a production build. Painting straight into the canvas keeps the two
  // builds within a few per cent of each other.
  //
  // The computation is unchanged: the same `computeMovementViews` call over the
  // same inputs as a scrub, so there is still no separate animation path — only
  // a different way of getting the result on screen.
  const showPrefetched = useCallback((index: number, pixels: Pixels) => {
    const background = backgroundPixelsRef.current
    const key = openViewRef.current
    if (!background || !key) return

    const computed = computeMovementViews(
      pixels.data,
      background.data,
      thresholdRef.current,
    )

    // Read during render for the counter and the moving-pixel share, which the
    // buffer readout's own interval refreshes a couple of times a second.
    liveIndexRef.current = index
    liveShareRef.current = computed.foregroundCount / computed.pixelCount
    // Handed back to React state once, when playback stops.
    lastAdvancedRef.current = { index, pixels, views: computed }

    const canvas = modalCanvasRef.current
    if (canvas && key !== 'background') {
      paintCanvas(
        canvas,
        key === 'frame' ? pixels.data : computed[key],
        pixels.width,
        pixels.height,
      )
    }
  }, [])

  const stopPlayback = useCallback(() => setPlaying(false), [])

  // The frame already on screen, so starting playback does not re-request what
  // the scrub path just loaded.
  const seed = useMemo(
    () =>
      framePixels !== null && renderedIndex === frameIndex
        ? { index: frameIndex, pixels: framePixels }
        : null,
    [framePixels, renderedIndex, frameIndex],
  )

  // Frames are requested at the decoded grid rather than at `backgroundWidth`,
  // which is what the server actually returned once it clamped to the source
  // width — so the cache key and the requests agree with what is on screen.
  const { buffering, stats, capacity, reset: resetPlayback } = useFramePlayback({
    playing: playing && openView !== null,
    frameIndex,
    lastFrame,
    fps: currentVideo.fps,
    gridWidth: framePixels?.width ?? null,
    gridHeight: framePixels?.height ?? null,
    cacheKey: `${currentVideo.video_id}:${framePixels?.width ?? 0}x${framePixels?.height ?? 0}`,
    onAdvance: showPrefetched,
    onEnd: stopPlayback,
    seed,
  })

  // Playback belongs to the enlarged view, so closing it — by the backdrop,
  // the close button, Escape, or the background going away — always stops, and
  // the buffer goes with it rather than holding up to 128 MB of frames nobody
  // is watching. Pausing keeps it, so resuming is instant.
  useEffect(() => {
    if (openView) return
    setPlaying(false)
    resetPlayback()
  }, [openView, resetPlayback])

  useEffect(() => {
    if (!openView) return
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpenView(null)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [openView])

  // Seed the live readouts from state when playback starts, so the counter and
  // the moving-pixel share show the frame it began from rather than zero while
  // the buffer prewarms. Neither dependency changes while playing.
  useEffect(() => {
    if (!playing) return
    liveIndexRef.current = frameIndex
    liveShareRef.current = views
      ? views.foregroundCount / views.pixelCount
      : null
  }, [playing, frameIndex, views])

  // Hand the last played frame back to React once playback stops, so the grid,
  // the scrubber, the summary and the paused enlarged view all agree with what
  // is on screen. One render, instead of one per frame.
  useEffect(() => {
    if (playing) return
    const last = lastAdvancedRef.current
    if (!last) return
    lastAdvancedRef.current = null
    setFrameIndex(last.index)
    setFramePixels(last.pixels)
    setRenderedIndex(last.index)
    setViews(last.views)
  }, [playing])

  // Paints the enlarged view while it is *not* playing — on open, on a scrub,
  // and when the threshold moves. Playback paints the same canvas itself.
  useEffect(() => {
    if (playing || !openView || openView === 'background') return
    const canvas = modalCanvasRef.current
    if (!canvas || !framePixels) return
    const data = openView === 'frame' ? framePixels.data : views?.[openView]
    if (data) paintCanvas(canvas, data, framePixels.width, framePixels.height)
  }, [playing, openView, views, framePixels])

  // While playing these come from the imperative path; the buffer readout's
  // interval re-renders a couple of times a second, which is what refreshes
  // them. Frozen state would otherwise show the frame playback started from.
  const displayIndex = playing ? liveIndexRef.current : frameIndex
  const foregroundShare = playing
    ? liveShareRef.current
    : views
      ? views.foregroundCount / views.pixelCount
      : null

  const togglePlay = () => {
    if (playing) {
      setPlaying(false)
      return
    }
    // Replay from the start rather than leaving a dead button at the end.
    if (frameIndex >= lastFrame) setFrameIndex(0)
    setPlaying(true)
  }

  // The grid, from React state. Only rendered while not playing: `gridSuspended`
  // drops it during playback, so nothing here is on a per-frame path.
  const renderMedia = (key: ViewKey) => {
    switch (key) {
      case 'frame':
        // Prefer the data URL when it matches what is decoded; after playback
        // the scrub path has not caught up yet, so fall back to the pixels.
        if (frame && frame.frame_index === renderedIndex) {
          return <img src={frame.frame} alt="Selected video frame" />
        }
        return framePixels ? (
          <ViewCanvas
            data={framePixels.data}
            width={framePixels.width}
            height={framePixels.height}
          />
        ) : null
      case 'background':
        return backgroundSrc ? (
          <img src={backgroundSrc} alt="Generated background" />
        ) : null
      default:
        return views && framePixels ? (
          <ViewCanvas
            data={views[key]}
            width={framePixels.width}
            height={framePixels.height}
            className={key === 'foreground' ? 'movement-transparent' : undefined}
          />
        ) : null
    }
  }

  // The enlarged view: one canvas element that survives play/pause, painted by
  // playback while it runs and by the effect above when it does not. The
  // background is the exception — it is static, so it stays an <img> and
  // playback has nothing to repaint for it.
  const renderModalMedia = (key: ViewKey) =>
    key === 'background' ? (
      backgroundSrc ? (
        <img src={backgroundSrc} alt="Generated background" />
      ) : null
    ) : (
      <canvas
        ref={modalCanvasRef}
        className={key === 'foreground' ? 'movement-transparent' : undefined}
      />
    )

  const openInfo = VIEWS.find((view) => view.key === openView)

  // The grid sits behind the modal while playing, so its media is dropped: it
  // would otherwise show the frame playback started from, and re-point the
  // original-frame <img> at a ~1 MB data URL Chrome would load, decode and
  // retain as a fresh resource. Since playback no longer renders per frame this
  // is no longer a per-frame saving, just an honest one — nothing stale is
  // painted where it cannot be seen. Only the media is dropped, so the captions
  // and layout are untouched, and paused rendering is unaffected.
  const gridSuspended = playing && openView !== null

  return (
    <section className="movement-section">
      <h3>Background vs Moving Pixels</h3>
      <p className="content-hint">
        Takes one frame from the video and compares every pixel with the
        generated background. Pixels that differ more than the movement
        threshold count as moving, the rest count as static background.
        Each pixel is judged on its own — nothing here detects or tracks
        objects.
      </p>

      {!usable ? (
        <p className="content-hint">
          Run {experimentName} first to generate a background.
        </p>
      ) : (
        <>
          <div className="experiment-controls">
            <label>
              Frame ({displayIndex} of {lastFrame})
              <input
                type="range"
                min={0}
                max={lastFrame}
                value={displayIndex}
                onChange={(e) => setFrameIndex(Number(e.target.value))}
              />
            </label>
            <label>
              Movement threshold
              <input
                type="range"
                min={0}
                max={Math.round(MAX_RGB_DISTANCE)}
                value={threshold}
                onChange={(e) => setThreshold(Number(e.target.value))}
              />
            </label>
            <label>
              Value
              <input
                type="number"
                min={0}
                max={Math.round(MAX_RGB_DISTANCE)}
                value={threshold}
                onChange={(e) => setThreshold(Number(e.target.value))}
              />
            </label>
          </div>

          <dl className="movement-summary">
            <div>
              <dt>Movement threshold</dt>
              <dd>
                {threshold} of {Math.round(MAX_RGB_DISTANCE)}
              </dd>
            </div>
            <div>
              <dt>Background</dt>
              <dd>{backgroundLabel ?? experimentName}</dd>
            </div>
            <div>
              <dt>Moving pixels</dt>
              <dd>
                {foregroundShare === null
                  ? '—'
                  : `${(foregroundShare * 100).toFixed(1)} %`}
              </dd>
            </div>
            <div>
              <dt>Processing grid</dt>
              <dd>
                {framePixels
                  ? `${framePixels.width} × ${framePixels.height}`
                  : '—'}
              </dd>
            </div>
          </dl>

          {loading && <p className="content-hint">Loading frame…</p>}

          {framePixels && framePixels.width > 1000 && (
            <p className="content-hint">
              Frames are fetched at the background&apos;s resolution to keep the
              comparison exact. Re-run the experiment with a resize width to
              shrink this grid and make scrubbing faster.
            </p>
          )}

          {error && <p className="video-error">{error}</p>}

          <div className="movement-grid">
            {VIEWS.map((view) => (
              <figure className="movement-view" key={view.key}>
                <button
                  type="button"
                  className="movement-view-media"
                  onClick={() => setOpenView(view.key)}
                  title={`Enlarge — ${view.title}`}
                  aria-label={`Enlarge ${view.title}`}
                >
                  {gridSuspended ? null : renderMedia(view.key)}
                </button>
                <figcaption>
                  <span className="movement-view-title">{view.title}</span>
                  <span className="movement-view-description">
                    {view.description}
                  </span>
                </figcaption>
              </figure>
            ))}
          </div>

          {openInfo && (
            <div
              className="movement-modal"
              role="dialog"
              aria-modal="true"
              aria-label={openInfo.title}
              onClick={() => setOpenView(null)}
            >
              <div
                className="movement-modal-panel"
                onClick={(e) => e.stopPropagation()}
              >
                <header className="movement-modal-header">
                  <h4>{openInfo.title}</h4>
                  <button
                    type="button"
                    className="movement-modal-close"
                    onClick={() => setOpenView(null)}
                    aria-label="Close"
                  >
                    ×
                  </button>
                </header>
                <div className="movement-modal-media">
                  {renderModalMedia(openInfo.key)}
                </div>
                <div className="movement-modal-controls">
                  <button type="button" onClick={togglePlay}>
                    {playing ? 'Pause' : 'Play'}
                  </button>
                  <span className="movement-modal-frame">
                    Frame {displayIndex} of {lastFrame}
                    {buffering && ' · buffering…'}
                  </span>
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
                <p className="movement-modal-description">
                  {openInfo.description}
                  {' '}This view is regenerated for each frame during playback,
                  which targets the video&apos;s own frame rate from a buffer of
                  prefetched frames. If the buffer runs dry it waits rather than
                  skipping, so playback slows to the rate frames arrive instead
                  of dropping any.
                </p>
              </div>
            </div>
          )}
        </>
      )}
    </section>
  )
}

export default MovementVisualizationSection
