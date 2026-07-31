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
  const [backgroundPixels, setBackgroundPixels] = useState<Pixels | null>(null)
  // The background defines the comparison grid; see the frame-request effect.
  const [backgroundWidth, setBackgroundWidth] = useState<number | null>(null)
  const [views, setViews] = useState<MovementViews | null>(null)
  // Which view is enlarged in the modal, if any.
  const [openView, setOpenView] = useState<ViewKey | null>(null)

  // Sequence guard: only the response to the most recently issued request
  // may update the UI, so a slow earlier response cannot overwrite a newer
  // one. Same approach as the pixel-timeline section.
  const requestSeqRef = useRef(0)
  const throttleTimerRef = useRef<number | null>(null)
  const pendingRef = useRef<{ index: number; maxWidth: number } | null>(null)

  const lastFrame = Math.max(0, currentVideo.frame_count - 1)
  const usable = backgroundSrc !== null

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
  useEffect(() => {
    if (!usable || backgroundWidth === null) return
    requestThrottled(frameIndex, backgroundWidth)
  }, [usable, backgroundWidth, frameIndex, requestThrottled])

  useEffect(() => {
    if (!frame) return
    let cancelled = false
    decodeImage(frame.frame)
      .then((pixels) => {
        if (!cancelled) setFramePixels(pixels)
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
      computeMovementViews(
        framePixels.data,
        backgroundPixels.data,
        threshold,
      ),
    )
  }, [framePixels, backgroundPixels, threshold])

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
                  {renderMedia(view.key)}
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
                <p className="movement-modal-description">
                  {openInfo.description}
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
