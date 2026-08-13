import {
  MAX_BACKGROUND_RANGES,
  MAX_RANGE_WIDTH,
  MAX_SIGNAL,
  MAX_TOLERANCE,
  MIN_RANGE_WIDTH,
  MIN_SIGNAL,
  MIN_TOLERANCE,
  type RangeSettings,
} from '../backgroundRanges'

interface RangeSettingsControlsProps {
  settings: RangeSettings
  onChange: (settings: RangeSettings) => void
}

const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value))

/**
 * The four controls that decide what counts as background, in one row.
 *
 * Sits directly above the histograms it marks: switching Ranges allowed has to
 * change the marked bands in view, which is only true if the two are adjacent.
 * Every control is instant — the ranges are re-derived in the browser from the
 * timeline response already held, so none of these costs a request.
 */
function RangeSettingsControls({
  settings,
  onChange,
}: RangeSettingsControlsProps) {
  const signal = Math.round(settings.signal * 100)
  const width = Math.round(settings.width * 100)

  const setSignal = (percent: number) => {
    if (!Number.isFinite(percent)) return
    onChange({
      ...settings,
      signal: Number(
        clamp(percent / 100, MIN_SIGNAL, MAX_SIGNAL).toFixed(2),
      ),
    })
  }
  const setWidth = (percent: number) => {
    if (!Number.isFinite(percent)) return
    onChange({
      ...settings,
      width: Number(
        clamp(percent / 100, MIN_RANGE_WIDTH, MAX_RANGE_WIDTH).toFixed(2),
      ),
    })
  }
  const setTolerance = (value: number) => {
    if (!Number.isFinite(value)) return
    onChange({
      ...settings,
      tolerance: Math.round(clamp(value, MIN_TOLERANCE, MAX_TOLERANCE)),
    })
  }

  return (
    <div className="range-controls">
      <label>
        Accepted signal ({signal} %)
        <input
          type="range"
          min={Math.round(MIN_SIGNAL * 100)}
          max={Math.round(MAX_SIGNAL * 100)}
          value={signal}
          onChange={(e) => setSignal(Number(e.target.value))}
        />
      </label>
      <label>
        Range width ({width} %)
        <input
          type="range"
          min={Math.round(MIN_RANGE_WIDTH * 100)}
          max={Math.round(MAX_RANGE_WIDTH * 100)}
          value={width}
          onChange={(e) => setWidth(Number(e.target.value))}
        />
      </label>
      <label>
        Tolerance ±{settings.tolerance}
        <input
          type="range"
          min={MIN_TOLERANCE}
          max={MAX_TOLERANCE}
          value={settings.tolerance}
          onChange={(e) => setTolerance(Number(e.target.value))}
        />
      </label>
      <div className="histogram-controls range-controls-ranges">
        <span className="histogram-controls-label">Ranges allowed</span>
        {Array.from({ length: MAX_BACKGROUND_RANGES }, (_, i) => i + 1).map(
          (allowed) => (
            <button
              key={allowed}
              type="button"
              className={allowed === settings.maxRanges ? 'active' : undefined}
              onClick={() => onChange({ ...settings, maxRanges: allowed })}
            >
              {allowed}
            </button>
          ),
        )}
      </div>
    </div>
  )
}

export default RangeSettingsControls
