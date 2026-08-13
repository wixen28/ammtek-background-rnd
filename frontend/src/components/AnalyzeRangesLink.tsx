interface AnalyzeRangesLinkProps {
  onClick: () => void
}

/**
 * The way into the pixel / background-range analysis, offered under a finished
 * run rather than from the sidebar: the analysis is *of that run's* background,
 * so it only means anything once there is one.
 */
function AnalyzeRangesLink({ onClick }: AnalyzeRangesLinkProps) {
  return (
    <p className="analyze-action">
      <button type="button" onClick={onClick}>
        Analyze pixels &amp; background ranges →
      </button>
    </p>
  )
}

export default AnalyzeRangesLink
