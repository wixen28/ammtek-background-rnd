import { useEffect, useRef, useState } from 'react'
import {
  getPixelTimeline,
  runRgbMean,
  type PixelTimeline,
  type RgbMeanResult,
  type VideoRecord,
} from '../api'
import RgbLineChart from '../components/RgbLineChart'

interface RgbMeanPageProps {
  currentVideo: VideoRecord | null
}

function RgbMeanPage({ currentVideo }: RgbMeanPageProps) {
  const [useAllFrames, setUseAllFrames] = useState(true)
  const [targetFrames, setTargetFrames] = useState(30)
  const [rejectionThreshold, setRejectionThreshold] = useState(30)
  const [resizeWidth, setResizeWidth] = useState('')
  const [resizeHeight, setResizeHeight] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<RgbMeanResult | null>(null)

  const [pixelX, setPixelX] = useState('')
  const [pixelY, setPixelY] = useState('')
  const [timeline, setTimeline] = useState<PixelTimeline | null>(null)
  const [timelineLoading, setTimelineLoading] = useState(false)
  const [timelineError, setTimelineError] = useState<string | null>(null)

  // Drag-to-scrub state. Sequence guard: only the response to the most
  // recently issued request may update the UI, so a slow earlier response
  // can never overwrite a newer one.
  const requestSeqRef = useRef(0)
  const draggingRef = useRef(false)
  const throttleTimerRef = useRef<number | null>(null)
  const pendingPixelRef = useRef<{ x: number; y: number } | null>(null)
  const lastRequestedRef = useRef<{ x: number; y: number } | null>(null)

  useEffect(
    () => () => {
      requestSeqRef.current += 1
      if (throttleTimerRef.current !== null) {
        window.clearTimeout(throttleTimerRef.current)
      }
    },
    [],
  )

  const handleRun = async () => {
    const width = Number(resizeWidth)
    const height = Number(resizeHeight)
    const resize: [number, number] | null =
      resizeWidth && resizeHeight ? [width, height] : null
    if (resize && (!Number.isInteger(width) || width < 1 || !Number.isInteger(height) || height < 1)) {
      setError('Resize width and height must be positive integers.')
      return
    }
    if (!Number.isFinite(rejectionThreshold) || rejectionThreshold < 0) {
      setError('Outlier threshold must be zero or a positive number.')
      return
    }

    setLoading(true)
    setError(null)
    try {
      setResult(
        await runRgbMean({
          use_all_frames: useAllFrames,
          target_frames: targetFrames,
          resize,
          rejection_threshold: rejectionThreshold,
        }),
      )
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Experiment failed.')
    } finally {
      setLoading(false)
    }
  }

  const analyzePixel = async (x: number, y: number) => {
    const seq = ++requestSeqRef.current
    lastRequestedRef.current = { x, y }
    setTimelineLoading(true)
    setTimelineError(null)
    try {
      const result = await getPixelTimeline(x, y)
      if (seq !== requestSeqRef.current) return
      setTimeline(result)
    } catch (err) {
      if (seq !== requestSeqRef.current) return
      setTimelineError(
        err instanceof Error ? err.message : 'Pixel analysis failed.',
      )
    } finally {
      if (seq === requestSeqRef.current) setTimelineLoading(false)
    }
  }

  const handleAnalyzePixel = () => {
    if (!currentVideo) return
    const x = Number(pixelX)
    const y = Number(pixelY)
    if (
      !Number.isInteger(x) ||
      !Number.isInteger(y) ||
      x < 0 ||
      y < 0 ||
      x >= currentVideo.width ||
      y >= currentVideo.height
    ) {
      setTimelineError(
        `Coordinates must be integers within 0–${currentVideo.width - 1} × 0–${currentVideo.height - 1}.`,
      )
      return
    }
    void analyzePixel(x, y)
  }

  // Two inputs in one form suppress the browser's implicit Enter-to-submit,
  // so trigger analysis from the keydown directly.
  const handleCoordKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      handleAnalyzePixel()
    }
  }

  // Map a pointer position on the (possibly scaled/resized) background image
  // to source-video pixel coordinates. Clamped so dragging outside the image
  // (with pointer capture active) sticks to the nearest edge pixel.
  const pixelFromPointer = (e: React.PointerEvent<HTMLImageElement>) => {
    const rect = e.currentTarget.getBoundingClientRect()
    const x = Math.floor(
      ((e.clientX - rect.left) / rect.width) * currentVideo!.width,
    )
    const y = Math.floor(
      ((e.clientY - rect.top) / rect.height) * currentVideo!.height,
    )
    return {
      x: Math.max(0, Math.min(currentVideo!.width - 1, x)),
      y: Math.max(0, Math.min(currentVideo!.height - 1, y)),
    }
  }

  const selectPixel = (x: number, y: number) => {
    setPixelX(String(x))
    setPixelY(String(y))
    setTimelineError(null)
  }

  // Trailing throttle: remember the latest pixel and issue at most one
  // request per THROTTLE_MS while dragging.
  const THROTTLE_MS = 250
  const requestThrottled = (x: number, y: number) => {
    pendingPixelRef.current = { x, y }
    if (throttleTimerRef.current !== null) return
    const issuePending = () => {
      throttleTimerRef.current = null
      const pending = pendingPixelRef.current
      pendingPixelRef.current = null
      if (pending) {
        void analyzePixel(pending.x, pending.y)
        if (draggingRef.current) {
          throttleTimerRef.current = window.setTimeout(issuePending, THROTTLE_MS)
        }
      }
    }
    issuePending()
  }

  const handlePointerDown = (e: React.PointerEvent<HTMLImageElement>) => {
    if (!currentVideo) return
    e.preventDefault()
    // Capture the pointer so move/up events keep arriving even when the
    // cursor leaves the image; the drag then ends reliably on release.
    e.currentTarget.setPointerCapture(e.pointerId)
    draggingRef.current = true
    const { x, y } = pixelFromPointer(e)
    selectPixel(x, y)
    requestThrottled(x, y)
  }

  const handlePointerMove = (e: React.PointerEvent<HTMLImageElement>) => {
    if (!draggingRef.current || !currentVideo) return
    const { x, y } = pixelFromPointer(e)
    selectPixel(x, y)
    requestThrottled(x, y)
  }

  const handlePointerEnd = (e: React.PointerEvent<HTMLImageElement>) => {
    if (!draggingRef.current || !currentVideo) return
    draggingRef.current = false
    if (throttleTimerRef.current !== null) {
      window.clearTimeout(throttleTimerRef.current)
      throttleTimerRef.current = null
    }
    pendingPixelRef.current = null
    const { x, y } = pixelFromPointer(e)
    selectPixel(x, y)
    // Always resolve the final position; skip only if that exact request
    // was already the last one issued.
    const last = lastRequestedRef.current
    if (!last || last.x !== x || last.y !== y) {
      void analyzePixel(x, y)
    }
  }

  const selectedX = Number(pixelX)
  const selectedY = Number(pixelY)
  const hasSelection = pixelX !== '' && pixelY !== ''

  if (!currentVideo) {
    return (
      <>
        <h2>RGB Mean</h2>
        <p className="content-hint">
          No input video. Upload one on the Video Input page first.
        </p>
      </>
    )
  }

  return (
    <>
      <h2>RGB Mean</h2>
      <p>
        Averages sampled frames per pixel with outlier rejection: samples
        farther than the threshold (Euclidean RGB distance) from the
        pixel&apos;s temporal median — foreground passes — are discarded
        before the mean. Threshold 442 disables rejection (plain mean).
      </p>
      <p className="content-hint">
        Input: {currentVideo.filename} ({currentVideo.width} ×{' '}
        {currentVideo.height}, {currentVideo.frame_count} frames)
      </p>

      <div className="experiment-controls">
        <label className="experiment-checkbox">
          <input
            type="checkbox"
            checked={useAllFrames}
            onChange={(e) => setUseAllFrames(e.target.checked)}
          />
          Use all frames
        </label>
        <label>
          Target frames
          <input
            type="number"
            min={1}
            value={targetFrames}
            disabled={useAllFrames}
            onChange={(e) => setTargetFrames(Number(e.target.value))}
          />
        </label>
        <label>
          Resize width
          <input
            type="number"
            min={1}
            placeholder="original"
            value={resizeWidth}
            onChange={(e) => setResizeWidth(e.target.value)}
          />
        </label>
        <label>
          Resize height
          <input
            type="number"
            min={1}
            placeholder="original"
            value={resizeHeight}
            onChange={(e) => setResizeHeight(e.target.value)}
          />
        </label>
        <label>
          Outlier threshold
          <input
            type="number"
            min={0}
            max={442}
            value={rejectionThreshold}
            onChange={(e) => setRejectionThreshold(Number(e.target.value))}
          />
        </label>
        <button
          onClick={handleRun}
          disabled={loading || (!useAllFrames && targetFrames < 1)}
        >
          {loading ? 'Running…' : 'Run'}
        </button>
      </div>

      <p className="content-hint">
        {useAllFrames
          ? `All ${currentVideo.frame_count} frames will be used.`
          : `~${Math.min(targetFrames, currentVideo.frame_count)} frames will be sampled evenly across the video.`}
      </p>

      {error && <p className="video-error">{error}</p>}

      {result && (
        <section className="experiment-results">
          <p className="content-hint">
            Frames used:{' '}
            {result.use_all_frames
              ? `All ${result.sampled_frames} frames`
              : `${result.sampled_frames} of ${currentVideo.frame_count} (every ${result.every_n}‑th)`}{' '}
            · {result.processing_time_seconds.toFixed(2)} s
            {result.resize
              ? ` · resized to ${result.resize[0]} × ${result.resize[1]}`
              : ''}{' '}
            · threshold {result.rejection_threshold}:{' '}
            {(result.rejected_fraction * 100).toFixed(1)}% of samples
            rejected
            {result.fallback_pixels > 0 &&
              ` · ${result.fallback_pixels} px fell back to the median (all samples rejected)`}
          </p>

          <h3>Sampled frames</h3>
          <div className="preview-row">
            {result.previews.map((src, i) => (
              <img key={i} src={src} alt={`Sampled frame ${i + 1}`} />
            ))}
          </div>

        </section>
      )}

      <section className="pixel-section">
        <h3>Pixel Timeline Analysis</h3>
        <p className="content-hint">
          Reads the selected pixel from every frame of the video — a
          diagnostic for designing outlier rejection.
        </p>

        <div className="pixel-layout">
          {result && (
            <div className="pixel-layout-preview">
              <h4>Generated Background</h4>
              <p className="content-hint">
                Click to select a pixel, or click and drag to scrub.
              </p>
              <div className="pixel-select-wrap">
                <img
                  className="background-image background-image-clickable"
                  src={result.background}
                  alt="Generated background"
                  draggable={false}
                  onPointerDown={handlePointerDown}
                  onPointerMove={handlePointerMove}
                  onPointerUp={handlePointerEnd}
                  onPointerCancel={handlePointerEnd}
                />
                {hasSelection && (
                  <span
                    className="pixel-marker"
                    style={{
                      left: `${((selectedX + 0.5) / currentVideo.width) * 100}%`,
                      top: `${((selectedY + 0.5) / currentVideo.height) * 100}%`,
                    }}
                  />
                )}
              </div>
            </div>
          )}

          <div className="pixel-layout-analysis">
            <h4>Selected Pixel</h4>
            <p className="pixel-coords">
              {hasSelection
                ? `(${selectedX}, ${selectedY})`
                : result
                  ? 'none — click the preview, or type coordinates and press Enter'
                  : 'none — type coordinates and press Enter, or run RGB Mean for a clickable preview'}
              {timeline &&
                ` · ${timeline.frame_count} frames analyzed at (${timeline.x}, ${timeline.y})`}
              {timelineLoading && ' · analyzing…'}
            </p>

            <div className="experiment-controls">
              <label>
                X (0–{currentVideo.width - 1})
                <input
                  type="number"
                  min={0}
                  max={currentVideo.width - 1}
                  value={pixelX}
                  onChange={(e) => setPixelX(e.target.value)}
                  onKeyDown={handleCoordKeyDown}
                />
              </label>
              <label>
                Y (0–{currentVideo.height - 1})
                <input
                  type="number"
                  min={0}
                  max={currentVideo.height - 1}
                  value={pixelY}
                  onChange={(e) => setPixelY(e.target.value)}
                  onKeyDown={handleCoordKeyDown}
                />
              </label>
            </div>

            {timelineError && <p className="video-error">{timelineError}</p>}

            {timeline && <RgbLineChart frames={timeline.frames} />}
          </div>
        </div>
      </section>
    </>
  )
}

export default RgbMeanPage
