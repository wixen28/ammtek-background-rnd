# Pixel value histogram (diagnostic)

Follow-up to Roman's feedback on the Pixel Timeline Analysis: the timeline
shows *when* a pixel's values occurred, but not *which value ranges occur
most often*, and it cannot be read off a 400-frame line chart whether a
pixel has one dominant value or several competing ones.

A bucketed frequency distribution now sits directly below the RGB timeline
in the same section, over the same samples:

- **timeline** = when the values occurred
- **histogram** = which values/ranges occurred how often

Diagnostic only. Nothing here changes RGB Mean, RGB Median, outlier
rejection, movement classification or background generation — the point is
to find out whether the single median value those methods anchor on is
actually the only strong mode.

## Where the numbers come from

No new endpoint. `GET /api/experiments/pixel-timeline?x=&y=` already returns
every frame's R/G/B for the selected pixel, and the client already holds the
whole array (the timeline's data table renders it). The histogram is
computed in the browser from that same response
(`frontend/src/histogram.ts`), so:

- selecting another pixel updates the timeline and the histogram together,
  from one request;
- changing the bucket width is instant and costs no decode.

The backend is untouched by this change.

## Representation

Two views of the same samples, deliberately — either alone would be
misleading.

### 1. Per-channel marginals (three small multiples)

One histogram per channel, one panel each, stacked and sharing both axes.

- **Per channel, not luminance or distance-from-median.** The background
  methods take the temporal median *per channel*, so per-channel buckets are
  the unit that a later algorithm change would actually act on. Collapsing
  R/G/B into a single brightness or a single distance number would throw
  away exactly the colour information this investigation needs.
- **Fixed-width buckets on the full 0–255 domain**, never scaled to the
  observed range. This is the important honesty property: a pixel that only
  ever varies between 148 and 152 must read as one narrow spike near the
  middle of the axis. A range-normalised histogram would stretch those five
  values across the whole width and make a rock-stable pixel look as spread
  out as a bimodal one.
- **Bucket widths are restricted to divisors of 256** (1, 4, 8, 16, 32 in the
  UI, default 16 → 16 buckets). A width like 10 would leave a narrower last
  bucket whose count is not comparable with the others — a false dip at the
  top of the range. Equal-width buckets are what makes comparing bar heights
  legitimate.
- **Width 1 is the ungrouped reference view** — 256 buckets, one bar per
  8-bit value, no grouping of ours between the data and the reader. Every
  wider width imposes boundaries the data knows nothing about, so a single
  physical state whose values straddle one splits into two adjacent bars and
  reads as two modes. Width 1 has no boundary to straddle, so a split seen at
  8/16/32 can be judged against it as an artifact of the grid rather than a
  second state. At width 1 the bars are drawn touching (256 bands of ~2.4px
  leave no room for the usual gap), so the panel reads as a continuous shape.
- **Empty buckets are kept**, so a gap between two modes is visible instead
  of being closed up.
- **One shared count scale across the three panels**, so channel heights are
  comparable: a channel that concentrates in one bucket visibly out-peaks a
  channel that spreads over three.
- Each panel states that channel's **median** (also drawn as a neutral
  marker line), the observed **min–max**, and its **fullest bucket** with the
  share of frames in it. The median is recomputed here as a reference only;
  it does not feed anything.

### 2. Joint colour buckets (the cluster list)

The same bucket width applied to the **(R, G, B) triple**, counted as one
key, listed most frequent first with a swatch, the bucket bounds per
channel, and the share of frames.

This exists because three independent marginals can hide the very thing we
are looking for. A pixel alternating between grey floor `(128, 128, 128)`
and a dark blue shoe `(128, 32, 200)` has a perfectly single-peaked **red**
marginal — 100 % of frames in one bucket — while jointly there are two
equally strong modes. Marginals answer "how spread is each channel"; the
joint list answers "how many distinct colours did this pixel actually take,
and in what proportion". A test covers exactly this case.

The swatch colour is the bucket **centre**, so it is an approximation of the
cluster, not an observed sample.

## Parameters

- **Bucket width** — 1 / 4 / 8 / 16 / 32, default 16. Fine widths (1, 4)
  resolve codec noise and split one physical surface into several adjacent
  buckets; coarse widths (32) merge genuinely different colours. Both
  directions are useful: if two "modes" merge at width 32 they were probably
  one surface plus noise; if a single mode splits into a smooth ramp at width
  4 that is usually illumination drift, not two states.
- Width 1 trades the two views against each other, so read them separately at
  that setting: the **marginals** gain (the raw per-value frequency pattern,
  including codec quantisation, with no grouping artifacts), while the
  **cluster list** loses its meaning — a state is a cloud of exact triples,
  not one triple, so the top cluster's share collapses even for a pixel with
  two obvious states. Judge "how many states" from the clusters at 8/16 and
  the value pattern from the marginals at 1.
- The width applies to both views at once, so the marginals and the cluster
  list always describe the same partition.

## How to read it

1. **One narrow spike per channel, one cluster at ~100 %** — a stable
   background pixel. Median and mean will agree and rejection has nothing to
   do.
2. **One tall spike plus a few short bars, one cluster clearly dominant** —
   the normal foreground-pass case. The dominant cluster is the background
   colour; the rest is what passed over it. Rejection works here, and the
   dominant share roughly predicts how many samples survive the trim.
