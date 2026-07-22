import { useRef, useState } from 'react'
import type { PixelSample } from '../api'

// Validated for CVD separation and 3:1 contrast on the white surface
// (dataviz palette check) while still reading as red/green/blue.
const SERIES = [
  { key: 'r', label: 'Red', color: '#ef6a5a' },
  { key: 'g', label: 'Green', color: '#006300' },
  { key: 'b', label: 'Blue', color: '#1c5cab' },
] as const

const W = 680
const H = 280
const M = { top: 12, right: 56, bottom: 40, left: 44 }
const IW = W - M.left - M.right
const IH = H - M.top - M.bottom

const Y_TICKS = [0, 64, 128, 192, 255]

function RgbLineChart({ frames }: { frames: PixelSample[] }) {
  const svgRef = useRef<SVGSVGElement | null>(null)
  const [hover, setHover] = useState<number | null>(null)
  const [tableOpen, setTableOpen] = useState(false)

  const n = frames.length
  if (n === 0) return null

  const x = (i: number) => M.left + (n > 1 ? (i / (n - 1)) * IW : IW / 2)
  const y = (v: number) => M.top + (1 - v / 255) * IH

  const linePath = (key: 'r' | 'g' | 'b') =>
    frames
      .map((f, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)} ${y(f[key]).toFixed(1)}`)
      .join(' ')

  const xTicks = [
    ...new Set(
      Array.from({ length: Math.min(8, n) }, (_, k) =>
        Math.round((k * (n - 1)) / Math.max(1, Math.min(8, n) - 1)),
      ),
    ),
  ]

  // Direct labels at line ends, nudged apart when the series converge.
  const last = frames[n - 1]
  const endLabels = SERIES.map((s) => ({ ...s, ly: y(last[s.key]) })).sort(
    (a, b) => a.ly - b.ly,
  )
  for (let i = 1; i < endLabels.length; i++) {
    endLabels[i].ly = Math.max(endLabels[i].ly, endLabels[i - 1].ly + 13)
  }

  const handleMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const svg = svgRef.current
    if (!svg) return
    const rect = svg.getBoundingClientRect()
    const px = ((e.clientX - rect.left) / rect.width) * W
    const i = Math.round(((px - M.left) / IW) * (n - 1))
    setHover(Math.max(0, Math.min(n - 1, i)))
  }

  const hovered = hover !== null ? frames[hover] : null
  const tooltipX =
    hover !== null && x(hover) + 148 > W - M.right ? x(hover!) - 148 : (hover !== null ? x(hover) + 10 : 0)

  return (
    <div className="chart">
      <div className="chart-legend">
        {SERIES.map((s) => (
          <span key={s.key}>
            <i style={{ background: s.color }} />
            {s.label}
          </span>
        ))}
      </div>

      <svg
        ref={svgRef}
        viewBox={`0 0 ${W} ${H}`}
        onMouseMove={handleMove}
        onMouseLeave={() => setHover(null)}
        role="img"
        aria-label="RGB value of the selected pixel per frame"
      >
        {Y_TICKS.map((t) => (
          <g key={t}>
            <line
              x1={M.left}
              x2={W - M.right}
              y1={y(t)}
              y2={y(t)}
              stroke="#e1e0d9"
              strokeWidth={1}
            />
            <text x={M.left - 8} y={y(t) + 3.5} textAnchor="end" className="chart-tick">
              {t}
            </text>
          </g>
        ))}
        {xTicks.map((t) => (
          <text
            key={t}
            x={x(t)}
            y={H - M.bottom + 18}
            textAnchor="middle"
            className="chart-tick"
          >
            {t}
          </text>
        ))}
        <text
          x={M.left + IW / 2}
          y={H - 4}
          textAnchor="middle"
          className="chart-axis-label"
        >
          frame index
        </text>

        {SERIES.map((s) => (
          <path
            key={s.key}
            d={linePath(s.key)}
            fill="none"
            stroke={s.color}
            strokeWidth={2}
            strokeLinejoin="round"
          />
        ))}

        {endLabels.map((s) => (
          <g key={s.key}>
            <rect
              x={x(n - 1) + 8}
              y={s.ly - 4}
              width={8}
              height={8}
              rx={2}
              fill={s.color}
            />
            <text x={x(n - 1) + 20} y={s.ly + 3.5} className="chart-direct-label">
              {s.label[0]}
            </text>
          </g>
        ))}

        {hovered && hover !== null && (
          <g>
            <line
              x1={x(hover)}
              x2={x(hover)}
              y1={M.top}
              y2={H - M.bottom}
              stroke="#c3c2b7"
              strokeWidth={1}
            />
            {SERIES.map((s) => (
              <circle
                key={s.key}
                cx={x(hover)}
                cy={y(hovered[s.key])}
                r={3.5}
                fill={s.color}
                stroke="#ffffff"
                strokeWidth={2}
              />
            ))}
            <g transform={`translate(${tooltipX}, ${M.top + 6})`}>
              <rect width={138} height={82} rx={6} fill="#ffffff" stroke="#e1e0d9" />
              <text x={10} y={18} className="chart-tt-title">
                frame {hovered.frame_index} · {hovered.timestamp_seconds.toFixed(2)}s
              </text>
              {SERIES.map((s, i) => (
                <g key={s.key} transform={`translate(10, ${30 + i * 17})`}>
                  <rect width={8} height={8} rx={2} y={-7} fill={s.color} />
                  <text x={14} className="chart-tt-row">
                    {s.label}
                  </text>
                  <text x={118} textAnchor="end" className="chart-tt-value">
                    {hovered[s.key]}
                  </text>
                </g>
              ))}
            </g>
          </g>
        )}
      </svg>

      <details onToggle={(e) => setTableOpen(e.currentTarget.open)}>
        <summary>Data table</summary>
        {tableOpen && (
          <div className="chart-table-scroll">
            <table className="chart-table">
              <thead>
                <tr>
                  <th>Frame</th>
                  <th>Time (s)</th>
                  <th>R</th>
                  <th>G</th>
                  <th>B</th>
                </tr>
              </thead>
              <tbody>
                {frames.map((f) => (
                  <tr key={f.frame_index}>
                    <td>{f.frame_index}</td>
                    <td>{f.timestamp_seconds.toFixed(2)}</td>
                    <td>{f.r}</td>
                    <td>{f.g}</td>
                    <td>{f.b}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </details>
    </div>
  )
}

export default RgbLineChart
