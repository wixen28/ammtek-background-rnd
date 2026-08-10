// The R/G/B series identity shared by the pixel-diagnostic charts, so the
// timeline and the value histogram read as one system.
//
// Validated with the dataviz palette check on the white surface: the hues
// separate under simulated CVD (worst adjacent pair ΔE 14.9 protan) while
// still reading as red/green/blue. Red lands just under the 3:1 contrast
// floor, so both charts carry text labels and a data table as relief rather
// than relying on the fill alone.
export const RGB_SERIES = [
  { key: 'r', label: 'Red', color: '#ef6a5a' },
  { key: 'g', label: 'Green', color: '#006300' },
  { key: 'b', label: 'Blue', color: '#1c5cab' },
] as const

export type ChannelKey = (typeof RGB_SERIES)[number]['key']
