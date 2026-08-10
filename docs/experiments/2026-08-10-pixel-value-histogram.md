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
- **Bucket widths are restricted to divisors of 256** (4, 8, 16, 32 in the
  UI, default 16 → 16 buckets). A width like 10 would leave a narrower last
  bucket whose count is not comparable with the others — a false dip at the
  top of the range. Equal-width buckets are what makes comparing bar heights
  legitimate.
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

- **Bucket width** — 4 / 8 / 16 / 32, default 16. Fine widths (4) resolve
  codec noise and split one physical surface into several adjacent buckets;
  coarse widths (32) merge genuinely different colours. Both directions are
  useful: if two "modes" merge at width 32 they were probably one surface
  plus noise; if a single mode splits into a smooth ramp at width 4 that is
  usually illumination drift, not two states.
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

## Runs

<!-- Record input video, selected pixel, bucket width and observations. -->

## Open questions

- On the problematic floor pixels: is the failure a genuinely bimodal
  distribution (two comparable clusters), or one dominant cluster whose
  spread is wide enough that the median sits off-centre? The two call for
  different fixes (mode selection vs. a wider trim), which is why this
  diagnostic came before any algorithm change.
- Does the dominant cluster's share correlate with the pixels that
  Background Variation marks as high-variation? If so it is a cheaper
  per-pixel signal than the deviation mask.
- Would a mode-seeking background (pick the fullest joint bucket, then
  average the samples inside it) beat the median on those pixels? Deliberately
  not implemented yet.
