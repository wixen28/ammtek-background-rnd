import { useEffect, useMemo, useRef, useState } from 'react'
import { getPixelTimeline, type PixelTimeline, type VideoRecord } from '../api'
import {
  computeBackgroundRanges,
  DEFAULT_COVERAGE,
  MAX_BACKGROUND_RANGES,
} from '../backgroundRanges'
import {
  computePixelHistogram,
  DEFAULT_BUCKET_WIDTH,
  type BucketWidth,
} from '../histogram'
import BackgroundRangeSection from './BackgroundRangeSection'
import ColorClusterList from './ColorClusterList'
import RgbHistogramChart from './RgbHistogramChart'
import RgbLineChart from './RgbLineChart'

interface PixelTimelineSectionProps {
  currentVideo: VideoRecord
  // Generated background of the experiment (data URL), or null before a run.
  // Used as the clickable image for pixel selection and for the download link;
  // the timeline itself always reads from the original video.
  background: string | null
  // Experiment name, shown in the "run … for a clickable preview" hint.
  experimentName: string
  // Filename for the background download link.
  downloadName: string
  // Optional controls rendered directly above the background image, for
  // experiments that produce more than one background per run.
  backgroundToolbar?: React.ReactNode
}

function PixelTimelineSection({
  currentVideo,
  background,
  experimentName,
  downloadName,
  backgroundToolbar,
}: PixelTimelineSectionProps) {
  const [pixelX, setPixelX] = useState('')
  const [pixelY, setPixelY] = useState('')
  const [timeline, setTimeline] = useState<PixelTimeline | null>(null)
  const [timelineLoading, setTimelineLoading] = useState(false)
  const [timelineError, setTimelineError] = useState<string | null>(null)
  // The histogram is split across both columns — the joint colour buckets
  // under the background, the per-channel panels under the timeline — so the
  // bucket width and the computation live here and are shared, never
  // computed twice.
  const [bucketWidth, setBucketWidth] = useState<BucketWidth>(
    DEFAULT_BUCKET_WIDTH,
  )
  // The accepted-range strength, owned here for the same reason: the histogram
  // marks the ranges and the section below tests them, from one derivation.
  const [coverage, setCoverage] = useState(DEFAULT_COVERAGE)
  // Capping at one range is the comparison that shows why a second exists, so
  // it is a control rather than a constant.
  const [maxRanges, setMaxRanges] = useState(MAX_BACKGROUND_RANGES)

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

  const histogram = useMemo(
    () =>
      timeline && timeline.frames.length > 0
        ? computePixelHistogram(timeline.frames, bucketWidth)
        : null,
    [timeline, bucketWidth],
  )

  // Derived from the raw samples, not from the histogram, so the marked
  // boundaries do not move when the bucket width is changed for reading.
  const ranges = useMemo(
    () =>
      timeline && timeline.frames.length > 0
        ? computeBackgroundRanges(timeline.frames, coverage, maxRanges)
        : null,
    [timeline, coverage, maxRanges],
  )

  return (
    <>
    <section className="pixel-section">
      <h3>Pixel Timeline Analysis</h3>
      <p className="content-hint">
        Reads the selected pixel from every frame of the video — a
        diagnostic for designing outlier rejection.
      </p>

      <div className="pixel-layout">
        {/* The left column also carries the joint colour buckets, so it stays
            present for a pixel typed in before any run produced a
            background. */}
        {(background || histogram) && (
          <div className="pixel-layout-preview">
            {background && (
              <>
                <h4>Generated Background</h4>
                <p className="content-hint">
                  Click to select a pixel, or click and drag to scrub.
                </p>
                {backgroundToolbar}
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
                <p>
                  <a href={background} download={downloadName}>
                    Download background (PNG)
                  </a>
                </p>
              </>
            )}

            {/* The dominant colour states of the selected pixel, filling the
                space beside the timeline rather than lengthening the page. */}
            {histogram && <ColorClusterList histogram={histogram} />}
          </div>
        )}

        <div className="pixel-layout-analysis">
          <h4>Selected Pixel</h4>
          <p className="pixel-coords">
            {hasSelection
              ? `(${selectedX}, ${selectedY})`
              : background
                ? 'none — click the preview, or type coordinates and press Enter'
                : `none — type coordinates and press Enter, or run ${experimentName} for a clickable preview`}
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

          {/* Same samples, other question: the timeline shows when the values
              occurred, the histogram which ranges occurred most often. Both
              read the one timeline response, so a new pixel updates them
              together. */}
          {histogram && (
            <>
              <h5 className="pixel-subheading">Value distribution</h5>
              <p className="content-hint">
                How often each value range occurred across the{' '}
                {histogram.sampleCount} analyzed frames — diagnostic for
                whether this pixel has one dominant value or several competing
                ones.
              </p>
              <RgbHistogramChart
                histogram={histogram}
                onBucketWidthChange={setBucketWidth}
                ranges={ranges}
              />
            </>
          )}
        </div>
      </div>
    </section>

    {/* Directly under the histogram it marks, at full width: the frame test
        needs more room than the analysis column has. */}
    <BackgroundRangeSection
      currentVideo={currentVideo}
      timeline={timeline}
      ranges={ranges}
      coverage={coverage}
      onCoverageChange={setCoverage}
      maxRanges={maxRanges}
      onMaxRangesChange={setMaxRanges}
    />
    </>
  )
}

export default PixelTimelineSection
