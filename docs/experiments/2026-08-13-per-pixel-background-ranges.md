# Per-pixel background ranges (diagnostic)

Follow-up to *Accepted background ranges*, which answered the question for one
selected pixel and left three things open: only two states, one control doing
two jobs, and a frame test that was not a per-pixel verdict. This iteration
closes all three.

Diagnostic only. Nothing here changes RGB Mean, RGB Median, outlier rejection,
movement classification or background generation.

## What changed

1. **Up to three ranges** instead of two.
2. **Accepted signal and Range width are separate controls**, plus an absolute
   **Tolerance**. One number could not loosen a box without also buying more
   boxes.
3. **A real whole-frame simulation**: a new backend endpoint derives ranges for
   *every* pixel and the browser judges each pixel against its own boxes. The
   old frame test applied one pixel's boxes to the whole grid, which is why
   large parts of a uniform floor read as rejected — the floor is not that one
   shade everywhere.
4. **Its own screen.** The analysis left the experiment pages, which now show
   only their run and an `Analyze pixels & background ranges →` action. Nothing
   was duplicated: the pixel timeline has one implementation and it moved.

## Accepted signal vs Range width

Both are frequencies, and they answer different questions.

**Accepted signal P** (50–100 %, default 90) — a *global stopping rule over the
union of the boxes*. The strongest state is always accepted; the next is added
only while the boxes so far accept less than P of the pixel's frames. It decides
**how many** ranges are used, never how wide one is.

**Range width W** (50–100 %, default 90) — a *local trimming quantile inside one
state*. Each accepted state's box is the central W of that state's own values,
per channel, so the sparse tails (a passing object, codec outliers) fall outside
it. It decides **how wide** each box is, never how many there are.

**Tolerance T** (0–32 RGB values, default 0) — dilates each finished box by T on
every channel, clamped to 0–255. W is *relative* to a state's spread, so a pixel
that barely varies gets almost no headroom from it and its ordinary sensor noise
reads as movement. T is the absolute headroom that fixes, and no quantile can
express it. See the run below: it is worth 24.0 % → 4.4 % of the frame.

Two tests pin the separation: changing W alone never changes how many states
were found, and changing P alone never changes a box.

P = W = 90 %, T = 0 reproduces the previous experiment's numbers exactly, so the
recorded runs stay comparable.

## How 1 / 2 / 3 ranges are found

1. **Raw values, never the display bucketing.** The derivation runs on the
   ungrouped 0–255 counts whatever the histogram's bucket width is set to.
2. **The channel that separates best.** Each channel gets an Otsu threshold and
   its separability η = σ²between / σ²total. The winner splits the **frames** in
   two. Ties break in R, G, B order rather than on float noise.
3. **A third state is a further split of the same channel**, applied to
   whichever of the two states then holds the most frames (on a tie the
   lower-valued one; if that one cannot be split, the other is tried). Every
   state is therefore a contiguous slice of that channel's sorted values, which
   is what makes recursion a window over one array rather than a fresh
   clustering — and what lets the backend do the same thing vectorized.
4. **Two candidate states are always produced, even when one range is allowed.**
   Capping at one range means "accept only the strongest state", not "treat the
   whole history as one state". Without this, the 1-range comparison would
   silently become a wide box over everything and stop being a comparison.
5. **Splitting frames, not channels.** Three independent per-channel splits
   would describe eight box corners, most of which the pixel never took.
6. States are ordered by frame count, most frequent first, and each is scored as
   it lands: the decision reads what the boxes **accept**, not how big the state
   is. Trimming drops frames and three per-channel intervals accept only their
   intersection, so a rule reading raw state size would call a request satisfied
   while the frames it promised were still rejected.

## What the whole-frame simulation actually computes

`POST /api/experiments/pixel-range-model`
(`backend/app/processing/background/pixel_ranges.py`).

- Samples `target_frames` frames spread over the whole video at `max_width`,
  using the same `scaled_size()` the single-frame route uses — so the model's
  grid is *identical* to the grid frames are later served at. A grid off by one
  row would compare every pixel against its neighbour's ranges.
- Runs the derivation above for every pixel, vectorized in numpy over row bands
  (the same banding pattern as `trimmed_stats.py`; pixels are independent along
  the time axis, so banding cannot change a bound — a test pins that).
- Returns, per range, **inclusive lower and upper bounds as two lossless PNGs**
  in the frame's grid. A range a pixel does not use is written as lower 255 /
  upper 0 — an empty box that accepts nothing, so the planes carry the per-pixel
  range count implicitly and nothing has to be kept in step with them. PNG and
  not JPEG because these are bounds, not pictures: ringing would move every box
  by a few values and the client would classify against something the backend
  never derived.

The browser decodes the planes once (`decodeImage`, unchanged) and then, per
frame, tests each pixel against its own boxes, first match wins — the same rule
the single-pixel path applies to its own frames. Accepted pixels are darkened to
8 % grayscale; rejected pixels have their luma mapped into
[`MOVEMENT_FLOOR`, 255] and all three channels shifted by the difference. The
lift is **additive, not a scale**, because scaling leaves black black — a dark
object crossing a dark floor is exactly the detection worth confirming.

Playback, prefetch and decode are the existing `useFramePlayback` /
`framePrefetch` / `imageData` lanes, unchanged.

### Cost

Sorting dominates: three sorts per pixel to pick the channel, one for the chosen
channel, and one per (range, channel) for the quantiles. Measured on the hall
clip at 360 × 240 / 240 frames: **2.5–2.8 s** per build, **1.2 MB** of planes.
That is why the build is an explicit button rather than something a slider
triggers. Classifying one frame afterwards is ~18 byte comparisons per pixel and
disappears into the playback clock.

