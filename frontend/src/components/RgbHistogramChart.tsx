import { useState } from 'react'
import { BUCKET_WIDTHS, type BucketWidth, type PixelHistogram } from '../histogram'
import { RGB_SERIES } from '../rgbSeries'
import { formatMedian, formatShare } from './histogramFormat'

// Small multiples, one channel per row: the three channels share the value
// domain and the count scale, but overlaying them would either hide bars
// behind each other or need transparency that misreads as a fourth colour.
// Faceting keeps every bar readable and still allows height comparison.
const W = 680
const M = { top: 4, right: 14, bottom: 38, left: 46 }
const IW = W - M.left - M.right
const ROW_HEADER = 15
const PLOT_H = 62
const ROW_GAP = 12
const ROW_STRIDE = ROW_HEADER + PLOT_H + ROW_GAP
const H = M.top + ROW_STRIDE * RGB_SERIES.length - ROW_GAP + M.bottom

const MAX_BAR_W = 24
const BAR_RADIUS = 4
const BAR_GAP = 2

// Same ticks as the timeline's y axis, so the two charts read as one system:
// there the value domain runs vertically, here horizontally.
const X_TICKS = [0, 64, 128, 192, 255]

const TOOLTIP_W = 172
// Kept short enough to stay inside the first panel and its gap, so the other
// panels' headers (median, range, fullest bucket) are never covered.
const TOOLTIP_H = 66
const TOOLTIP_ROW_H = 14

/** Column with a rounded data-end and a square baseline. */
function barPath(x: number, top: number, width: number, height: number) {
  const r = Math.max(0, Math.min(BAR_RADIUS, width / 2, height))
  const bottom = top + height
  return [
    `M${x} ${bottom}`,
    `L${x} ${top + r}`,
    `Q${x} ${top} ${x + r} ${top}`,
    `L${x + width - r} ${top}`,
    `Q${x + width} ${top} ${x + width} ${top + r}`,
    `L${x + width} ${bottom}`,
    'Z',
  ].join(' ')
}

interface RgbHistogramChartProps {
  // Computed once by the section and shared with the cluster list, so both
  // views always describe the same bucketing.
  histogram: PixelHistogram
  onBucketWidthChange: (bucketWidth: BucketWidth) => void
}

