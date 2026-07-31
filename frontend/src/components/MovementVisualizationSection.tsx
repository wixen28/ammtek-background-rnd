import { useCallback, useEffect, useRef, useState } from 'react'
import { getVideoFrame, type VideoFrame, type VideoRecord } from '../api'
import {
  computeMovementViews,
  DEFAULT_MOVEMENT_THRESHOLD,
  MAX_RGB_DISTANCE,
  type MovementViews,
} from '../movement'

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
    description:
      'Background pixels are grayscale, moving pixels remain in colour.',
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

interface Pixels {
  data: Uint8ClampedArray
  width: number
  height: number
}

// Matches the throttle used for pixel-timeline scrubbing.
const THROTTLE_MS = 250

// ---------------------------------------------------------------------------
// TEMPORARY PROFILING — delete this block and its call sites once the
// playback bottleneck is identified. Backend (18 ms/frame) and
// computeMovementViews (5.7 ms at 960x540) have already been measured and
// account for only ~24 ms of an observed ~5500 ms per frame, so this exists
// to find the missing time in the browser-side steps.
const PROFILE = true
const prof = {
  renders: 0,
  issued: 0,
  accepted: 0,
  discarded: 0,
  lastShownAt: 0,
  fetchMs: 0,
  decodeMs: 0,
  computeMs: 0,
  gapMs: 0,
  cancelled: 0,
}
const plog = (msg: string) => {
  if (PROFILE) console.log(`[prof] ${msg}`)
}
// ---------------------------------------------------------------------------

/** Natural width of an image data URL, without decoding its pixels. */
async function imageWidth(src: string): Promise<number> {
  const image = new Image()
  image.src = src
  await image.decode()
  return image.naturalWidth
}

