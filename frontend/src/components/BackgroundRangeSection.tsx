import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  getVideoFrame,
  type PixelTimeline,
  type VideoFrame,
  type VideoRecord,
} from '../api'
import {
  computeAcceptanceView,
  MAX_BACKGROUND_RANGES,
  MAX_COVERAGE,
  MIN_COVERAGE,
  type AcceptanceView,
  type BackgroundRanges,
} from '../backgroundRanges'
import { decodeImage, type Pixels } from '../imageData'
import { useFramePlayback } from '../useFramePlayback'
import AcceptanceStrip from './AcceptanceStrip'
import { formatShare } from './histogramFormat'

// Matches the throttle used for pixel-timeline scrubbing and the movement view.
const THROTTLE_MS = 250

const COVERAGE_STEP = 0.01

/** Paint a view's bytes into the canvas; shared by the state path and playback. */
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

interface BackgroundRangeSectionProps {
  currentVideo: VideoRecord
  /** The analyzed pixel's samples, or null before a pixel is selected. */
  timeline: PixelTimeline | null
  /** Derived from `timeline` and `coverage` by the owning section. */
  ranges: BackgroundRanges | null
  coverage: number
  onCoverageChange: (coverage: number) => void
  /** How many ranges may be accepted, 1 or `MAX_BACKGROUND_RANGES`. */
  maxRanges: number
  onMaxRangesChange: (maxRanges: number) => void
}

/**
 * The accepted background ranges of the selected pixel, and a frame-by-frame
 * test of them.
 *
 * Two readouts, deliberately, because they answer different halves of the
 * question:
 *
 * - the **strip** is exact and complete — every analyzed frame of the selected
 *   pixel, accepted or rejected, with no decoding at all;
 * - the **frame view** is context — the selected pixel's ranges applied to
 *   every pixel of one frame, which shows *where else* that background colour
 *   holds and how a lighting change moves it, but is not a per-pixel
 *   background verdict: each pixel would need ranges of its own for that.
 */
