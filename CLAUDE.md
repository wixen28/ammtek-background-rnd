# ammtek-background-rnd

Isolated R&D proof of concept: extract a static background from video and
generate a foreground mask. One Git repo, two apps, no production concerns.

## Layout

- `frontend/` — React + Vite + TypeScript. Dev server on port 5173.
- `backend/` — Python 3.11+, FastAPI, OpenCV, NumPy. Served on port 8000.
- `docs/` — R&D notes; one file per experiment in `docs/experiments/`.

## Rules

- Test videos live outside the repo in `../ammtek-rnd-videos/`. Never copy
  video files or generated outputs (backgrounds, masks, frames) into the
  repo or commit them.
- Keep API routes (`backend/app/api/`) separate from processing logic
  (`backend/app/processing/`). Routes stay thin; algorithms live in
  `processing/video/`, `processing/background/`, `processing/masking/`.
- No authentication, database, Docker, or deployment setup — this is a
  local-only PoC.
- Document each experiment (method, parameters, observations) in
  `docs/experiments/`.

## Commands

- Backend venv (once): `cd backend && uv venv --python 3.12 .venv`
- Backend deps: `cd backend && uv pip install --python .venv/bin/python -e ".[dev]"`
- Backend dev server: `cd backend && .venv/bin/uvicorn app.main:app --reload --port 8000`
- Backend tests: `cd backend && .venv/bin/python -m pytest`
- Frontend dev server: `cd frontend && npm run dev`
- Frontend build/typecheck: `cd frontend && npm run build`

## Machine-specific notes

- Vite is pinned to v6 because the machine runs Node 20.17 (Vite 7+
  requires Node 20.19+).
- Use uv for the backend Python. The Homebrew python@3.12 bottle is broken
  on this machine (pyexpat references a libexpat symbol missing from the
  system dylib, which breaks ensurepip/pip); uv's self-contained CPython
  builds avoid it.
