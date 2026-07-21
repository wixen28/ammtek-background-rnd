# ammtek-background-rnd

Isolated R&D proof-of-concept for experimenting with methods of extracting a
static background from video and generating a foreground mask.

This repository is **not** a production codebase: no authentication, no
database, no Docker, no deployment. Everything runs locally.

## Structure

```
frontend/   React + Vite + TypeScript UI (sidebar + content layout)
backend/    Python 3.11+ / FastAPI / OpenCV / NumPy API and processing code
docs/       R&D notes and experiment documentation
```

Inside the backend, API routes (`backend/app/api/`) are kept separate from
video-processing logic (`backend/app/processing/`).

## Test videos

Test videos live **outside the repository** in `../ammtek-rnd-videos/`.
Video files and generated outputs (backgrounds, masks) must never be
committed — the `.gitignore` blocks common video/output patterns as a
safety net.

## Prerequisites

- Node.js 20+
- pnpm
- Python 3.11+

## Backend — run locally

```bash
cd backend
uv venv --python 3.12 .venv
uv pip install --python .venv/bin/python -e ".[dev]"
.venv/bin/uvicorn app.main:app --reload --port 8000
```

Health check: <http://localhost:8000/api/health>

Run tests:

```bash
cd backend
.venv/bin/python -m pytest
```

## Frontend — run locally

```bash
cd frontend
pnpm install
pnpm dev
```

Open <http://localhost:5173>. The sidebar footer shows whether the backend
is reachable.

## Documentation

Experiment notes go in `docs/` — see `docs/README.md`.