/** Decode an image data URL to RGBA bytes, optionally rescaled. */
async function decodeImage(
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

/**
 * Paints one derived view. The grid panel and the enlarged modal render the
 * same component from the same pixel data, so both stay in sync when the
 * threshold or frame changes while the modal is open. The backing store is
 * always the full processing grid; CSS scales the element.
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
    if (!canvas) return
    canvas.width = width
    canvas.height = height
    canvas
      .getContext('2d')
      ?.putImageData(new ImageData(data, width, height), 0, 0)
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
  // TEMPORARY PROFILING readout, shown in the enlarged view.
  const [profText, setProfText] = useState('')

  // Sequence guard: only the response to the most recently issued request
  // may update the UI, so a slow earlier response cannot overwrite a newer
  // one. Same approach as the pixel-timeline section.
  const requestSeqRef = useRef(0)
  const throttleTimerRef = useRef<number | null>(null)
  const pendingRef = useRef<{ index: number; maxWidth: number } | null>(null)

  const lastFrame = Math.max(0, currentVideo.frame_count - 1)
  const usable = backgroundSrc !== null

  // Render counter: StrictMode double-invokes render in dev, so expect this to
  // climb by 2 per real render. A jump of hundreds between two frames means a
  // render loop, which is what the request counters would then be tracking.
  prof.renders += 1

  const fetchFrame = useCallback(async (index: number, maxWidth: number) => {
    const seq = ++requestSeqRef.current
    prof.issued += 1
    const started = performance.now()
    setLoading(true)
    setError(null)
    try {
      const result = await getVideoFrame(index, maxWidth)
      const took = performance.now() - started
      prof.fetchMs = took
      if (seq !== requestSeqRef.current) {
        prof.discarded += 1
        plog(
          `fetch ${index} DISCARDED after ${took.toFixed(0)}ms ` +
            `(issued=${prof.issued} accepted=${prof.accepted} discarded=${prof.discarded})`,
        )
        return
      }
      prof.accepted += 1
      plog(
        `fetch ${index} ok ${took.toFixed(0)}ms  ` +
          `payload=${(result.frame.length / 1024).toFixed(0)}KB ` +
          `grid=${result.width}x${result.height}  ` +
          `issued=${prof.issued} accepted=${prof.accepted} discarded=${prof.discarded} renders=${prof.renders}`,
      )
      setFrame(result)
    } catch (err) {
      if (seq !== requestSeqRef.current) return
      setError(err instanceof Error ? err.message : 'Loading the frame failed.')
      // frame_count comes from container metadata, which can overshoot the
      // real end of the video, so a failed read is a normal way for playback
      // to finish rather than something to keep pushing through.
      setPlaying(false)
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
  // emit dozens of positions a second. Playback cannot spam: it issues the
  // next request only once the previous frame is decoded, so it is already
  // limited to one request in flight and goes direct. Leaving the throttle in
  // that path only added a fixed 250 ms of dead time per frame.
  useEffect(() => {
    if (!usable || backgroundWidth === null) return
    if (playing) {
      void fetchFrame(frameIndex, backgroundWidth)
      return
    }
    requestThrottled(frameIndex, backgroundWidth)
  }, [usable, playing, backgroundWidth, frameIndex, fetchFrame, requestThrottled])

  useEffect(() => {
    if (!frame) return
    const index = frame.frame_index
    const started = performance.now()
    let cancelled = false
    decodeImage(frame.frame)
      .then((pixels) => {
        const took = performance.now() - started
        const gap = prof.lastShownAt ? performance.now() - prof.lastShownAt : 0
        prof.lastShownAt = performance.now()
        prof.decodeMs = took
        prof.gapMs = gap
        if (cancelled) prof.cancelled += 1
        plog(
          `decode ${index} ${took.toFixed(0)}ms` +
            (cancelled ? ' (CANCELLED - frame skipped)' : '') +
            `  gap-since-previous-frame=${gap.toFixed(0)}ms`,
        )
        if (cancelled) return
        setFramePixels(pixels)
        // Records which frame the decoded pixels belong to, so playback can
        // wait for this frame to be on screen before asking for the next.
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
    const started = performance.now()
    decodeImage(backgroundSrc, targetWidth, targetHeight)
      .then((pixels) => {
        // Should fire ONCE per run, not per frame. If this logs on every
        // frame, the background is being re-decoded needlessly.
        plog(`background decode ${(performance.now() - started).toFixed(0)}ms`)
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
    const started = performance.now()
    const computed = computeMovementViews(
      framePixels.data,
      backgroundPixels.data,
      threshold,
    )
    prof.computeMs = performance.now() - started
    plog(`compute ${prof.computeMs.toFixed(0)}ms`)
    setViews(computed)
    setProfText(
      `gap ${prof.gapMs.toFixed(0)}ms = fetch ${prof.fetchMs.toFixed(0)} + ` +
        `decode ${prof.decodeMs.toFixed(0)} + compute ${prof.computeMs.toFixed(0)} ` +
        `+ unaccounted ${Math.max(0, prof.gapMs - prof.fetchMs - prof.decodeMs - prof.computeMs).toFixed(0)} · ` +
        `req ${prof.issued}/${prof.accepted} ok, ${prof.discarded} dropped, ` +
        `${prof.cancelled} decodes cancelled · renders ${prof.renders}`,
    )
  }, [framePixels, backgroundPixels, threshold])

  // Playback belongs to the enlarged view, so closing it — by the backdrop,
  // the close button, Escape, or the background going away — always stops.
  useEffect(() => {
    if (!openView) setPlaying(false)
  }, [openView])

  // Step to the next frame only once the requested one has arrived *and been
  // decoded*. That makes the loop self-clocking, with no timer of its own:
  // exactly one request is ever in flight, the playhead can never run ahead
  // of what is on screen, and every frame is displayed rather than
  // superseded mid-decode. Playback therefore runs at whatever rate the
  // frames come back.
  useEffect(() => {
    if (!playing || !openView) return
    if (renderedIndex !== frameIndex) return
    if (frameIndex >= lastFrame) {
      setPlaying(false)
      return
    }
    setFrameIndex(frameIndex + 1)
  }, [playing, openView, renderedIndex, frameIndex, lastFrame])

  useEffect(() => {
    if (!openView) return
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpenView(null)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [openView])

  const foregroundShare = views
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

  const renderMedia = (key: ViewKey) => {
    switch (key) {
      case 'frame':
        return frame ? (
          <img src={frame.frame} alt="Selected video frame" />
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

  const openInfo = VIEWS.find((view) => view.key === openView)

  // While the enlarged view is playing, the grid is completely hidden behind
  // the modal, yet every frame still repainted all four of its canvases (each
  // reallocating a full-size backing store) and re-pointed the original-frame
  // <img> at a brand-new ~1 MB data URL, which Chrome loads and decodes as a
  // fresh resource and then keeps in its image cache. That invisible work
  // dominated the frame time. Suspending the grid's media leaves exactly one
  // canvas painting: the one being watched. Only the media is dropped, so the
  // captions and layout are untouched, and paused/non-playback rendering is
  // completely unaffected.
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
              Frame ({frameIndex} of {lastFrame})
              <input
                type="range"
                min={0}
                max={lastFrame}
                value={frameIndex}
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
                  {renderMedia(openInfo.key)}
                </div>
                <div className="movement-modal-controls">
                  <button type="button" onClick={togglePlay}>
                    {playing ? 'Pause' : 'Play'}
                  </button>
                  <span className="movement-modal-frame">
                    Frame {frameIndex} of {lastFrame}
                    {playing && loading && ' · loading…'}
                  </span>
                </div>
                {PROFILE && profText && (
                  <p
                    className="movement-modal-frame"
                    style={{ marginTop: '0.4rem' }}
                  >
                    {profText}
                  </p>
                )}
                <p className="movement-modal-description">
                  {openInfo.description}
                  {' '}This view is regenerated for each frame during playback,
                  which runs as fast as frames are returned rather than at the
                  video&apos;s own frame rate.
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
