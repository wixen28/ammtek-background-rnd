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
4. the background in heavily dimmed grayscale with moving pixels in their
   original colour,
5. the binary foreground mask,
6. the foreground pixels alone, on a transparent background.

Views 3–6 are all derived from a single comparison of that frame against
that background, so they always agree with each other.

### Background brightness in view 4 (2026-08-04)

Static pixels in the "moving pixels in colour" view keep only
`HIGHLIGHT_BACKGROUND_BRIGHTNESS` (0.2) of their Rec. 601 luma, so the scene is
almost invisible and the foreground carries the image. Enough of it survives to
place the moving pixels in context, which a black background would not.

Presentation only, and only for that view: the multiply happens after a pixel
has been classified, on the background branch. The threshold, the classification,
the moving-pixel counts and percentage, and views 3, 5 and 6 are all unchanged,
so two runs either side of this change are directly comparable.

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

## Playback in the enlarged view (2026-07-31)

Each enlarged view has Play/Pause. The selected view is regenerated frame by
frame from the same computation as the static case — no separate animation
path. The grid and its scrubber are unchanged, and playback is offered only
inside the modal. Closing it (backdrop, close button, Escape, or the
background going away) stops playback; so does a failed frame read, since
`frame_count` comes from container metadata and can overshoot the real end of
the video.

### Self-clocking, no timer — superseded 2026-08-04

Replaced by the prefetched buffer and the frame-rate clock described below;
kept because it is why the frame rate was the request rate.

The playhead advanced only once the requested frame had arrived **and been
decoded** (`renderedIndex === frameIndex`). Consequences: exactly one request
is ever in flight, the playhead cannot run ahead of what is on screen, and no
frame is superseded mid-decode and therefore skipped. There is no timer
advancing the frame independently of loading, so playback simply runs at
whatever rate frames come back.

### The throttle applies to scrubbing only

The 250 ms trailing throttle exists because a scrubber drag can emit dozens
of positions a second. While the throttle was in the playback path the period
was `max(250 ms, frame time)`, i.e. a hard 4 fps ceiling with idle time on
every frame. Scrubbing still goes through the throttle unchanged.

Playback does not go through it at all: since 2026-08-04 it requests frames on
its own prefetch lanes and never touches the scrub path, which stays out of the
way while playing so an advance cannot trigger a second request for the frame
it just displayed.

### Measured per-frame backend cost

Sequential frames, `read_frame_at` + resize + PNG + base64, one request's
worth of work (2026-07-31, this machine):

| Source | Requested grid | Per frame | Backend-only ceiling | Payload |
| --- | --- | --- | --- | --- |
| tokyo-2.mp4 1920×1080 | 640×360 | 136 ms | 7.4 fps | 607 KB |
| tokyo-2.mp4 1920×1080 | 1920×1080 | 164 ms | 6.1 fps | 4639 KB |
| bus-stop.mp4 1920×1080 | 640×360 | 140 ms | 7.2 fps | 551 KB |
| football 640×360 | 640×360 | 25 ms | 39.6 fps | 348 KB |
| easy_people… 596×336 | 596×336 | 31 ms | 32.0 fps | 401 KB |

Broken down for tokyo-2 at 640×360: **open + seek + decode 124 ms**, resize
0.5 ms, PNG + base64 6 ms.

The decode dominates and **does not depend on the requested width** — the
frame is decoded at source resolution before being downscaled. So running the
experiment with `resize` cuts the payload (4.6 MB → 607 KB) and the browser's
per-frame work, but leaves an HD source at a ~7 fps backend ceiling. Only a
natively small source reaches fluid rates. The remaining cost is the
`VideoCapture` open plus keyframe-relative seek that `frames.py` performs per
request, which is pure waste for sequential access; removing it needs a
sequential batch endpoint or a persistent decoder, both deferred.

## Prefetched playback (2026-08-04)

Feedback on the self-clocking version was that it should be faster: cache and
preload frames ahead of time, then play them at approximately normal speed.
Self-clocking made that impossible by construction — one request in flight
means the frame rate *is* the request rate — so the supply side and the clock
were separated.

- `framePrefetch.ts` — the buffer. Pure and DOM-free, so the capacity and
  eviction rules are unit-tested (`framePrefetch.test.ts`).
- `useFramePlayback.ts` — the lanes and the clock.
- `imageData.ts` — `decodeImage`/`imageWidth`, moved out of the section so the
  prefetcher and the scrub path share one decoder.

The movement algorithm, the six views and the scrubbing path are unchanged.
Playback is still modal-only, and each frame still goes through the same
`computeMovementViews` pass as the static case — there is no separate
animation path.

### Prefetch ahead, decode ahead

Four concurrent requests (`PREFETCH_CONCURRENCY`) stay in flight ahead of the
playhead, fetching in playback order from the playhead forward. Each lane also
**decodes** its frame to RGBA before storing it, so both the network wait and
the image decode are off the playback path. A tick then costs a cache lookup, a
`computeMovementViews` pass and a paint.