function BackgroundRangeSection({
  currentVideo,
  timeline,
  ranges,
  coverage,
  onCoverageChange,
  maxRanges,
  onMaxRangesChange,
}: BackgroundRangeSectionProps) {
  const [frameIndex, setFrameIndex] = useState(0)
  const [frame, setFrame] = useState<VideoFrame | null>(null)
  const [framePixels, setFramePixels] = useState<Pixels | null>(null)
  const [renderedIndex, setRenderedIndex] = useState<number | null>(null)
  const [view, setView] = useState<AcceptanceView | null>(null)
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
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const rangesRef = useRef(ranges)
  const liveIndexRef = useRef(0)
  const liveViewRef = useRef<AcceptanceView | null>(null)
  const lastAdvancedRef = useRef<{
    index: number
    pixels: Pixels
    view: AcceptanceView
  } | null>(null)

  useEffect(() => {
    rangesRef.current = ranges
  }, [ranges])

  const lastFrame = Math.max(0, currentVideo.frame_count - 1)
  const usable = ranges !== null
  // Source resolution, so the analyzed pixel maps 1:1 onto the frame and the
  // marker sits on the pixel the ranges were derived from. The backend clamps
  // to the source width, so this never upscales.
  const frameWidth = currentVideo.width

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
    (index: number) => {
      pendingRef.current = index
      if (throttleTimerRef.current !== null) return
      const issuePending = () => {
        throttleTimerRef.current = null
        const pending = pendingRef.current
        pendingRef.current = null
        if (pending === null) return
        void fetchFrame(pending, frameWidth)
        throttleTimerRef.current = window.setTimeout(issuePending, THROTTLE_MS)
      }
      issuePending()
    },
    [fetchFrame, frameWidth],
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

  // Nothing is fetched until a pixel has been analyzed, and playback keeps
  // this path out of the way: it supplies its own frames from the prefetch
  // cache, so a request here would duplicate one it already made.
  useEffect(() => {
    if (!usable || playing) return
    requestThrottled(frameIndex)
  }, [usable, playing, frameIndex, requestThrottled])

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

  // Recomputed locally when the coverage slider moves, so changing the setting
  // costs no request — the same reason the movement threshold does not.
  useEffect(() => {
    if (!framePixels || !ranges) {
      setView(null)
      return
    }
    setView(computeAcceptanceView(framePixels.data, ranges.ranges))
  }, [framePixels, ranges])

  const showPrefetched = useCallback((index: number, pixels: Pixels) => {
    const current = rangesRef.current
    if (!current) return
    const computed = computeAcceptanceView(pixels.data, current.ranges)

    liveIndexRef.current = index
    liveViewRef.current = computed
    lastAdvancedRef.current = { index, pixels, view: computed }

    const canvas = canvasRef.current
    if (canvas) paintCanvas(canvas, computed.view, pixels.width, pixels.height)
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
    cacheKey: `${currentVideo.video_id}:ranges:${framePixels?.width ?? 0}x${framePixels?.height ?? 0}`,
    onAdvance: showPrefetched,
    onEnd: stopPlayback,
    seed,
  })

  // Losing the pixel (or the video) leaves nothing to classify against, so
  // playback stops and its buffer goes rather than holding frames nobody is
  // watching.
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
  // scrubber, the readouts and the canvas all agree with what is on screen.
  useEffect(() => {
    if (playing) return
    const last = lastAdvancedRef.current
    if (!last) return
    lastAdvancedRef.current = null
    setFrameIndex(last.index)
    setFramePixels(last.pixels)
    setRenderedIndex(last.index)
    setView(last.view)
  }, [playing])

  // Paints while *not* playing — on load, on a scrub, and when the coverage
  // slider changes the ranges. Playback paints the same canvas itself.
  useEffect(() => {
    if (playing) return
    const canvas = canvasRef.current
    if (!canvas || !framePixels || !view) return
    paintCanvas(canvas, view.view, framePixels.width, framePixels.height)
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
    if (frameIndex >= lastFrame) setFrameIndex(0)
    setPlaying(true)
  }

  // The analyzed pixel's own verdict on the displayed frame — exact, and
  // independent of the frame view. The timeline reads every frame, so the
  // sample index is normally the frame index; the search is the fallback.
  const pixelVerdict = useMemo(() => {
    if (!timeline || !ranges) return null
    const frames = timeline.frames
    const index =
      frames[displayIndex]?.frame_index === displayIndex
        ? displayIndex
        : frames.findIndex((sample) => sample.frame_index === displayIndex)
    if (index < 0) return null
    return { sample: frames[index], range: ranges.verdicts[index] }
  }, [timeline, ranges, displayIndex])

  // Held rather than rebuilt: the buffer readout re-renders a couple of times
  // a second during playback, and this is one entry per frame of the video.
  const frameIndices = useMemo(
    () => timeline?.frames.map((sample) => sample.frame_index) ?? [],
    [timeline],
  )

  const coveragePercent = Math.round(coverage * 100)
  const handleCoveragePercent = (percent: number) => {
    if (!Number.isFinite(percent)) return
    const clamped = Math.min(
      MAX_COVERAGE,
      Math.max(MIN_COVERAGE, percent / 100),
    )
    onCoverageChange(Number(clamped.toFixed(2)))
  }

  return (
    <section className="ranges-section">
      <h3>Accepted Background Ranges</h3>
      <p className="content-hint">
        Which colours of the selected pixel currently count as background, and
        a frame-by-frame test of that choice. The strength control is a
        frequency, not a colour distance: it says how much of the pixel&apos;s
        own frame history the accepted ranges have to explain. Up to two ranges
        are accepted, so a pixel whose background genuinely changes part-way
        through the video can have both states accepted.
      </p>

      <div className="experiment-controls">
        <label>
          Accepted signal ({coveragePercent} %)
          <input
            type="range"
            min={Math.round(MIN_COVERAGE * 100)}
            max={Math.round(MAX_COVERAGE * 100)}
            step={Math.round(COVERAGE_STEP * 100)}
            value={coveragePercent}
            onChange={(e) => handleCoveragePercent(Number(e.target.value))}
          />
        </label>
        <label>
          Value
          <input
            type="number"
            min={Math.round(MIN_COVERAGE * 100)}
            max={Math.round(MAX_COVERAGE * 100)}
            value={coveragePercent}
            onChange={(e) => handleCoveragePercent(Number(e.target.value))}
          />
        </label>
      </div>

      <div className="histogram-controls">
        <span className="histogram-controls-label">Ranges allowed</span>
        {Array.from({ length: MAX_BACKGROUND_RANGES }, (_, i) => i + 1).map(
          (allowed) => (
            <button
              key={allowed}
              type="button"
              className={allowed === maxRanges ? 'active' : undefined}
              onClick={() => onMaxRangesChange(allowed)}
            >
              {allowed}
            </button>
          ),
        )}
        <span className="histogram-controls-hint">
          Capping at 1 is the comparison: a pixel whose background changed
          part-way through the video cannot be covered by a single range at any
          setting.
        </span>
      </div>

      {!ranges || !timeline ? (
        <p className="content-hint">
          Select a pixel above to derive its accepted background ranges.
        </p>
      ) : (
        <>
          <dl className="ranges-summary">
            <div>
              <dt>Accepted ranges</dt>
              <dd>
                {ranges.ranges.length} of {ranges.modeCount} state
                {ranges.modeCount === 1 ? '' : 's'} found
              </dd>
            </div>
            <div>
              <dt>Frames covered</dt>
              <dd>
                {formatShare(ranges.achievedCoverage)} ({ranges.acceptedFrames}{' '}
                of {ranges.sampleCount})
              </dd>
            </div>
            <div>
              <dt>Split on</dt>
              <dd>
                {ranges.split
                  ? `${ranges.split.channel.toUpperCase()} at ${ranges.split.value} · separation ${ranges.split.separation.toFixed(2)}`
                  : 'nothing — one state'}
              </dd>
            </div>
            <div>
              <dt>Pixel</dt>
              <dd>
                ({timeline.x}, {timeline.y})
              </dd>
            </div>
          </dl>

          <p className="content-hint">
            Separation is how much of the channel&apos;s variance lies between
            the two states rather than inside them: near 1 means two genuinely
            distinct colour states, near 0 means one spread-out state that was
            split only to reach the requested coverage.
          </p>

          <ul className="range-cards">
            {ranges.ranges.map((range) => (
              <li className="range-card" key={range.rank}>
                <span className="range-card-head">
                  <span
                    className="histogram-swatch"
                    style={{
                      background: `rgb(${range.color.r} ${range.color.g} ${range.color.b})`,
                    }}
                  />
                  Range {range.rank}
                  <span className="range-card-share">
                    {formatShare(range.share)} of frames
                  </span>
                </span>
                <span className="range-card-bounds">
                  R {range.r[0]}–{range.r[1]} · G {range.g[0]}–{range.g[1]} · B{' '}
                  {range.b[0]}–{range.b[1]}
                </span>
                <span className="range-card-meta">
                  centre rgb({range.color.r}, {range.color.g}, {range.color.b})
                  · frames {range.firstFrame}–{range.lastFrame} ·{' '}
                  {range.acceptedFrames} accepted of {range.modeFrames}
                </span>
              </li>
            ))}
          </ul>

          <h4 className="pixel-subheading">Accepted frames</h4>
          <p className="content-hint">
            Every analyzed frame of the selected pixel, judged against the
            ranges above. A sustained rejected band is the case worth chasing:
            it means the settings do not cover the state the pixel ends the
            video in.
          </p>
          <AcceptanceStrip
            ranges={ranges}
            frameIndices={frameIndices}
            currentFrame={displayIndex}
          />

          <h4 className="pixel-subheading">Frame test</h4>
          <p className="content-hint">
            The selected pixel&apos;s ranges applied to every pixel of one
            frame: accepted pixels keep their colour, rejected ones are dimmed.
            Read this as &ldquo;where else does this pixel&apos;s accepted
            background colour hold&rdquo;, not as a per-pixel background mask —
            every pixel would need ranges of its own for that. The exact
            per-frame verdict for the analyzed pixel is the marked one, and is
            what the strip above plots.
          </p>

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
            <button type="button" onClick={togglePlay}>
              {playing ? 'Pause' : 'Play'}
            </button>
            {buffering && <span className="content-hint">buffering…</span>}
            {loading && !playing && (
              <span className="content-hint">Loading frame…</span>
            )}
          </div>

          <dl className="ranges-summary">
            <div>
              <dt>Pixel on this frame</dt>
              <dd>
                {pixelVerdict
                  ? `rgb(${pixelVerdict.sample.r}, ${pixelVerdict.sample.g}, ${pixelVerdict.sample.b}) — ${
                      pixelVerdict.range >= 0
                        ? `accepted by range ${pixelVerdict.range + 1}`
                        : 'rejected'
                    }`
                  : '—'}
              </dd>
            </div>
            {ranges.ranges.map((range) => (
              <div key={range.rank}>
                <dt>Frame in range {range.rank}</dt>
                <dd>
                  {displayView
                    ? formatShare(
                        displayView.acceptedByRange[range.rank - 1] /
                          displayView.pixelCount,
                      )
                    : '—'}
                </dd>
              </div>
            ))}
            <div>
              <dt>Frame rejected</dt>
              <dd>
                {displayView
                  ? formatShare(
                      1 - displayView.acceptedCount / displayView.pixelCount,
                    )
                  : '—'}
              </dd>
            </div>
          </dl>

          {error && <p className="video-error">{error}</p>}

          <div className="pixel-select-wrap ranges-frame">
            <canvas ref={canvasRef} />
            <span
              className="pixel-marker"
              style={{
                left: `${((timeline.x + 0.5) / currentVideo.width) * 100}%`,
                top: `${((timeline.y + 0.5) / currentVideo.height) * 100}%`,
              }}
            />
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

export default BackgroundRangeSection
