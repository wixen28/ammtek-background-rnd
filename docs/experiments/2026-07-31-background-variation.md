# Background Variation

## Method

Standalone experiment (`POST /api/experiments/background-variation`, own
sidebar screen). RGB Mean answers *what is the background here*; this
answers *how settled is that answer*.

Both run the same median-anchored rejection pass, shared in
`processing/background/trimmed_stats.py`:

1. Sample frames (same `use_all_frames` / `target_frames` / `resize`
   controls and the same evenly-spread sampling as RGB Mean and RGB Median).
2. Per pixel, take the per-channel **temporal median** as the robust
   reference.
3. Reject samples whose **Euclidean RGB distance** from that median exceeds
   `rejection_threshold` — the same cut RGB Mean uses.
4. Over the **remaining inlier samples**, take the **mean Euclidean RGB
   distance from the median**. That scalar is the variation rejection did
   *not* remove.

The scalar is rendered as a **single-channel grayscale mask**, scaled
linearly from true zero by the run's largest deviation:

```
gray = round(deviation / deviation_max * 255)     (0 when deviation_max == 0)
```

So **black means the kept samples agree** (settled background estimate) and
**brighter means more surviving variation**. Anchoring at zero rather than
at the observed minimum keeps black meaning "stable" instead of "least
varying pixel in this particular clip", so a mask is readable on its own
terms. The run reports the actual range, so a gray value maps back to RGB
distance units: `deviation ≈ gray / 255 * deviation_max`.

### What this is not

Deliberately **not** a mask of the rejected outliers. That would be a
per-frame motion occupancy map — dense, speckled, and already covered by the
movement diagnostic (`2026-07-28-movement-visualization.md`). The point here
is the *residual* among the samples that survived: sensor noise,
illumination drift, and motion small or slow enough to stay under the
threshold.

### Why mean deviation from the median

- It is nearly free: the shared pass already computes the median and the
  squared-distance matrix, so the added cost is one square root per band and
  one masked sum per threshold.
- Same units as every other control in the tool (0–441.7, √3·255), shared
  with the rejection threshold and the movement threshold — so the numbers
  are directly comparable to controls the user already understands.
- Bounded by construction: kept samples are within the rejection threshold
  of the median, so `deviation ≤ rejection_threshold` always.
- Robust: after trimming, the mean absolute deviation is effectively a
  trimmed MAD. Maximum deviation was rejected as the primary metric because
  one borderline sample that squeaked under the cut pins a pixel to the
  threshold and saturates the map.

## Parameters

- `use_all_frames` (default true) — process every frame of the video.
- `target_frames` — approximate number of frames used when
  `use_all_frames` is false; sampled evenly across the whole video.
- `resize` — optional output resolution used during processing.
- `rejection_threshold` (default 30) — Euclidean RGB distance from the
  per-pixel temporal median beyond which a sample is rejected. Range
  0–441.7; ≥442 disables rejection, so the deviation is then measured over
  every sample (a useful baseline). Not capped on the upper end.

A single threshold, not a sweep: the screen reports one mask and one
deviation range.

## Reported

- `deviation_min` / `deviation_max` — the range in RGB distance units, over
  pixels that kept at least one sample.
- `rejected_fraction` — share of all pixel samples rejected.
- `fallback_pixels` — pixels where every sample was rejected.
- `background` — the trimmed mean, for reference. Byte-identical to RGB
  Mean's background at the same threshold (covered by a test).
- `variation_mask` — the grayscale mask, lossless single-channel PNG.

## Runs

<!-- Record input video, parameters, runtime, and observations for each run. -->

## Expected behavior

- Flat, well-lit, genuinely static regions go black. Textured or noisy
  regions (dark areas where sensor noise dominates, foliage, water,
  reflections, screens) stay bright.
- The map is **threshold-dependent by construction** — deviation cannot
  exceed the rejection threshold, so lowering the threshold darkens the mask
  overall. Compare masks at one threshold, not across thresholds.
- **Global illumination drift dominates the map when present.** The
  2026-07-23 RGB Mean run recorded gradual drift on
  `easy_people_passing_each_other.mp4` that inflated the rejected share to
  22.5 % and shifted every pixel by a median of 13/255. Under this metric
  that drift raises *every* pixel's deviation for a reason that has nothing
  to do with local instability. There is no temporal model here — only a
  per-pixel distance cut — so drifting footage will read as uniformly
  unstable. Per-frame brightness normalization would address it and is
  deliberately not implemented.
- If one pixel's deviation approaches the rejection threshold, it sets
  `deviation_max` and the rest of the map darkens. The reported range makes
  that visible rather than hiding it.
- **Fallback pixels appear black, like a stable pixel.** With no kept
  samples there is nothing to measure, so they land at 0.0 — which reads as
  the opposite of the truth. They are excluded from `deviation_min` /
  `deviation_max` (so a handful of them cannot pull the reported minimum to
  zero) and counted separately in the summary. At the default threshold this
  is negligible in practice — 3 of ~2M pixels on the recorded RGB Mean run,
  0 at threshold 50 — but it matters at very low thresholds, where most
  pixels fall back and the mask goes uniformly black.
- Degenerate cases yield a uniformly black mask with `min == max == 0`: a
  single-frame video, perfectly static footage, or a threshold low enough
  that no pixel keeps a sample.
- Memory is the same as RGB Mean (all sampled frames in RAM at once), plus
  one `(H, W) float32` deviation map and one band-sized distance array.
  `resize` or `target_frames` are the mitigation.

## Scope

One background, one mask, one deviation range. No heatmap colouring, no
adjustable mask threshold, no confidence or per-channel maps, no spatial
smoothing, no pixel timeline or movement section on this screen, no export.
The mask is a measurement, so nothing synthetic is written into it.

## Open questions

- Does the variation mask predict where the movement mask goes speckly? If
  so it is a candidate input for a per-pixel adaptive movement threshold.
- How much of a typical map is illumination drift rather than local
  instability, and is per-frame brightness normalization worth adding?
- Is mean deviation the right summary, or would a percentile of the kept
  distances separate "noisy" from "occasionally disturbed" more cleanly?
