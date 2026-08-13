import { useEffect, useRef, useState } from 'react'
import { getPixelTimeline, type PixelTimeline, type VideoRecord } from '../api'
import RgbLineChart from './RgbLineChart'

interface PixelSelectSectionProps {
  currentVideo: VideoRecord
  /**
   * Background produced by the run this analysis came from (data URL), used
   * as the clickable image. Null when no run produced one, in which case
   * coordinates can still be typed.
   */
  background: string | null
  /** Reported up so the histogram and the ranges derive from one response. */
  onTimelineChange: (timeline: PixelTimeline | null) => void
}

// Trailing throttle: at most one request per interval while dragging.
const THROTTLE_MS = 250

/**
 * Pick a pixel and read its RGB values over every frame of the video.
 *
 * Moved here from the experiment pages unchanged in behaviour — click or drag
 * the background to select, or type coordinates — because the analysis it
 * feeds now lives on its own screen. There is deliberately only one
 * implementation of it.
 */
function PixelSelectSection({
  currentVideo,
  background,
  onTimelineChange,
}: PixelSelectSectionProps) {
  const [pixelX, setPixelX] = useState('')
  const [pixelY, setPixelY] = useState('')
  const [timeline, setTimeline] = useState<PixelTimeline | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Sequence guard: only the response to the most recently issued request may
  // update the UI, so a slow earlier response cannot overwrite a newer one.
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

  const publish = (next: PixelTimeline | null) => {
    setTimeline(next)
    onTimelineChange(next)
  }

  const analyzePixel = async (x: number, y: number) => {
    const seq = ++requestSeqRef.current
    lastRequestedRef.current = { x, y }
    setLoading(true)
    setError(null)
    try {
      const result = await getPixelTimeline(x, y)
      if (seq !== requestSeqRef.current) return
      publish(result)
    } catch (err) {
      if (seq !== requestSeqRef.current) return
      setError(err instanceof Error ? err.message : 'Pixel analysis failed.')
    } finally {
      if (seq === requestSeqRef.current) setLoading(false)
    }
  }

  const handleAnalyzePixel = () => {
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
      setError(
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

  // Map a pointer position on the (possibly scaled) image to source-video
  // pixel coordinates. Clamped so dragging outside the image (with pointer
  // capture active) sticks to the nearest edge pixel.
  const pixelFromPointer = (e: React.PointerEvent<HTMLImageElement>) => {
    const rect = e.currentTarget.getBoundingClientRect()
    const x = Math.floor(
      ((e.clientX - rect.left) / rect.width) * currentVideo.width,
    )
    const y = Math.floor(
      ((e.clientY - rect.top) / rect.height) * currentVideo.height,
    )
    return {
      x: Math.max(0, Math.min(currentVideo.width - 1, x)),
      y: Math.max(0, Math.min(currentVideo.height - 1, y)),
    }
  }

  const selectPixel = (x: number, y: number) => {
    setPixelX(String(x))
    setPixelY(String(y))
    setError(null)
  }

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
    if (!draggingRef.current) return
    const { x, y } = pixelFromPointer(e)
    selectPixel(x, y)
    requestThrottled(x, y)
  }

  const handlePointerEnd = (e: React.PointerEvent<HTMLImageElement>) => {
    if (!draggingRef.current) return
    draggingRef.current = false
    if (throttleTimerRef.current !== null) {
      window.clearTimeout(throttleTimerRef.current)
      throttleTimerRef.current = null
    }
    pendingPixelRef.current = null
    const { x, y } = pixelFromPointer(e)
    selectPixel(x, y)
    // Always resolve the final position; skip only if that exact request was
    // already the last one issued.
    const last = lastRequestedRef.current
    if (!last || last.x !== x || last.y !== y) {
      void analyzePixel(x, y)
    }
  }

  const selectedX = Number(pixelX)
  const selectedY = Number(pixelY)
  const hasSelection = pixelX !== '' && pixelY !== ''

  return (
    <section className="pixel-section">
      <div className="pixel-layout">
        <div className="pixel-layout-preview">
          {background ? (
            <div className="pixel-select-wrap">
              <img
                className="background-image background-image-clickable"
                src={background}
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
          ) : (
            <p className="content-hint">
              No background from this run — type coordinates to select a pixel.
            </p>
          )}
        </div>

        <div className="pixel-layout-analysis">
          <div className="experiment-controls">
            <span className="pixel-coords">
              {hasSelection ? `(${selectedX}, ${selectedY})` : 'no pixel'}
              {timeline && ` · ${timeline.frame_count} frames`}
              {loading && ' · analyzing…'}
            </span>
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
            <button type="button" onClick={handleAnalyzePixel}>
              Analyze
            </button>
          </div>

          {error && <p className="video-error">{error}</p>}

          {timeline && <RgbLineChart frames={timeline.frames} />}
        </div>
      </div>
    </section>
  )
}

export default PixelSelectSection
