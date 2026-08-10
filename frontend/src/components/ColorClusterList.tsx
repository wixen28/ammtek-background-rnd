import type { PixelHistogram } from '../histogram'
import { formatShare } from './histogramFormat'

// Enough to show a second and third mode without turning into a long table;
// the count of the rest is stated below the list.
const CLUSTERS_SHOWN = 6

interface ColorClusterListProps {
  // The same histogram the per-channel panels render, computed once by the
  // section — the two views must always describe the same bucketing.
  histogram: PixelHistogram
}

/** The joint (R, G, B) buckets of the selected pixel, most frequent first.
 *  Sits under the generated background: it is the compact summary of which
 *  colour states the pixel actually took. */
function ColorClusterList({ histogram }: ColorClusterListProps) {
  const { clusters } = histogram
  const shown = clusters.slice(0, CLUSTERS_SHOWN)
  const remaining = clusters.length - shown.length

  return (
    <div className="histogram-clusters">
      <h5 className="pixel-subheading">Most frequent colour buckets</h5>
      <p className="content-hint">
        Buckets of the full RGB triple, so a pixel alternating between two
        colours shows two rows even where a single channel looks
        single-peaked.
      </p>
      <p className="histogram-clusters-summary">
        {clusters.length} occupied {clusters.length === 1 ? 'bucket' : 'buckets'} ·
        most frequent covers {formatShare(clusters[0].share)} of frames
      </p>
      <ul>
        {shown.map((cluster) => (
          <li key={`${cluster.r[0]}-${cluster.g[0]}-${cluster.b[0]}`}>
            <span
              className="histogram-swatch"
              style={{
                background: `rgb(${cluster.color.r} ${cluster.color.g} ${cluster.color.b})`,
              }}
            />
            <span className="histogram-cluster-range">
              R {cluster.r[0]}–{cluster.r[1]} G {cluster.g[0]}–{cluster.g[1]} B{' '}
              {cluster.b[0]}–{cluster.b[1]}
            </span>
            <span className="histogram-share-track">
              <span
                className="histogram-share-fill"
                style={{ width: `${cluster.share * 100}%` }}
              />
            </span>
            <span className="histogram-cluster-count">
              {cluster.count} · {formatShare(cluster.share)}
            </span>
          </li>
        ))}
      </ul>
      {remaining > 0 && (
        <p className="content-hint">
          + {remaining} further {remaining === 1 ? 'bucket' : 'buckets'} with
          fewer frames.
        </p>
      )}
    </div>
  )
}

export default ColorClusterList
