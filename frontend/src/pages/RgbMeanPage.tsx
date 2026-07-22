import { useState } from 'react'
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

  const handleRun = async () => {
    const width = Number(resizeWidth)
    const height = Number(resizeHeight)
    const resize: [number, number] | null =
      resizeWidth && resizeHeight ? [width, height] : null
    if (resize && (!Number.isInteger(width) || width < 1 || !Number.isInteger(height) || height < 1)) {
      setError('Resize width and height must be positive integers.')
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
        }),
      )
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Experiment failed.')
    } finally {
      setLoading(false)
    }
  }

  const handleAnalyzePixel = async () => {
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

    setTimelineLoading(true)
    setTimelineError(null)
    try {
      setTimeline(await getPixelTimeline(x, y))
    } catch (err) {
      setTimelineError(
        err instanceof Error ? err.message : 'Pixel analysis failed.',
      )
    } finally {
      setTimelineLoading(false)
    }
  }

  // Map a click on the (possibly scaled/resized) background image to
  // source-video pixel coordinates.
  const handleImageClick = (e: React.MouseEvent<HTMLImageElement>) => {
    if (!currentVideo) return
    const rect = e.currentTarget.getBoundingClientRect()
    const x = Math.floor(
      ((e.clientX - rect.left) / rect.width) * currentVideo.width,
    )
    const y = Math.floor(
      ((e.clientY - rect.top) / rect.height) * currentVideo.height,
    )
    setPixelX(String(Math.max(0, Math.min(currentVideo.width - 1, x))))
    setPixelY(String(Math.max(0, Math.min(currentVideo.height - 1, y))))
    setTimelineError(null)
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
        Averages sampled frames per pixel: the static background dominates
        the mean while moving objects blur into it.
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
              : ''}
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
              <p className="content-hint">Click to select a pixel.</p>
              <div className="pixel-select-wrap">
                <img
                  className="background-image background-image-clickable"
                  src={result.background}
                  alt="Generated background"
                  onClick={handleImageClick}
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
                  ? 'none — click the preview or enter coordinates'
                  : 'none — enter coordinates, or run RGB Mean for a clickable preview'}
              {timeline &&
                ` · ${timeline.frame_count} frames analyzed at (${timeline.x}, ${timeline.y})`}
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
                />
              </label>
              <button
                onClick={handleAnalyzePixel}
                disabled={timelineLoading || !hasSelection}
              >
                {timelineLoading ? 'Analyzing…' : 'Analyze Pixel'}
              </button>
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
