import { useCallback, useMemo, useState } from 'react'
import type { PixelTimeline, VideoRecord } from '../api'
import {
  computeBackgroundRanges,
  DEFAULT_RANGE_SETTINGS,
  type RangeSettings,
} from '../backgroundRanges'
import {
  computePixelHistogram,
  DEFAULT_BUCKET_WIDTH,
  type BucketWidth,
} from '../histogram'
import AcceptanceStrip from '../components/AcceptanceStrip'
import ColorClusterList from '../components/ColorClusterList'
import FrameSimulationSection from '../components/FrameSimulationSection'
import PixelSelectSection from '../components/PixelSelectSection'
import RangeSettingsControls from '../components/RangeSettingsControls'
import RgbHistogramChart from '../components/RgbHistogramChart'
import { formatShare } from '../components/histogramFormat'

interface PixelRangeAnalysisPageProps {
  currentVideo: VideoRecord
  /** Background from the run this was opened from, for pixel selection. */
  background: string | null
  /** Which experiment produced it, for the back link. */
  sourceLabel: string
  onBack: () => void
}

/**
 * Pixel and background-range analysis, on its own screen.
 *
 * Everything the experiment pages used to carry inline, reorganized so the
 * parts that are read together sit together: the settings directly above the
 * histograms they mark, the range list beside them, and the whole-frame
 * simulation below. Switching Ranges allowed changes the marked bands without
 * scrolling, which is the comparison this screen exists to make.
 *
 * All state lives here so that one timeline response feeds the histogram, the
 * ranges, the acceptance strip and the simulation — nothing is derived twice.
 */
