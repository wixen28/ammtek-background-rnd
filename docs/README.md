# R&D documentation

Notes for the ammtek background-extraction proof of concept.

## Purpose

Compare methods of extracting a static background from video and generating
a foreground mask. Implemented so far: RGB mean with outlier rejection, RGB
median over sampled frames, and background variation (how much variation
survives outlier rejection). Candidate directions (not yet implemented):
depth-estimation-based separation, object-detection (e.g. YOLO) assisted
masking.

## Conventions

- One file per experiment in `experiments/`, named
  `YYYY-MM-DD-short-title.md`.
- Record: method, input video (filename in `../ammtek-rnd-videos/`),
  parameters, runtime, qualitative observations, and open questions.
- Do not commit videos or generated outputs; reference them by filename
  only.
