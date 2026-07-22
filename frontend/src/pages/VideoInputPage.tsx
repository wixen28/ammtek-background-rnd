import { useState } from 'react'
import { uploadVideo, type VideoRecord } from '../api'

interface VideoInputPageProps {
  currentVideo: VideoRecord | null
  onVideoChange: (video: VideoRecord) => void
}

function VideoInputPage({ currentVideo, onVideoChange }: VideoInputPageProps) {
  const [file, setFile] = useState<File | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleUpload = async () => {
    if (!file) return
    setLoading(true)
    setError(null)
    try {
      onVideoChange(await uploadVideo(file))
      setFile(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Upload failed.')
    } finally {
      setLoading(false)
    }
  }

  return (
    <>
      <h2>Video Input</h2>
      <p>
        Upload a video to make it the current working input for all
        experiments. Uploading a new video replaces the previous one.
      </p>

      <div className="video-form">
        <input
          type="file"
          accept="video/*"
          onChange={(e) => {
            setFile(e.target.files?.[0] ?? null)
            setError(null)
          }}
        />
        <button onClick={handleUpload} disabled={!file || loading}>
          {loading ? 'Uploading…' : currentVideo ? 'Replace video' : 'Upload'}
        </button>
      </div>

      {error && <p className="video-error">{error}</p>}

      {currentVideo ? (
        <section>
          <h3>Current video</h3>
          <table className="metadata-table">
            <tbody>
              <tr>
                <th>Filename</th>
                <td>{currentVideo.filename}</td>
              </tr>
              <tr>
                <th>Video ID</th>
                <td>
                  <code>{currentVideo.video_id}</code>
                </td>
              </tr>
              <tr>
                <th>Resolution</th>
                <td>
                  {currentVideo.width} × {currentVideo.height}
                </td>
              </tr>
              <tr>
                <th>FPS</th>
                <td>{currentVideo.fps.toFixed(2)}</td>
              </tr>
              <tr>
                <th>Frame count</th>
                <td>{currentVideo.frame_count}</td>
              </tr>
              <tr>
                <th>Duration</th>
                <td>{currentVideo.duration_seconds.toFixed(2)} s</td>
              </tr>
            </tbody>
          </table>
        </section>
      ) : (
        <p className="content-hint">No video uploaded yet.</p>
      )}
    </>
  )
}

export default VideoInputPage
