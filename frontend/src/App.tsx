import { useEffect, useState } from 'react'
import './App.css'

const API_BASE_URL = 'http://localhost:8000'

type BackendStatus = 'checking' | 'online' | 'offline'

function App() {
  const [backendStatus, setBackendStatus] = useState<BackendStatus>('checking')

  useEffect(() => {
    fetch(`${API_BASE_URL}/api/health`)
      .then((res) => setBackendStatus(res.ok ? 'online' : 'offline'))
      .catch(() => setBackendStatus('offline'))
  }, [])

  return (
    <div className="app">
      <aside className="sidebar">
        <h1 className="sidebar-title">ammtek background R&amp;D</h1>
        <nav className="sidebar-nav">
          <span className="nav-section-label">Experiments</span>
          <ul>
            <li className="nav-item nav-item-active">Overview</li>
            <li className="nav-item nav-item-disabled">Background extraction (planned)</li>
            <li className="nav-item nav-item-disabled">Foreground masking (planned)</li>
          </ul>
        </nav>
        <footer className="sidebar-footer">
          <span className={`status-dot status-${backendStatus}`} />
          Backend: {backendStatus}
        </footer>
      </aside>

      <main className="content">
        <h2>Overview</h2>
        <p>
          R&amp;D proof of concept for extracting a static background from
          video and generating a foreground mask.
        </p>
        <p className="content-hint">
          No processing methods are implemented yet. Experiments will appear
          in the sidebar as they are added.
        </p>
      </main>
    </div>
  )
}

export default App
