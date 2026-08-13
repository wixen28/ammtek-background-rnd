import { useEffect, useState } from 'react'
import { checkHealth, getCurrentVideo, type VideoRecord } from './api'
import BackgroundVariationPage from './pages/BackgroundVariationPage'
import PixelRangeAnalysisPage from './pages/PixelRangeAnalysisPage'
import RgbMeanPage from './pages/RgbMeanPage'
import RgbMedianPage from './pages/RgbMedianPage'
import VideoInputPage from './pages/VideoInputPage'
import './App.css'

type BackendStatus = 'checking' | 'online' | 'offline'
type View =
  | 'overview'
  | 'video-input'
  | 'rgb-mean'
  | 'rgb-median'
  | 'background-variation'
  // Not in the sidebar: it is opened from a finished run and belongs to it.
  | 'pixel-ranges'

const NAV_ITEMS: { view: View; label: string }[] = [
  { view: 'overview', label: 'Overview' },
  { view: 'video-input', label: 'Video Input' },
  { view: 'rgb-mean', label: 'RGB Mean' },
  { view: 'rgb-median', label: 'RGB Median' },
  { view: 'background-variation', label: 'Background Variation' },
]

/**
 * What a finished experiment run hands to the analysis screen.
 *
 * Only the generated background travels, because that is the one thing the
 * analysis cannot get for itself: the pixel timeline, the frames and the
 * per-pixel model all read the stored input video, which never left the
 * backend. So opening the analysis re-uploads nothing and re-decodes nothing
 * that the run already paid for.
 */
export interface AnalysisContext {
  background: string | null
  label: string
  from: View
}

function OverviewPage() {
  return (
    <>
      <h2>Overview</h2>
      <p>
        R&amp;D proof of concept for extracting a static background from video
        and generating a foreground mask.
      </p>
      <p className="content-hint">
        Upload the working video on Video Input, then run an experiment. Each
        run offers a pixel and background-range analysis of its result.
      </p>
    </>
  )
}

function App() {
  const [backendStatus, setBackendStatus] = useState<BackendStatus>('checking')
  const [view, setView] = useState<View>('overview')
  // The current working input video, shared with all experiment pages.
  const [currentVideo, setCurrentVideo] = useState<VideoRecord | null>(null)
  const [analysis, setAnalysis] = useState<AnalysisContext | null>(null)

  useEffect(() => {
    checkHealth()
      .then((ok) => setBackendStatus(ok ? 'online' : 'offline'))
      .catch(() => setBackendStatus('offline'))
    getCurrentVideo()
      .then(setCurrentVideo)
      .catch(() => setCurrentVideo(null))
  }, [])

  const openAnalysis = (context: AnalysisContext) => {
    setAnalysis(context)
    setView('pixel-ranges')
  }

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
        {view === 'rgb-mean' && (
          <RgbMeanPage currentVideo={currentVideo} onAnalyze={openAnalysis} />
        )}
        {view === 'rgb-median' && (
          <RgbMedianPage currentVideo={currentVideo} onAnalyze={openAnalysis} />
        )}
        {view === 'background-variation' && (
          <BackgroundVariationPage
            currentVideo={currentVideo}
            onAnalyze={openAnalysis}
          />
        )}
        {view === 'pixel-ranges' &&
          (currentVideo ? (
            <PixelRangeAnalysisPage
              currentVideo={currentVideo}
              background={analysis?.background ?? null}
              sourceLabel={analysis?.label ?? 'experiments'}
              onBack={() => setView(analysis?.from ?? 'overview')}
            />
          ) : (
            <p className="content-hint">
              No input video. Upload one on the Video Input page first.
            </p>
          ))}
      </main>
    </div>
  )
}

export default App