Full source resolution is offered (720 px) but costs ~4× the model grid and
~4× the sorting.

## Runs

### 2026-08-13 — hala_orezena4.mp4 (720 × 480, 2721 frames)

#### Pixel (326, 227), all 2721 frames, P = 90 %, W = 90 %, T = 0

| ranges | accepted | R boxes |
| --- | --- | --- |
| 1 | 1762 / 2721 (64.8 %) | 185–197 |
| 2 | 2531 / 2721 (93.0 %) | 185–197 · 143–161 |
| 3 | 2528 / 2721 (92.9 %) | 185–190 · 192–197 · 143–161 |

Both known figures reproduce exactly. The new result is the third row: **a third
range does not help this pixel.** It does not find a new state — it subdivides
the bright state's noise at 190/192, and coverage actually *falls* by 3 frames
because value 191 is now in neither box. On this pixel two states are the whole
story, and the control says so rather than inventing a third.

#### Whole-frame model, 360 × 240, 240 frames (every 11th)

Moving = share of the frame rejected. Frame 2700 is well after the
crane/lighting change; frame 1000 is before it.

| P | W | T | ranges | samples accepted | px by ranges used | f300 | f1000 | f2000 | f2700 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 90 | 90 | 0 | 1 | 62.8 % | 86400 / 0 / 0 | 25.4 % | 22.9 % | 65.3 % | 65.6 % |
| 90 | 90 | 0 | 2 | 90.6 % | 1114 / 85286 / – | 5.8 % | 3.6 % | 17.9 % | 24.5 % |
| 90 | 90 | 0 | 3 | 92.3 % | 124 / 3701 / 82575 | 5.1 % | 1.6 % | 14.3 % | 24.0 % |
| 90 | 90 | 4 | 3 | 97.0 % | 42273 / 34323 / 9804 | 2.4 % | 1.1 % | 7.7 % | **4.4 %** |
| 90 | 90 | 8 | 3 | 98.5 % | 66768 / 14233 / 5399 | 1.3 % | 0.3 % | 4.9 % | 2.2 % |
| 90 | 98 | 0 | 3 | 98.1 % | 2472 / 17740 / 66188 | 2.1 % | 0.4 % | 3.7 % | 10.8 % |
| 60 | 90 | 4 | 3 | 86.8 % | 85026 / 1374 / 0 | 6.0 % | 4.2 % | 34.4 % | 31.4 % |

Four things to read off this:

- **One range fails at the whole-grid scale exactly as it failed on one pixel.**
  Two thirds of the frame reads as movement after the lighting change. This is
  the honest per-pixel version of "the floor stays grey", and it is the case for
  more than one range.
- **The second range is where the floor comes back** (65.6 % → 24.5 %); the
  third adds almost nothing on this clip (→ 24.0 %), matching what the single
  pixel showed.
- **Tolerance is what removes the residual speckle** (24.0 % → 4.4 % at T = 4,
  → 2.2 % at T = 8). Raising W instead is *not* equivalent: W = 98 % gets frame
  2000 down to 3.7 % but leaves frame 2700 at 10.8 %, because a quantile widens a
  state in proportion to how much it already varied. This is the measurement
  that justifies a separate absolute control.
- **T = 4 also collapses the range count**: 42273 pixels now need only one range
  where 82575 needed three. Much of what looked like a second or third state at
  T = 0 was the box being too tight to hold the pixel's own noise, not a genuine
  second state. Worth remembering before concluding that most of the hall is
  multi-state.

Working point on this clip: **P = 90, W = 90, T = 4, 3 ranges** — 97.0 % of all
(pixel, frame) samples accepted, and what is left highlighted is people and the
crane rather than floor.

## Parameters

- **Accepted signal** — 50–100 %, default 90.
- **Range width** — 50–100 %, default 90.
- **Tolerance** — 0–32, default 0 (so the previous runs reproduce; 4 is the
  measured working point here).
- **Ranges allowed** — 1 / 2 / 3, default 3.
- **Model grid** — 240 / 360 / 480 / 720 px wide, default 360.
- **Model frames** — 120 / 240 / 480, default 240.
- Bucket width (now **1** by default) still only affects how the histogram is
  drawn; it does not enter the derivation.

## Open questions

- **Does a third range ever earn itself?** Not on (326, 227), and barely on the
  grid. Either three states are rare in this clip or the recursion is splitting
  noise rather than states — η per state, not just for the first split, would
  settle it.
- **T is doing work that belongs to a noise model.** A fixed ±4 on every pixel
  is a stand-in for "how much does this pixel's sensor noise move it". The
  Background Variation deviation mask already measures something very close to
  that per pixel; deriving T from it would remove the knob.
- **Is the split temporal rather than distributional?** Still open from the
  previous two experiments. Range 2's frame span mixes the crane passes with the
  sustained post-change state, and the per-pixel model does not settle it
  either. A scene-change detector plus per-segment backgrounds remains the rival
  model for this video.
- **The model is sampled and downscaled.** 240 frames at 360 px is enough to see
  the answer but is not the answer at full resolution. Whether the boxes derived
  at 360 px are valid at 720 px is unmeasured, and INTER_AREA averaging makes a
  downscaled pixel's history strictly narrower than a source pixel's.
- **Nothing here generates a background yet.** The model is a per-pixel
  *classifier*. Turning it into a background means choosing a colour per pixel
  per range and deciding which range is current — which is the segment question
  again.
