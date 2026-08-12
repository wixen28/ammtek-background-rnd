import { acceptanceRuns, type BackgroundRanges } from '../backgroundRanges'
import { formatShare } from './histogramFormat'

// Same width and x margins as the RGB timeline above it, so the two share a
// frame axis and a stretch of rejected frames lines up with the values that
// caused it.
const W = 680
const M = { left: 44, right: 56 }
const IW = W - M.left - M.right
const TOP = 6
const BAR_H = 22
const H = TOP + BAR_H + 26

// Accepted/rejected is a two-state annotation, not a data series, so it is
// encoded in the chart's own neutrals by lightness — a hue here would compete
// with the R/G/B identity the timeline right above establishes. Both states
// are named in the key, so the strip never relies on the fill alone.
const ACCEPTED = '#52514e'
const REJECTED = '#e8e7e0'

interface AcceptanceStripProps {
  ranges: BackgroundRanges
  /** Frame indices, so ticks read as frames rather than sample positions. */
  frameIndices: number[]
  /** Playhead of the frame simulation below, or null. */
  currentFrame: number | null
}

/**
 * Accepted vs rejected for every analyzed frame at once.
 *
 * The frame simulation shows one frame at a time; this shows the whole video,
 * which is what actually answers "do these settings survive the lighting
 * change" — a sustained band of rejection at the end is the failure, and it is
 * visible without scrubbing to it.
 */
function AcceptanceStrip({
  ranges,
  frameIndices,
  currentFrame,
}: AcceptanceStripProps) {
  const n = ranges.verdicts.length
  if (n === 0) return null

  const runs = acceptanceRuns(ranges.verdicts)
  const x = (i: number) => M.left + (i / n) * IW
  const tickCount = Math.min(8, n)
  const ticks = [
    ...new Set(
      Array.from({ length: tickCount }, (_, k) =>
        Math.round((k * (n - 1)) / Math.max(1, tickCount - 1)),
      ),
    ),
  ]
  const playhead =
    currentFrame === null
      ? null
      : frameIndices.findIndex((index) => index === currentFrame)

  return (
    <div className="chart">
      <div className="histogram-controls">
        <span className="strip-key">
          <i style={{ background: ACCEPTED }} /> accepted
        </span>
        <span className="strip-key">
          <i style={{ background: REJECTED }} /> rejected
        </span>
        <span className="histogram-controls-hint">
          {ranges.acceptedFrames} of {n} frames ·{' '}
          {formatShare(ranges.achievedCoverage)} accepted
        </span>
      </div>

      <svg
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label={`Which frames the accepted background ranges cover: ${formatShare(
          ranges.achievedCoverage,
        )} of ${n} frames`}
      >
        <rect
          x={M.left}
          y={TOP}
          width={IW}
          height={BAR_H}
          fill={REJECTED}
          stroke="#c3c2b7"
          strokeWidth={1}
        />
        {runs
          .filter((run) => run.accepted)
          .map((run) => (
            <rect
              key={run.start}
              x={x(run.start)}
              y={TOP}
              // Half a pixel minimum, so a single accepted frame in a long
              // video is still drawn rather than rounding away.
              width={Math.max(0.5, x(run.end + 1) - x(run.start))}
              height={BAR_H}
              fill={ACCEPTED}
            />
          ))}

        {playhead !== null && playhead >= 0 && (
          <g>
            <line
              x1={x(playhead + 0.5)}
              x2={x(playhead + 0.5)}
              y1={TOP - 4}
              y2={TOP + BAR_H + 4}
              stroke="#1c5cab"
              strokeWidth={1.5}
            />
            <circle cx={x(playhead + 0.5)} cy={TOP - 4} r={3} fill="#1c5cab" />
          </g>
        )}

        {ticks.map((tick) => (
          <text
            key={tick}
            x={x(tick + 0.5)}
            y={TOP + BAR_H + 16}
            textAnchor="middle"
            className="chart-tick"
          >
            {frameIndices[tick]}
          </text>
        ))}
      </svg>
    </div>
  )
}

export default AcceptanceStrip