Concurrency is what raises supply: the backend reopens and seeks the video per
request, and that cost is per-request, not per-frame-of-work. The route is a
sync `def`, so FastAPI runs it in its threadpool and OpenCV releases the GIL
while decoding — the lanes genuinely multiply throughput rather than queueing.

The cache holds **decoded pixels only**. Each frame's ~1 MB base64 data URL is
discarded once decoded, which halves what the buffer costs and avoids handing
the browser a new image resource to load, decode and retain 30 times a second —
the problem the `gridSuspended` note below already describes. The consequence is
that the enlarged "Original frame" view paints from a canvas during playback
instead of an `<img>`.

### Sized in bytes, not frames

Frames are held as RGBA, so one costs `width × height × 4` — 2.1 MB at 960×540
but 8.3 MB at 1920×1080. A frame count would therefore mean something entirely
different at each grid, so the budget is **128 MB** and the capacity is derived:

| Grid | Bytes/frame | Capacity | ≈ seconds at 30 fps |
| --- | --- | --- | --- |
| 640×360 | 0.92 MB | 90 (ceiling) | 3.0 s |
| 960×540 | 2.07 MB | 64 | 2.1 s |
| 1920×1080 | 8.29 MB | 16 | 0.5 s |

Eviction is the window itself: frames are only ever inserted between
`KEEP_BEHIND` behind the playhead and the capacity ahead of it, and that window
is pruned on every advance, so the cache is bounded by construction rather than
by a separate policy. Four frames are retained behind the playhead so pausing
and nudging back costs nothing.

The buffer is dropped when the enlarged view closes, the video changes or the
grid changes, and **kept across a pause** so resuming is instant. Frames are
keyed by index and invalidated by grid, not by threshold or background — so
moving the threshold still costs no request, and switching the RGB Mean variant
keeps the whole buffer, since the variants share a width.

### The clock never skips

`requestAnimationFrame` with a wall-clock accumulator at the source `fps`.
Advancing the due time by exactly one interval keeps the average rate correct
despite the ~16.7 ms animation-frame granularity.

When the next frame is not buffered the clock **holds the current frame and
waits** rather than dropping to keep real time, and the due time is then reset
instead of catching up — catching up would mean skipping. Playback therefore
degrades to the supply rate instead of losing frames, which matters for a
diagnostic where every frame is something to look at. Twelve consecutive frames
must be buffered before the first advance (`PREWARM_FRAMES`); a stall shorter
than 150 ms is not surfaced, so the indicator does not flicker when supply sits
just under the frame rate. Underruns are counted either way and shown in the
readout, along with buffer occupancy and the measured supply rate.

A frame that fails to read is treated as the end of the stream: the index is
recorded and the frames already buffered play out, rather than playback being
cut off at the point of failure. `frame_count` comes from container metadata and
can overshoot, so this is the normal way playback finishes. The trade-off is
that a genuine backend failure mid-playback also reads as a clean end; it
becomes visible as soon as the view is paused or scrubbed, since the scrub path
still surfaces errors.

### Measured (2026-08-04, this machine, MOT16-09.mp4 960×540 30 fps)

Sustained supply from the single-frame endpoint, 90 sequential frames pulled by
a fixed number of lanes — the ceiling the clock can reach, before the browser's
own decode:

| Requested grid | Lanes | Supply | Median request | p95 | Payload |
| --- | --- | --- | --- | --- | --- |
| 960×540 | 1 | 54.5 fps | 18 ms | 19 ms | 1061 KB |
| 960×540 | 2 | 91.4 fps | 22 ms | 23 ms | 1061 KB |
| 960×540 | **4** | **138.6 fps** | 29 ms | 32 ms | 1061 KB |
| 960×540 | 6 | 152.0 fps | 39 ms | 48 ms | 1061 KB |
| 640×360 | 1 | 73.7 fps | 13 ms | 14 ms | 507 KB |
| 640×360 | **4** | **175.1 fps** | 22 ms | 31 ms | 507 KB |
| 640×360 | 6 | 184.2 fps | 32 ms | 50 ms | 507 KB |

Four lanes is the knee: 2.5× one lane, while the sixth adds 10 % throughput for
a 35 % worse p95 and more contention with the browser, which is decoding and
comparing frames on the same machine.

`computeMovementViews`, the one browser-side step on the critical path that is
pure JS over typed arrays (60 runs, 12 % foreground, V8):

| Grid | Per frame | Ceiling from compute alone | Allocates |
| --- | --- | --- | --- |
| 640×360 | 1.4 ms | 693 fps | 3.5 MB/frame |
| 960×540 | 3.3 ms | 301 fps | 7.9 MB/frame |
| 1920×1080 | 14.3 ms | 70 fps | 31.6 MB/frame |

**This source is not the hard case.** MOT16-09 is natively 960×540, so its
seek + decode is 18 ms, not the 136 ms measured for a 1920×1080 source. An HD
*source* still pays the 136 ms regardless of the requested width, where four
lanes give roughly 29 fps of supply — adequate but with no margin, and 16 frames
of buffer to absorb jitter. That is the case that would justify the sequential
batch endpoint, and it remains deferred.

