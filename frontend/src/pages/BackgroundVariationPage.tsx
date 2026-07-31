import { useState } from 'react'
import {
  runBackgroundVariation,
  type BackgroundVariationResult,
  type VideoRecord,
} from '../api'

interface BackgroundVariationPageProps {
  currentVideo: VideoRecord | null
}

const DEFAULT_REJECTION_THRESHOLD = 30

function BackgroundVariationPage({
  currentVideo,
}: BackgroundVariationPageProps) {
  const [useAllFrames, setUseAllFrames] = useState(true)
  const [targetFrames, setTargetFrames] = useState(30)
  const [rejectionThreshold, setRejectionThreshold] = useState(
    DEFAULT_REJECTION_THRESHOLD,
  )
  const [resizeWidth, setResizeWidth] = useState('')
  const [resizeHeight, setResizeHeight] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<BackgroundVariationResult | null>(null)

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
      setError('The rejection threshold must be zero or a positive number.')
      return
    }

    setLoading(true)
    setError(null)
    try {
      setResult(
        await runBackgroundVariation({
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

  if (!currentVideo) {
    return (
      <>
        <h2>Background Variation</h2>
        <p className="content-hint">
          No input video. Upload one on the Video Input page first.
        </p>
      </>
    )
  }

  return (
    <>
      <h2>Background Variation</h2>
      <p>
        Runs the same median-anchored outlier rejection as RGB Mean, but keeps
        the residual instead of the mean. For every pixel it measures the mean
        Euclidean RGB distance of the <em>kept</em> samples from the temporal
        median — the variation that rejection did not remove.
      </p>
      <p>
        The mask is grayscale: black means the kept samples agree, so the
        background estimate there is settled, and brighter means more surviving
        variation — sensor noise, illumination drift, or motion small enough to
        stay under the threshold. It is deliberately not a map of the rejected
        samples, which would be a dense per-frame motion map instead.
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
          Rejection threshold
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
              : ''}
          </p>

          <dl className="variation-summary">
            <div>
              <dt>Rejection threshold</dt>
              <dd>{result.rejection_threshold}</dd>
            </div>
            <div>
              <dt>Samples rejected</dt>
              <dd>{(result.rejected_fraction * 100).toFixed(1)} %</dd>
            </div>
            <div>
              <dt>Deviation range</dt>
              <dd>
                {result.deviation_min.toFixed(2)} –{' '}
                {result.deviation_max.toFixed(2)}
              </dd>
            </div>
            <div>
              <dt>Fallback pixels</dt>
              <dd>{result.fallback_pixels}</dd>
            </div>
          </dl>

          <p className="content-hint">
            Deviation is an RGB distance on the same 0–441.7 scale as the
            rejection threshold, and cannot exceed it. The mask is scaled from
            zero by the maximum above, so a gray value g reads back as roughly
            g / 255 × {result.deviation_max.toFixed(2)}.
            {result.fallback_pixels > 0 &&
              ' Fallback pixels (every sample rejected) have no kept samples to' +
                ' measure and appear black, like a stable pixel.'}
          </p>

          <div className="variation-grid">
            <figure className="variation-view">
              <img src={result.background} alt="Generated background" />
              <figcaption>
                <span className="variation-view-title">
                  Generated background
                </span>
                <span className="variation-view-description">
                  Mean of the kept samples, for reference — the estimate whose
                  stability the mask describes.
                </span>
              </figcaption>
            </figure>
            <figure className="variation-view">
              <img src={result.variation_mask} alt="Variation mask" />
              <figcaption>
                <span className="variation-view-title">Variation mask</span>
                <span className="variation-view-description">
                  Mean deviation of the kept samples from the median. Black =
                  stable, brighter = more surviving variation.
                </span>
              </figcaption>
            </figure>
          </div>

          <h3>Sampled frames</h3>
          <div className="preview-row">
            {result.previews.map((src, i) => (
              <img key={i} src={src} alt={`Sampled frame ${i + 1}`} />
            ))}
          </div>
        </section>
      )}
    </>
  )
}

export default BackgroundVariationPage
