# RGB Median background extraction

## Method

Per-channel temporal median over frames sampled approximately evenly
across the video, used **directly** as the background
(`POST /api/experiments/rgb-median`).

For each pixel, the R, G and B values are computed independently as the
median of that channel across the sampled frames; with an even number of
frames each value is the average of the two middle samples, rounded to
uint8. No outlier rejection is applied — the median is inherently robust
to brief foreground passes (anything covering a pixel for well under half
of the sampled frames cannot move it), so this experiment tests whether
the plain median already matches RGB Mean + outlier rejection, which uses
the same median only as an internal reference and outputs a trimmed mean.

Frame selection is shared with RGB Mean (`use_all_frames`,
`target_frames`, `resize` and the same evenly-spread sampling), so both
methods can be run on the same persisted input video with identical
parameters and compared manually.

Like RGB Mean, the median needs every sample at once, so all sampled
frames are stacked in memory (N × H × W × 3 uint8); the median is
computed with `overwrite_input=True`, which partitions the stack in place
instead of copying it.

## Parameters

- `use_all_frames` (default true) — process every frame of the video.
- `target_frames` — approximate number of frames used when
  `use_all_frames` is false; sampled evenly across the whole video.
- `resize` — optional output resolution used during processing.

## Runs

<!-- Record input video, parameters, runtime, and observations for each run. -->

- **2026-07-24 — high_five.mp4** (596×336, 257 frames, all frames, no
  resize), compared against RGB Mean + rejection (threshold 30) and the
  plain mean (threshold 500) on the same input:
  - **Median vs Mean+rejection(30): practically identical.** Median
    per-pixel difference 1/255, p99 = 3, maximum 9; only 0.04 % of
    pixels differ by more than 5 and none by more than 10. The two
    robust methods converge to the same background on this video.
  - **Both differ from the plain mean the same way** (mean abs diff
    ~4.8–4.9/255, ~18 % of pixels differing by >10, max ~30) — this is
    the ghosting/illumination bias both methods remove. Rejection at
    threshold 30 discarded 8.8 % of samples, no fallback pixels.
  - **Runtime: median 0.41 s vs mean+rejection 1.10 s** (~2.7× faster) —
    the median needs one partition pass instead of median + distance +
    masked-mean passes.
  - No visible noise penalty from the median's lack of averaging at this
    resolution; per-pixel differences to the trimmed mean stay within
    compression-noise range (≤ 9/255).

## Expected behavior

- Ghosting from moving objects is removed as long as the object covers a
  pixel for well under half of the sampled frames — the same regime where
  RGB Mean's rejection works, but with no threshold to tune.
- Compared with RGB Mean + rejection: the median keeps none of the
  averaging, so per-pixel noise is that of a single (middle) sample
  rather than being smoothed across kept samples. Expect slightly noisier
  flat areas but no threshold-dependent artifacts (no fallback pixels, no
  sensitivity to global illumination drift inflating the rejected share).
- Objects that sit still for about half the video or more capture the
  median and stay in the background — the same failure mode as the
  median-anchored rejection in RGB Mean.
- Memory is the same as RGB Mean: all sampled frames are held in RAM at
  once; `resize` or `target_frames` are the mitigation.

## Diagnostics

- **Pixel timeline**: the shared analysis section (same as on the RGB Mean
  page) is available here too — pixels are selected on the median
  background, and the timeline is read from the original video. It includes
  the value histogram below the timeline chart
  (`2026-08-10-pixel-value-histogram.md`), which is the direct check on this
  method's assumption: the median is only a good background value if the
  pixel has one dominant mode.
- **Background vs moving pixels**: the same shared section as on the RGB
  Mean page (see `2026-07-28-movement-visualization.md`), here comparing a
  selected frame against the median background.

## Open questions

- Is the plain median visually distinguishable from RGB Mean + rejection
  on the test videos, and where?
- Does the median's lack of averaging show as visible noise on real
  footage?
