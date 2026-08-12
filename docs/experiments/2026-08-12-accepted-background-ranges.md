# Accepted background ranges (diagnostic)

Follow-up to the pixel value histogram. That experiment established *what*
(326, 227) does — two genuinely separated stable states, bright
~(190, 200, 198) until the crane/lighting change and darker ~(159, 168, 171)
from ~frame 1750 to the end. This one draws a boundary around what counts as
background, makes the strength of that boundary adjustable by **frequency
rather than by colour distance**, and lets the choice be tested frame by frame.

Diagnostic only. Nothing here changes RGB Mean, RGB Median, outlier rejection,
movement classification or background generation.

## Where the numbers come from

Still no new endpoint and no backend change.
`GET /api/experiments/pixel-timeline?x=&y=` already returns every frame's
R/G/B for the selected pixel, and `GET /api/videos/current/frame` already
serves single frames. The ranges are derived in the browser
(`frontend/src/backgroundRanges.ts`) from the same timeline response the
histogram uses, so:

- selecting another pixel updates the timeline, the histogram, the markings
  and the range list together, from one request;
- moving the strength control is instant and costs no decode;
- the frame test reuses `useFramePlayback` / `framePrefetch` / `imageData`
  unchanged — the same prefetch-and-decode lanes and the same playback clock
  as the movement view.

## The control: accepted signal, not colour distance

One slider, **Accepted signal P** (50–100 %, default 90). It says *how much of
the selected pixel's own frame history the accepted ranges have to explain*.

Why not the existing RGB-distance threshold: a distance asks "how far from one
anchor colour may a pixel be", which cannot express a pixel that legitimately
has two separated states. The anchor lands between them and the tolerance has
to swallow both plus the empty gap. A frequency asks "how much of what this
pixel actually did counts as background", which is answerable for one state or
for two.

P drives both decisions, and only ever by frequency:

1. **How many ranges.** The strongest state is always accepted. A second is
   added only if the first range still leaves more than P of the frames
   rejected. Capped at two — deliberately not generalised to N states yet.
2. **How wide each range is.** Each accepted state is trimmed per channel to
   the central P of *its own* values, so the sparse tails (a passing object,
   codec outliers) fall outside the box. P = 100 % is the "accept everything
   this pixel ever was" baseline.

The decision in (1) reads what the boxes **accept**, not how big the state is.
The two differ a lot: trimming drops frames, and three per-channel intervals
accept only their intersection. Measured on (326, 227): the bright state holds
69 % of frames, but at P = 50 % its trimmed box accepts only 28.6 % of the
video. A rule reading the raw state size would have called a 50 % request
satisfied while more than two thirds of the frames were still rejected. A test
pins this.

Because of the intersection, the achieved coverage always trails the request
somewhat (P = 90 % → 93 % here, P = 60 % → 53.5 %). It is measured and shown
next to the request rather than assumed.

## How the two ranges are found

1. **Raw values, never the display bucketing.** The derivation runs on the
   ungrouped 0–255 counts whatever the histogram's bucket width is set to, so
   the marked boundaries do not move when the bucketing is changed for
   reading.
2. **One Otsu split, on the channel that separates best.** Each channel gets a
   threshold maximising between-class variance, reported with its
   *separability* η = σ²between / σ²total (0–1). The channel with the highest η
   splits the **frames** into two groups. Ties break in R, G, B order rather
   than on float noise, so a pixel always reports the same split.
3. **Splitting frames, not channels.** Three independent per-channel splits
   would describe eight box corners, most of which the pixel never took.
   Splitting the frames keeps each box a colour the pixel actually had.
4. **Each accepted group becomes an axis-aligned RGB box** from its
   central-P per-channel quantiles, plus its per-channel median as the swatch
   and its first/last frame index.
5. Frames are classified against the finished boxes, first match wins — the
   same rule `acceptingRangeIndex` applies in the frame test, so the strip and
   the frame view can never disagree.

η is worth reading: near 1 means two genuinely distinct states, near 0 means
one spread-out state that was split only to reach the requested coverage. The
split is always attempted, so "2 ranges" alone does not mean "2 states" — η and
the range bounds do.

## What the markings mean

In the per-channel histogram panels, each accepted range is a shaded band over
the bars: the interval of that channel currently accepted as background.
Range 1 has solid edges, range 2 dashed, and the rank is labelled on the red
panel only. Neutral ink, not a series colour — a hue there would read as "this
channel". A bar inside a band is a value that counts as background; a bar
outside one is a value that would be rejected.

