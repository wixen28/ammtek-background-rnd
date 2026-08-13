import { useState } from 'react'
import { runRgbMean, type RgbMeanResult, type VideoRecord } from '../api'
import type { AnalysisContext } from '../App'
import AnalyzeRangesLink from '../components/AnalyzeRangesLink'
import MovementVisualizationSection from '../components/MovementVisualizationSection'

interface RgbMeanPageProps {
  currentVideo: VideoRecord | null
  onAnalyze: (context: AnalysisContext) => void
}

// Labels are UI vocabulary and stay fixed; the values are editable so a
// run can sweep whichever thresholds are interesting. Order matches the
// variants returned by the backend.
const PRESET_LABELS = ['Low', 'Recommended', 'High'] as const
const PRESET_DEFAULTS = [20, 30, 50]

// The preset the switcher starts on after a run.
const DEFAULT_PRESET_INDEX = PRESET_LABELS.indexOf('Recommended')

function RgbMeanPage({ currentVideo, onAnalyze }: RgbMeanPageProps) {
  const [useAllFrames, setUseAllFrames] = useState(true)
  const [targetFrames, setTargetFrames] = useState(30)
  const [thresholds, setThresholds] = useState<number[]>(PRESET_DEFAULTS)
  const [resizeWidth, setResizeWidth] = useState('')
  const [resizeHeight, setResizeHeight] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<RgbMeanResult | null>(null)
  // Index into result.variants — switching only changes which already
  // generated background is displayed; nothing is refetched or recomputed.
  const [selected, setSelected] = useState(DEFAULT_PRESET_INDEX)

  const setThreshold = (index: number, value: number) => {
    setThresholds((current) =>
      current.map((threshold, i) => (i === index ? value : threshold)),
    )
  }

  const handleRun = async () => {
    const width = Number(resizeWidth)
    const height = Number(resizeHeight)
    const resize: [number, number] | null =
      resizeWidth && resizeHeight ? [width, height] : null
    if (resize && (!Number.isInteger(width) || width < 1 || !Number.isInteger(height) || height < 1)) {
      setError('Resize width and height must be positive integers.')
      return
    }
    if (thresholds.some((t) => !Number.isFinite(t) || t < 0)) {
      setError('Outlier thresholds must be zero or positive numbers.')
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
          rejection_thresholds: thresholds,
        }),
      )
      setSelected(DEFAULT_PRESET_INDEX)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Experiment failed.')
    } finally {
      setLoading(false)
    }
  }

  // Guarded by index rather than assumed present: a run may return fewer
  // variants than there are presets if the thresholds were edited.
  const selectedVariant = result?.variants[selected] ?? null

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
        {PRESET_LABELS.map((label, i) => (
          <label key={label}>
            {label} threshold
            <input
              type="number"
              min={0}
              max={442}
              value={thresholds[i]}
              onChange={(e) => setThreshold(i, Number(e.target.value))}
            />
          </label>
        ))}
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
            · {result.variants.length} thresholds in{' '}
            {result.processing_time_seconds.toFixed(2)} s
            {result.resize
              ? ` · resized to ${result.resize[0]} × ${result.resize[1]}`
              : ''}
            {selectedVariant && (
              <>
                {' '}
                · threshold {selectedVariant.rejection_threshold}:{' '}
                {(selectedVariant.rejected_fraction * 100).toFixed(1)}% of
                samples rejected
                {selectedVariant.fallback_pixels > 0 &&
                  ` · ${selectedVariant.fallback_pixels} px fell back to the median (all samples rejected)`}
              </>
            )}
          </p>

          <div
            className="background-variants"
            role="group"
            aria-label="Outlier threshold"
          >
            {result.variants.map((variant, i) => (
              <button
                key={i}
                type="button"
                className={`background-variant${i === selected ? ' background-variant-active' : ''}`}
                aria-pressed={i === selected}
                onClick={() => setSelected(i)}
              >
                {PRESET_LABELS[i] ?? 'Threshold'}
                <span className="background-variant-value">
                  {variant.rejection_threshold}
                </span>
              </button>
            ))}
          </div>

          {selectedVariant && (
            <div className="experiment-result-grid">
              <figure className="variation-view">
                <img src={selectedVariant.background} alt="Generated background" />
                <figcaption>
                  <span className="variation-view-title">
                    Generated background
                  </span>
                  <a
                    href={selectedVariant.background}
                    download={`rgb-mean-background-threshold-${selectedVariant.rejection_threshold}.png`}
                  >
                    Download PNG
                  </a>
                </figcaption>
              </figure>
            </div>
          )}

          <h3>Sampled frames</h3>
          <div className="preview-row">
            {result.previews.map((src, i) => (
              <img key={i} src={src} alt={`Sampled frame ${i + 1}`} />
            ))}
          </div>

          {selectedVariant && (
            <AnalyzeRangesLink
              onClick={() =>
                onAnalyze({
                  background: selectedVariant.background,
                  label: 'RGB Mean',
                  from: 'rgb-mean',
                })
              }
            />
          )}
        </section>
      )}

      <MovementVisualizationSection
        currentVideo={currentVideo}
        backgroundSrc={selectedVariant?.background ?? null}
        experimentName="RGB Mean"
        backgroundLabel={
          selectedVariant
            ? `${PRESET_LABELS[selected] ?? 'threshold'} · outlier threshold ${selectedVariant.rejection_threshold}`
            : undefined
        }
      />

      <section className="page-notes">
        <h4>Notes</h4>
        <p>
          Averages sampled frames per pixel with outlier rejection: samples
          farther than the threshold (Euclidean RGB distance) from the
          pixel&apos;s temporal median — foreground passes — are discarded
          before the mean. Threshold 442 disables rejection (plain mean).
        </p>
        <p>
          All three thresholds are generated in one run — the video is decoded
          once and the per-pixel median is shared — so switching between the
          results costs nothing.
        </p>
      </section>
    </>
  )
}

export default RgbMeanPage