function RgbHistogramChart({
  histogram,
  onBucketWidthChange,
}: RgbHistogramChartProps) {
  const [hover, setHover] = useState<number | null>(null)
  const [tableOpen, setTableOpen] = useState(false)

  const { bucketWidth, bucketCount, maxCount, sampleCount } = histogram

  const xOfValue = (value: number) => M.left + (value / 256) * IW
  const band = IW / bucketCount
  const barW = Math.max(1, Math.min(MAX_BAR_W, band - BAR_GAP))
  const barX = (index: number) => M.left + index * band + (band - barW) / 2

  const rowTop = (row: number) => M.top + row * ROW_STRIDE
  const plotTop = (row: number) => rowTop(row) + ROW_HEADER
  const plotBottom = (row: number) => plotTop(row) + PLOT_H
  const yOfCount = (row: number, count: number) =>
    plotBottom(row) - (count / maxCount) * PLOT_H

  const handleMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect()
    const px = ((e.clientX - rect.left) / rect.width) * W
    const index = Math.floor((px - M.left) / band)
    setHover(index >= 0 && index < bucketCount ? index : null)
  }

  const hoveredStart = hover !== null ? hover * bucketWidth : 0
  const tooltipX =
    hover !== null
      ? Math.min(
          Math.max(M.left, barX(hover) + barW + 8),
          W - M.right - TOOLTIP_W,
        )
      : 0

  // Looked up by key rather than by index, so the panels cannot silently
  // pair a colour with the wrong channel.
  const byChannel = new Map(histogram.channels.map((c) => [c.channel, c]))

  return (
    <div className="chart histogram">
      <div className="histogram-controls">
        <span className="histogram-controls-label">Bucket width</span>
        {BUCKET_WIDTHS.map((width) => (
          <button
            key={width}
            type="button"
            className={width === bucketWidth ? 'active' : undefined}
            onClick={() => {
              onBucketWidthChange(width)
              setHover(null)
            }}
          >
            {width}
          </button>
        ))}
        <span className="histogram-controls-hint">
          {bucketCount} buckets over 0–255 · {sampleCount} frames
        </span>
        <span className="histogram-marker-key">
          <svg viewBox="0 0 9 10" aria-hidden="true">
            <path d="M0.5 0.5 L8.5 0.5 L4.5 5 Z" fill="#52514e" />
            <line x1="4.5" y1="0.5" x2="4.5" y2="10" stroke="#52514e" strokeWidth="1" />
          </svg>
          channel median
        </span>
      </div>

      <svg
        viewBox={`0 0 ${W} ${H}`}
        onMouseMove={handleMove}
        onMouseLeave={() => setHover(null)}
        role="img"
        aria-label="How often each RGB value range occurred across the analyzed frames, one panel per channel"
      >
        {RGB_SERIES.map((series, row) => {
          const data = byChannel.get(series.key)!
          const peak = data.buckets[data.peakIndex]
          return (
            <g key={series.key}>
              <rect
                x={M.left}
                y={rowTop(row) + 3}
                width={8}
                height={8}
                rx={2}
                fill={series.color}
              />
              <text
                x={M.left + 14}
                y={rowTop(row) + 11}
                className="chart-direct-label"
              >
                {series.label}
              </text>
              {/* Right-aligned so it cannot collide with the channel name,
                  whatever the numbers are. */}
              <text
                x={W - M.right}
                y={rowTop(row) + 11}
                textAnchor="end"
                className="chart-row-stat"
              >
                median {formatMedian(data.median)} · range {data.min}–{data.max} ·
                fullest bucket {peak.start}–{peak.end} (
                {formatShare(peak.count / sampleCount)})
              </text>

              {/* Baseline plus one gridline at the shared maximum. */}
              <line
                x1={M.left}
                x2={W - M.right}
                y1={plotTop(row)}
                y2={plotTop(row)}
                stroke="#e1e0d9"
                strokeWidth={1}
              />
              <line
                x1={M.left}
                x2={W - M.right}
                y1={plotBottom(row)}
                y2={plotBottom(row)}
                stroke="#c3c2b7"
                strokeWidth={1}
              />
              <text
                x={M.left - 8}
                y={plotTop(row) + 4}
                textAnchor="end"
                className="chart-tick"
              >
                {maxCount}
              </text>
              <text
                x={M.left - 8}
                y={plotBottom(row) + 4}
                textAnchor="end"
                className="chart-tick"
              >
                0
              </text>

              {data.buckets.map((bucket) =>
                bucket.count === 0 ? null : (
                  <path
                    key={bucket.index}
                    d={barPath(
                      barX(bucket.index),
                      yOfCount(row, bucket.count),
                      barW,
                      plotBottom(row) - yOfCount(row, bucket.count),
                    )}
                    fill={series.color}
                  />
                ),
              )}

              {/* Where this channel's temporal median falls. Neutral, not the
                  series colour: it is a reference, not data. */}
              <line
                x1={xOfValue(data.median + 0.5)}
                x2={xOfValue(data.median + 0.5)}
                y1={plotTop(row)}
                y2={plotBottom(row)}
                stroke="#52514e"
                strokeWidth={1}
              />
              <path
                d={`M${xOfValue(data.median + 0.5) - 3.5} ${plotTop(row)} L${
                  xOfValue(data.median + 0.5) + 3.5
                } ${plotTop(row)} L${xOfValue(data.median + 0.5)} ${
                  plotTop(row) + 4.5
                } Z`}
                fill="#52514e"
              />
            </g>
          )
        })}

        {X_TICKS.map((tick) => (
          <text
            key={tick}
            x={tick === 255 ? xOfValue(256) : xOfValue(tick)}
            y={H - M.bottom + 18}
            textAnchor={tick === 255 ? 'end' : tick === 0 ? 'start' : 'middle'}
            className="chart-tick"
          >
            {tick}
          </text>
        ))}
        <text
          x={M.left + IW / 2}
          y={H - 4}
          textAnchor="middle"
          className="chart-axis-label"
        >
          pixel value (0–255), bucketed · bar height = frames
        </text>

        {hover !== null && (
          <g>
            {RGB_SERIES.map((_, row) => (
              <rect
                key={row}
                x={M.left + hover * band}
                y={plotTop(row)}
                width={band}
                height={PLOT_H}
                fill="#1f2328"
                fillOpacity={0.06}
              />
            ))}
            <g transform={`translate(${tooltipX}, ${M.top + ROW_HEADER + 4})`}>
              <rect
                width={TOOLTIP_W}
                height={TOOLTIP_H}
                rx={6}
                fill="#ffffff"
                stroke="#e1e0d9"
              />
              <text x={10} y={16} className="chart-tt-title">
                values {hoveredStart}–{hoveredStart + bucketWidth - 1}
              </text>
              {RGB_SERIES.map((series, row) => {
                const bucket = byChannel.get(series.key)!.buckets[hover]
                return (
                  <g
                    key={series.key}
                    transform={`translate(10, ${30 + row * TOOLTIP_ROW_H})`}
                  >
                    <rect width={8} height={8} rx={2} y={-7} fill={series.color} />
                    <text x={14} className="chart-tt-row">
                      {series.label}
                    </text>
                    <text
                      x={TOOLTIP_W - 20}
                      textAnchor="end"
                      className="chart-tt-value"
                    >
                      {bucket.count} · {formatShare(bucket.count / sampleCount)}
                    </text>
                  </g>
                )
              })}
            </g>
          </g>
        )}
      </svg>

      <details onToggle={(e) => setTableOpen(e.currentTarget.open)}>
        <summary>Histogram data table</summary>
        {tableOpen && (
          <div className="chart-table-scroll">
            <table className="chart-table">
              <thead>
                <tr>
                  <th>Value range</th>
                  <th>R</th>
                  <th>G</th>
                  <th>B</th>
                </tr>
              </thead>
              <tbody>
                {histogram.channels[0].buckets.map((bucket) => (
                  <tr key={bucket.index}>
                    <td>
                      {bucket.start}–{bucket.end}
                    </td>
                    {RGB_SERIES.map((series) => (
                      <td key={series.key}>
                        {byChannel.get(series.key)!.buckets[bucket.index].count}
                      </td>
                    ))}
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

export default RgbHistogramChart
