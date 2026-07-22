import { useState } from 'react'
import { runRgbMean, type RgbMeanResult, type VideoRecord } from '../api'

interface RgbMeanPageProps {
  currentVideo: VideoRecord | null
}

function RgbMeanPage({ currentVideo }: RgbMeanPageProps) {
  const [targetFrames, setTargetFrames] = useState(30)
  const [resizeWidth, setResizeWidth] = useState('')
  const [resizeHeight, setResizeHeight] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<RgbMeanResult | null>(null)

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
      setResult(await runRgbMean({ target_frames: targetFrames, resize }))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Experiment failed.')
    } finally {
      setLoading(false)
    }
  }

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
        <label>
          Target frames
          <input
            type="number"
            min={1}
            value={targetFrames}
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
        <button onClick={handleRun} disabled={loading || targetFrames < 1}>
          {loading ? 'Running…' : 'Run'}
        </button>
      </div>

      {error && <p className="video-error">{error}</p>}

      {result && (
        <section className="experiment-results">
          <p className="content-hint">
            Sampled {result.sampled_frames} frames (every {result.every_n}
            {'‑'}th of {currentVideo.frame_count}) in{' '}
            {result.processing_time_seconds.toFixed(2)} s
            {result.resize
              ? `, resized to ${result.resize[0]} × ${result.resize[1]}`
              : ''}
            .
          </p>

          <h3>Sampled frames</h3>
          <div className="preview-row">
            {result.previews.map((src, i) => (
              <img key={i} src={src} alt={`Sampled frame ${i + 1}`} />
            ))}
          </div>

          <h3>Generated background</h3>
          <img
            className="background-image"
            src={result.background}
            alt="Generated background"
          />
        </section>
      )}
    </>
  )
}

export default RgbMeanPage