Bounds are inclusive, so a band ends at the far edge of its last value.

## The frame test, and what it is not

Under the histogram: a frame scrubber, Play/Pause, and the selected pixel's
ranges applied to every pixel of the frame — accepted pixels keep their colour,
rejected ones are dimmed to 8 % grayscale (the same dimming the movement view
gives its background).

**This is not a per-pixel background mask.** The ranges describe *one* pixel's
history, so the frame view answers "where else in the frame does this pixel's
accepted background colour hold, and how does the lighting change move it". A
real per-pixel verdict needs per-pixel ranges for the whole grid — see Open
questions.

The exact part is the **acceptance strip**: accepted vs rejected for every
analyzed frame of the selected pixel at once, computed from the timeline with
no decoding at all. That is what actually answers "do these settings survive
the lighting change" — a sustained rejected band at the end of the video is the
failure, and it is visible without scrubbing to it.

A **Ranges allowed 1 / 2** control caps the count, which is the comparison that
justifies the second range.

## Parameters

- **Accepted signal** — 50–100 %, default 90.
- **Ranges allowed** — 1 or 2, default 2.
- Bucket width still only affects how the histogram is *drawn*; it does not
  enter the derivation.

## Runs

### 2026-08-12 — hala_orezena4.mp4 (720×480, 2721 frames), pixel (326, 227)

All 2721 frames, split on **R at 172, η = 0.585**. The strongest state holds
69 % of frames (spanning 0–1953), the second 31 % (spanning 258–2720 — that
span includes the two crane passes, so it is not the lighting-change
timestamp).

| P | ranges | achieved | range 1 (R) | range 2 (R) | longest rejected run |
| --- | --- | --- | --- | --- | --- |
| 50 % | 2 | 42.1 % | 189–194 | 158–161 | 600–873 |
| 60 % | 2 | 53.5 % | 189–194 | 158–161 | 1254–1522 |
| 70 % | 2 | 72.3 % | 187–195 | 157–161 | 1387–1518 |
| 80 % | 2 | 76.9 % | 186–196 | 153–161 | 694–822 |
| 90 % | 2 | 93.0 % | 185–197 | 143–161 | 1819–1848 |
| 95 % | 2 | 95.3 % | 185–197 | 30–162 | 1827–1846 |
| 100 % | 2 | 100 % | 175–203 | 0–172 | none |

Capped at **one** range, same pixel:

| P | achieved | longest rejected run |
| --- | --- | --- |
| 70 % | 46.9 % | 1950–2720 |
| 90 % | 64.8 % | 1950–2720 |
| 100 % | 68.7 % | 1954–2720 |

Two things to read off this:

- **One range cannot cover this pixel at any strength.** Even at P = 100 %,
  where the box spans the bright state's entire observed spread, frames
  1954–2720 are rejected in one solid block. That is the tail the histogram
  experiment identified, and it is the whole case for a second range.
- **High P is not "better", it is looser.** From P = 95 % range 2 opens to
  R 30–162 and at 100 % to R 0–172: the dark group contains both the darker
  floor state *and* the near-black crane-occlusion frames, and covering 100 %
  of frames with two boxes is only possible by swallowing the occlusions. The
  box then accepts almost anything dark. P = 90 % (93 % achieved, boxes still
  ~R 143–161) is the honest working point on this pixel.

## Open questions

- **Per-pixel ranges.** The natural next step, and the one that would turn the
  frame test into a real background/foreground decision: derive ranges for
  every pixel, not just the selected one. That needs per-pixel value
  distributions over the whole video — at 720×480 that is ~345 k × 3 × 256
  bins, ~0.5 GB at uint16, plus a full decode pass — and the strength control
  would stop being interactive unless several P values are precomputed in the
  one pass (the way RGB Mean already returns one background per rejection
  threshold). Worth sizing before building.
- **Is the split temporal rather than distributional?** Range 2's frame span
  (258–2720) mixes the crane passes with the sustained post-change state. A
  global scene-change detector plus per-segment backgrounds may be the more
  honest model for this video than per-pixel colour modes — the previous
  experiment's open question, still open, and this run does not settle it.
- **How many pixels are two-state at all?** If it is a small minority, this is
  a per-pixel repair problem; if it is most of the floor, it is a
  segment-the-video problem.
- **Does η correlate with the Background Variation deviation mask?** Both claim
  to find the same unstable pixels, from different directions.
- Three states are absorbed, not dropped: with the cap at two, the third state
  shares a box with whichever group it was split into, and that box spans the
  gap between them. A test documents this. Relevant before generalising to N.