Browser-side per stage, from a standalone harness against the real endpoint
(`960×540`, four lanes), so no React is involved:

| Stage | Per frame |
| --- | --- |
| `fetch` | 26 ms (I/O wait; overlaps across lanes) |
| `res.json` | 2.0 ms |
| `img.decode` | 4.3 ms |
| `canvas` alloc + `drawImage` | 0.0 + 0.2 ms |
| `getImageData` | 3.4 ms |
| cache insert | 0.0 ms |
| `computeMovementViews` | 3.7 ms |
| `putImageData` | 0.1 ms |

Roughly **15 ms of main-thread work per frame**. Supply reached 88–103 fps, the
clock 89–120 fps, and the two running *together* — four lanes filling a bounded
cache while the clock computed and painted every animation frame — held **85 fps
supply with 90 fps playback**. So the architecture has about 3× headroom over
the 30 fps target at this grid.

### Achieved playback: 30.0 fps, but only in a production build

| | Dev server | Production build |
| --- | --- | --- |
| Playback | 1.2 fps | **30.0 fps** = source rate |
| Frame time | 838 ms | 33 ms |
| Advance → paint (React render + commit) | **838 ms** | **4 ms** |
| Long tasks | 6, worst 878 ms | **none** |
| Renders per displayed frame | 5.0 | 2.1 |
| Lane fetch / decode | 66 / 19 ms | 26 / 8 ms |

Playback meets the source frame rate with zero underruns and no dropped frames.

The dev figure is **not** a defect in the prefetcher. Every measured stage sums
to 3.8 ms of a 838 ms frame, and the whole difference sits in the React
render-and-commit interval, which collapses to 4 ms once dev instrumentation is
stripped. React 19.2's dev build emits `performance.measure` around its work and
serialises props for the DevTools performance track; this section puts
multi-megabyte typed arrays (`framePixels`, and `views` at 4 × 2.1 MB) through
state and props on every advance, which is a pointer copy at runtime and very
expensive to instrument. The lanes were never slow either — their 66 ms fetch was
starvation by the same block, and it is 26 ms in production, matching the
harness exactly.

### Playback paints without React (2026-08-04)

Because the cost was per *render*, not per frame of work, the fix was to stop
rendering per frame. `onAdvance` now computes and paints directly:

- The values a frame needs that are not arguments — the decoded background, the
  threshold, and which view is enlarged — are mirrored into refs, so the clock
  can read them without a render.
- The enlarged view is **one canvas element** that survives play/pause, painted
  by `paintCanvas`. Playback drives it from the clock; an effect drives it from
  state when not playing. Both call the same function, so the two paths cannot
  drift.
- The last painted frame is kept in a ref and handed back to React state **once**,
  when playback stops, so the grid, scrubber, summary and paused enlarged view
  all agree with what was last on screen.
- The frame counter and the moving-pixel share read those refs during render.
  They refresh on the buffer readout's existing 500 ms interval — about twice a
  second rather than thirty times, which is ample for a counter and costs two
  renders per second instead of sixty.

Consequences worth knowing:

- An advance triggers **no React render at all**, so React's dev instrumentation
  has nothing per-frame to instrument. The large typed arrays are also no longer
  passed as props anywhere on the playback path.
- The prefetcher, cache, clock and eviction rules are untouched. One companion
  change was needed inside the hook: the lanes used to be topped up by an effect
  on `frameIndex`, which no longer fires, so the clock now calls `pump()` itself
  after each advance. The `frameIndex` effect stays, to cover a scrub while
  playing.
- `computeMovementViews` still runs once per frame over the same inputs, so
  every view is byte-identical to the scrubbed case. Nothing about the algorithm,
  the six views, or the paused and scrubbing behaviour changed.
- `paintCanvas` reassigns the backing store only when the grid actually changes,
  rather than on every paint as `ViewCanvas` did.

Playback should be measured on a production build regardless
(`npm run build && npm run preview`, which is why `localhost:4173` is in the
backend's CORS list), but the dev server is now usable for normal work.

### On measuring this at all

Two false leads are worth recording, because both cost a round of work:

- The **backend benchmark was unrepresentative**. It showed 138 fps and was
  read as proof that supply was solved, but it measured the one stage that was
  never the bottleneck. Four lanes parallelise the backend; every lane's decode
  still runs on the one main thread, so lane concurrency is not parallelism.
- The **instrumentation dominated its own measurement**. A `console.log` per
  long task, with DevTools open, accounted for 62.7 % of total recorded time,
  and DevTools' own `Profiling overhead` a further 6.7 %, on top of React's
  45 % of `measure`. Real work — image decode 22 ms, `getImageData` 4.6 ms,
  `putImageData` 0.8 ms, paint 0.7 ms — was under 1 % of the recording. Any
  future profiling here should log nothing per frame and be read from a
  production build with DevTools closed.

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
