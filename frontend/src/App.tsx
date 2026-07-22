import { useEffect, useState } from 'react'
import { checkHealth, getCurrentVideo, type VideoRecord } from './api'
import RgbMeanPage from './pages/RgbMeanPage'
import VideoInputPage from './pages/VideoInputPage'
import './App.css'

type BackendStatus = 'checking' | 'online' | 'offline'
type View = 'overview' | 'video-input' | 'rgb-mean'

const NAV_ITEMS: { view: View; label: string }[] = [
  { view: 'overview', label: 'Overview' },
  { view: 'video-input', label: 'Video Input' },
  { view: 'rgb-mean', label: 'RGB Mean' },
]

function OverviewPage() {
  return (
    <>
      <h2>Overview</h2>
      <p>
        R&amp;D proof of concept for extracting a static background from
        video and generating a foreground mask.
      </p>
      <p className="content-hint">
        Use the Video Input page to upload the working video. Further
        experiments will appear in the sidebar as they are added.
      </p>
    </>
  )
}

function App() {
  const [backendStatus, setBackendStatus] = useState<BackendStatus>('checking')
  const [view, setView] = useState<View>('overview')
  // The current working input video, shared with all experiment pages.
  const [currentVideo, setCurrentVideo] = useState<VideoRecord | null>(null)

  useEffect(() => {
    checkHealth()
      .then((ok) => setBackendStatus(ok ? 'online' : 'offline'))
      .catch(() => setBackendStatus('offline'))
    getCurrentVideo()
      .then(setCurrentVideo)
      .catch(() => setCurrentVideo(null))
  }, [])

  return (
    <div className="app">
      <aside className="sidebar">
        <h1 className="sidebar-title">ammtek background R&amp;D</h1>
        <nav className="sidebar-nav">
          <span className="nav-section-label">Experiments</span>
          <ul>
            {NAV_ITEMS.map((item) => (
              <li key={item.view}>
                <button
                  className={`nav-item${view === item.view ? ' nav-item-active' : ''}`}
                  onClick={() => setView(item.view)}
                >
                  {item.label}
                </button>
              </li>
            ))}
            <li className="nav-item nav-item-disabled">
              Foreground masking (planned)
            </li>
          </ul>
        </nav>
        <div className="sidebar-current-video">
          {currentVideo ? (
            <>Input: {currentVideo.filename}</>
          ) : (
            <>No input video</>
          )}
        </div>
        <footer className="sidebar-footer">
          <span className={`status-dot status-${backendStatus}`} />
          Backend: {backendStatus}
        </footer>
      </aside>

      <main className="content">
        {view === 'overview' && <OverviewPage />}
        {view === 'video-input' && (
          <VideoInputPage
            currentVideo={currentVideo}
            onVideoChange={setCurrentVideo}
          />
        )}
        {view === 'rgb-mean' && <RgbMeanPage currentVideo={currentVideo} />}
      </main>
    </div>
  )
}

export default App
