import { useState } from 'react'
import { runRgbMedian, type RgbMedianResult, type VideoRecord } from '../api'
import type { AnalysisContext } from '../App'
import AnalyzeRangesLink from '../components/AnalyzeRangesLink'
import MovementVisualizationSection from '../components/MovementVisualizationSection'

interface RgbMedianPageProps {
  currentVideo: VideoRecord | null
  onAnalyze: (context: AnalysisContext) => void
}

function RgbMedianPage({ currentVideo, onAnalyze }: RgbMedianPageProps) {
  const [useAllFrames, setUseAllFrames] = useState(true)
  const [targetFrames, setTargetFrames] = useState(30)
  const [resizeWidth, setResizeWidth] = useState('')
  const [resizeHeight, setResizeHeight] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<RgbMedianResult | null>(null)

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
        await runRgbMedian({
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

  if (!currentVideo) {
    return (
      <>
        <h2>RGB Median</h2>
        <p className="content-hint">
          No input video. Upload one on the Video Input page first.
        </p>
      </>
    )
  }

  return (
    <>
      <h2>RGB Median</h2>
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

          <div className="experiment-result-grid">
            <figure className="variation-view">
              <img src={result.background} alt="Generated background" />
              <figcaption>
                <span className="variation-view-title">
                  Generated background
                </span>
                <a href={result.background} download="rgb-median-background.png">
                  Download PNG
                </a>
              </figcaption>
            </figure>
          </div>

          <h3>Sampled frames</h3>
          <div className="preview-row">
            {result.previews.map((src, i) => (
              <img key={i} src={src} alt={`Sampled frame ${i + 1}`} />
            ))}
          </div>

          <AnalyzeRangesLink
            onClick={() =>
              onAnalyze({
                background: result.background,
                label: 'RGB Median',
                from: 'rgb-median',
              })
            }
          />
        </section>
      )}

      <MovementVisualizationSection
        currentVideo={currentVideo}
        backgroundSrc={result?.background ?? null}
        experimentName="RGB Median"
      />

      <section className="page-notes">
        <h4>Notes</h4>
        <p>
          Takes the per-channel temporal median of the sampled frames and uses
          it directly as the background. Brief foreground passes cannot move the
          median, so no outlier rejection is applied — a comparison experiment
          for RGB Mean + outlier rejection on the same input video.
        </p>
      </section>
    </>
  )
}

export default RgbMedianPage