function PixelRangeAnalysisPage({
  currentVideo,
  background,
  sourceLabel,
  onBack,
}: PixelRangeAnalysisPageProps) {
  const [timeline, setTimeline] = useState<PixelTimeline | null>(null)
  const [bucketWidth, setBucketWidth] = useState<BucketWidth>(
    DEFAULT_BUCKET_WIDTH,
  )
  const [settings, setSettings] = useState<RangeSettings>(
    DEFAULT_RANGE_SETTINGS,
  )
  // The simulation's playhead, held here so the acceptance strip can mark it:
  // the strip is the selected pixel's verdict on every frame, and the frame on
  // screen is one of them.
  const [simulationFrame, setSimulationFrame] = useState(0)

  // Stable, so the selection section is not re-subscribed on every keystroke.
  const handleTimeline = useCallback(
    (next: PixelTimeline | null) => setTimeline(next),
    [],
  )

  const histogram = useMemo(
    () =>
      timeline && timeline.frames.length > 0
        ? computePixelHistogram(timeline.frames, bucketWidth)
        : null,
    [timeline, bucketWidth],
  )

  // Derived from the raw samples, not from the histogram, so the marked
  // boundaries do not move when the bucket width is changed for reading.
  const ranges = useMemo(
    () =>
      timeline && timeline.frames.length > 0
        ? computeBackgroundRanges(timeline.frames, settings)
        : null,
    [timeline, settings],
  )

  const frameIndices = useMemo(
    () => timeline?.frames.map((sample) => sample.frame_index) ?? [],
    [timeline],
  )

  const pixel = timeline ? { x: timeline.x, y: timeline.y } : null

  return (
    <>
      <div className="page-head">
        <h2>Pixel / Background Range Analysis</h2>
        <button type="button" className="link-button" onClick={onBack}>
          ← Back to {sourceLabel}
        </button>
      </div>

      <PixelSelectSection
        currentVideo={currentVideo}
        background={background}
        onTimelineChange={handleTimeline}
      />

      {!histogram || !ranges || !timeline ? (
        <p className="content-hint">
          Select a pixel — click the background, or type coordinates — to derive
          its value distribution and accepted background ranges.
        </p>
      ) : (
        <>
          <section className="ranges-section">
            <RangeSettingsControls settings={settings} onChange={setSettings} />

            <div className="ranges-layout">
              <div className="ranges-layout-chart">
                <RgbHistogramChart
                  histogram={histogram}
                  onBucketWidthChange={setBucketWidth}
                  ranges={ranges}
                />
              </div>

              <div className="ranges-layout-side">
                <dl className="ranges-summary">
                  <div>
                    <dt>Pixel</dt>
                    <dd>
                      ({timeline.x}, {timeline.y})
                    </dd>
                  </div>
                  <div>
                    <dt>Frames covered</dt>
                    <dd>
                      {formatShare(ranges.achievedCoverage)} (
                      {ranges.acceptedFrames} of {ranges.sampleCount})
                    </dd>
                  </div>
                  <div>
                    <dt>Ranges</dt>
                    <dd>
                      {ranges.ranges.length} of {ranges.modeCount} state
                      {ranges.modeCount === 1 ? '' : 's'}
                    </dd>
                  </div>
                  <div>
                    <dt>Split on</dt>
                    <dd>
                      {ranges.split
                        ? `${ranges.split.channel.toUpperCase()} at ${ranges.split.value} · η ${ranges.split.separation.toFixed(2)}`
                        : 'nothing — one state'}
                    </dd>
                  </div>
                </dl>

                <ul className="range-cards">
                  {ranges.ranges.map((range) => (
                    <li className="range-card" key={range.rank}>
                      <span className="range-card-head">
                        <span
                          className="histogram-swatch"
                          style={{
                            background: `rgb(${range.color.r} ${range.color.g} ${range.color.b})`,
                          }}
                        />
                        Range {range.rank}
                        <span className="range-card-share">
                          {formatShare(range.share)} of frames
                        </span>
                      </span>
                      <span className="range-card-bounds">
                        R {range.r[0]}–{range.r[1]} · G {range.g[0]}–{range.g[1]}{' '}
                        · B {range.b[0]}–{range.b[1]}
                      </span>
                      <span className="range-card-meta">
                        centre rgb({range.color.r}, {range.color.g},{' '}
                        {range.color.b}) · frames {range.firstFrame}–
                        {range.lastFrame} · {range.acceptedFrames} accepted of{' '}
                        {range.modeFrames}
                      </span>
                    </li>
                  ))}
                </ul>

                <ColorClusterList histogram={histogram} />
              </div>
            </div>

            <h4 className="pixel-subheading">Accepted frames</h4>
            <AcceptanceStrip
              ranges={ranges}
              frameIndices={frameIndices}
              currentFrame={simulationFrame}
            />
          </section>

          <FrameSimulationSection
            currentVideo={currentVideo}
            settings={settings}
            pixel={pixel}
            frameIndex={simulationFrame}
            onFrameIndexChange={setSimulationFrame}
          />
        </>
      )}

      <section className="page-notes">
        <h4>Notes</h4>
        <p>
          <strong>Accepted signal</strong> is a frequency, not a colour
          distance: the share of the pixel&apos;s own frame history the accepted
          ranges together have to explain. It decides <em>how many</em> ranges
          are used — the strongest state is always accepted, the next only while
          the boxes so far still leave more than the requested share rejected.
        </p>
        <p>
          <strong>Range width</strong> decides <em>how wide</em> each accepted
          state&apos;s box is: the central share of that state&apos;s own values
          kept per channel, so the sparse tails (a passing object, codec
          outliers) fall outside it. <strong>Tolerance</strong> then adds a
          fixed number of RGB values to each side. Width is relative to a
          state&apos;s spread and tolerance is absolute, which is why a pixel
          that barely varies needs the second one to survive sensor noise.
        </p>
        <p>
          States come from an Otsu split of the channel that separates best,
          applied to the <em>frames</em> rather than to each channel
          independently — three independent splits would describe eight box
          corners, most of which the pixel never took. A third state is a
          further split of whichever state then holds the most frames. η is the
          share of that channel&apos;s variance lying between the states: near 1
          means two genuinely distinct states, near 0 means one spread-out state
          split only to reach the requested signal.
        </p>
        <p>
          The <strong>frame simulation</strong> runs that same derivation for
          every pixel on the backend and classifies each pixel against its own
          boxes. It is not the previous frame test, which applied one
          pixel&apos;s ranges to the whole grid and therefore rejected most of a
          uniform floor. Bucket width only affects how the histogram is drawn;
          it never enters the derivation.
        </p>
      </section>
    </>
  )
}

export default PixelRangeAnalysisPage
