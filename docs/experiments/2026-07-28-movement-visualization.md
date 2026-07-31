# Background vs moving pixels (diagnostic)

Shared diagnostic section, not an experiment of its own. It is rendered
below the output of every experiment that produces a background (currently
RGB Mean + outlier rejection and RGB Median), as a sibling of the pixel
timeline section. Future depth-based experiments can reuse it by passing a
background.

## What is visualized

For one selected frame, six views side by side:

1. the original frame,
2. the generated background,
3. the difference image,
4. the background in grayscale with moving pixels in their original colour,
5. the binary foreground mask,
6. the foreground pixels alone, on a transparent background.

Views 3–6 are all derived from a single comparison of that frame against
that background, so they always agree with each other.

## How the movement threshold works

Each pixel's **Euclidean RGB distance** between the frame and the
background is compared with the threshold: a pixel is foreground when its
distance is **strictly greater** than the threshold, so an unchanged pixel
is never foreground, not even at 0. Range 0–441.7 (√3·255), default 30.
The difference view shows the distance as grayscale, clipped at 255.

This threshold measures **one frame against the generated background** and
is a separate control from RGB Mean's outlier-rejection threshold, which
measures a sample against its own pixel's temporal median across frames.
Both happen to use RGB distance on the same 0–441.7 scale; they are not
the same quantity and are tuned independently.

## Which background is used

Whatever background the host page currently displays. On the RGB Mean page
that is the selected Low / Recommended / High variant, so switching
variants re-runs the comparison against the new background while keeping
the selected frame and the movement threshold. The section receives only a
background image and never learns which method produced it.

## Processing

The comparison runs in the browser on canvas pixel data. The backend only
serves the selected frame (`GET /api/videos/current/frame?frame_index=&max_width=`),
which is method independent and knows nothing about backgrounds — no
background is uploaded, stored or given an identity. Moving the threshold
recomputes locally from the already decoded frame and background, so it
costs no request; only moving the frame scrubber fetches (throttled to one
request per 250 ms, with stale responses discarded). Switching the RGB Mean
variant also costs no request — only the background is re-decoded.

Frames are served as **lossless PNG**: JPEG or WebP artifacts would appear
as movement at low thresholds, because the background they are differenced
against is lossless.

### The background defines the comparison grid

The frontend requests the frame at the **background's own width**, so the
two images are never resampled by different filters. This is not a
micro-optimization — it was measured. Serving the frame downscaled by
OpenCV (`INTER_AREA`) while letting the browser rescale the background
bilinearly moved the foreground share at threshold 30 from 10.5 % to
17.9 % on the same frame, with the resampler-induced difference reaching a
p99 of 64 — far above the threshold. The error concentrates on edges,
exactly where real movement is, so it is the worst possible place for it.

Requesting the frame at the background's width removes it: when the
experiment ran at full resolution the served frame is byte-identical to the
decoded source frame, and when it ran with `resize` both images have passed
through the same `INTER_AREA` downscale.

## Scope

Diagnostic **pixel separation** only. There is no object detection, no
classification, no tracking, no optical flow and no morphological cleanup —
each pixel is judged independently, so isolated speckle in the mask is
expected and is information about the threshold, not a defect to be
filtered.

## Observations

- **tokyo-2.mp4** (1920×1080, 1259 frames), frame 120 against an RGB Median
  background, movement threshold 30:
  - Background at full resolution: comparison grid 1920×1080, served frame
    byte-identical to the decoded source, **14.2 %** of pixels classified as
    moving. Frame payload **4.5 MB**.
  - Same background regenerated with `resize=(640, 360)`: grid 640×360,
    **10.6 %** moving, frame payload **604 KB**.
- Payload is the practical cost of the exact-grid rule: one full-resolution
  frame per scrub step is 4.5 MB, which makes scrubbing sluggish on HD
  video. Running the experiment with `resize` is the mitigation and it is
  already a supported parameter; the section shows the current grid size and
  says so when the grid is large.
- The two figures above (14.2 % vs 10.6 %) are not directly comparable: a
  finer grid resolves more small differences. Compare thresholds within one
  grid, not across grids.

## Open questions

- Which threshold gives the cleanest separation across the test videos, and
  does it agree with the outlier-rejection threshold that produced the best
  background?
- Is the mask from a plain distance cut good enough as a starting point for
  a real foreground mask, or is per-pixel independence the limiting factor?