3. **Two or more comparable clusters** — the problematic case. If the
   largest cluster is under ~50 % of frames, the per-channel median can land
   *between* the modes, in a bucket that is nearly empty. Watch for the
   median marker sitting in a gap rather than inside a bar: that is a pixel
   where the current median-anchored approach picks a colour the pixel never
   actually had, and where `trimmed_stats` can reject every sample and fall
   back to the median (the `fallback_pixels` counter).
4. **A wide smooth hill rather than distinct spikes** — illumination drift
   or noise, not two states. Coarsening the bucket width collapses it;
   genuine modes stay separate.
5. **Marginal says one thing, clusters say another** — trust the clusters
   for "how many states", the marginals for "how far each channel moves".
6. **Two adjacent bars of similar height** — check at width 1 before calling
   it two modes. If the values run continuously across the boundary between
   them it is one state split by the bucket grid; if width 1 shows two groups
   with an empty gap, the modes are real. See the (326, 227) run below, where
   width 16 reported four modes and the pixel has two.

## Runs

### 2026-08-11 — hala_orezena4.mp4 (720×480, 2721 frames), floor pixels

Two pixels a few px apart on the same open floor, both analysed over all 2721
frames. Values below are medians of the raw frame data, read directly from the
video rather than off a chart.

| pixel | frames 0–1700 | frames 2150–end | after the event |
| --- | --- | --- | --- |
| (332, 219) | R 195 G 204 B 204 | R 195 G 204 B 205 | recovers |
| (326, 227) | R 190 G 200 B 198 | R 159 G 168 B 171 | **stays ~30 lower** |

Both dip to near-black twice (a crane or vehicle passing: frames ~250–277 and
~1965–2029), so at a glance the two timelines look alike. They are not the
same case:

- **(332, 219)** returns to its original level from frame ~2200 to the end.
  Its trouble is confined to the two passes.
- **(326, 227)** steps down at frame ~1750 and never comes back: per-100-frame
  median luma runs 199 → 171 → 165 → 166 … 167 to frame 2720. This is the
  lighting change, and it is the pixel worth reasoning about — the video ends
  in a state that differs from the one the first two thirds establish.

This resolved a mix-up: the earlier histogram runs at widths 4/8/16/32 were
recorded against (332, 219), while the timeline Roman had originally flagged
shows the sustained step, i.e. (326, 227) or a neighbour. The tell in a
screenshot is the tail: recovering to the entry level vs. holding a lower one.

Watch for this when comparing screenshots: `hala_orezena3.mp4` (1280×720) and
`hala_orezena4.mp4` (720×480) are the same footage and both have exactly 2721
frames, so the timeline's x axis is identical in both and cannot tell them
apart. Only the X/Y input bounds can (0–1279 / 0–719 vs 0–719 / 0–479), and
the same coordinates mean different scene points — the scale factor is 0.5625.

Histogram of (326, 227), the two-state pixel — 1750 bright frames (64 %) and
921 darker ones (34 %):

- **Width 16** reads as *four* competing modes: R 176–191 (36 %) and R 192–207
  (33 %), G/B 192–207 (67 %) and 160–175 (29 %); joint clusters 34 %, 32 %,
  17 %, 11 %. The two large red buckets are one state — the bright floor spans
  ~189–200 and straddles the 191/192 boundary. The same happens to the dark
  state across 159/160. The bucket grid, not the pixel, produced two of the
  four modes.
- **Width 1** shows what is really there: 76 occupied red values in two groups,
  peaks at 189 (13 %), 190 (9 %) and 194 (8 %) for the bright state, 161 (9 %)
  and 159 (8 %) for the dark one, with a genuine empty gap between them. No
  bar sits at 191/192, so nothing was split there.
- The red median is 189 — inside the bright state but 1 value below the width-16
  boundary, which is why that channel looked so evenly divided.
- At width 1 the cluster list degrades as expected: 168 distinct exact triples,
  the most frequent covering only 6.6 % (`R 161 G 168 B 171`). Each state is a
  cloud — 69 distinct triples in frames 0–1749, 111 in frames 1800–2720.

## Open questions

- On the problematic floor pixels: is the failure a genuinely bimodal
  distribution (two comparable clusters), or one dominant cluster whose
  spread is wide enough that the median sits off-centre? The two call for
  different fixes (mode selection vs. a wider trim), which is why this
  diagnostic came before any algorithm change.
  - For (326, 227): genuinely bimodal, 64 % / 34 %, with a real gap between
    the states — but the split is *temporal*, not interleaved. One state holds
    frames 0–1749 and the other 1800–2720, so both are "the background", each
    for its own stretch of the video. A mode-seeking background would pick the
    64 % state and be wrong for the last third; picking either one cannot be
    right for the whole clip. Worth checking how many pixels behave this way
    before treating it as a distribution problem at all — it may be a
    segment-the-video problem.
- Does the dominant cluster's share correlate with the pixels that
  Background Variation marks as high-variation? If so it is a cheaper
  per-pixel signal than the deviation mask.
- Would a mode-seeking background (pick the fullest joint bucket, then
  average the samples inside it) beat the median on those pixels? Deliberately
  not implemented yet.
