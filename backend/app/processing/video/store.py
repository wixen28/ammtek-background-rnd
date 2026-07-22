"""File-based store for the current working input video.

Holds at most one video at a time: uploading a new one replaces the
previous. The video file is stored as ``<video_id><suffix>`` alongside a
``metadata.json`` holding the public record. No database — this is an
R&D tool.
"""

import json
import shutil
import uuid
from pathlib import Path

from app.processing.video.inspect import inspect_video

VIDEOS_DIR = Path(__file__).resolve().parents[3] / "data" / "videos"

_METADATA_FILE = "metadata.json"


def save_video(source: Path, filename: str, root: Path | None = None) -> dict:
    """Validate ``source`` as a video and make it the current input.

    Raises VideoReadError if the file is not a readable video; the store
    is left unchanged in that case. On success ``source`` is moved into
    the store and the public metadata record is returned.
    """
    root = root or VIDEOS_DIR
    metadata = inspect_video(source)

    video_id = uuid.uuid4().hex
    record = {
        "video_id": video_id,
        "filename": filename,
        "width": metadata.width,
        "height": metadata.height,
        "fps": metadata.fps,
        "frame_count": metadata.frame_count,
        "duration_seconds": metadata.duration_seconds,
    }

    if root.exists():
        shutil.rmtree(root)
    root.mkdir(parents=True)

    shutil.move(str(source), root / f"{video_id}{Path(filename).suffix}")
    (root / _METADATA_FILE).write_text(json.dumps(record, indent=2))

    return record


def load_current(root: Path | None = None) -> dict | None:
    """Return the current video's record, or None if no video is stored."""
    root = root or VIDEOS_DIR
    metadata_path = root / _METADATA_FILE
    if not metadata_path.exists():
        return None
    return json.loads(metadata_path.read_text())


def current_video_path(root: Path | None = None) -> Path | None:
    """Return the stored video file's path, for use by experiment code."""
    root = root or VIDEOS_DIR
    record = load_current(root)
    if record is None:
        return None
    matches = list(root.glob(f"{record['video_id']}*"))
    return matches[0] if matches else None
