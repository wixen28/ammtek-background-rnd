// Display formatting shared by the two views of one PixelHistogram: the
// per-channel panels (right column) and the joint cluster list (left).
// Formatting only — the numbers themselves come from `histogram.ts`.

export const formatShare = (share: number) => {
  const percent = share * 100
  return `${percent >= 9.95 ? Math.round(percent) : percent.toFixed(1)} %`
}

export const formatMedian = (value: number) =>
  Number.isInteger(value) ? String(value) : value.toFixed(1)
