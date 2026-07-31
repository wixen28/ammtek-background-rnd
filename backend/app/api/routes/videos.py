import shutil
import tempfile
from pathlib import Path

from fastapi import APIRouter, HTTPException, Query, UploadFile

from app.api.encoding import to_data_url
from app.processing.video import frames, store
from app.processing.video.inspect import VideoReadError
from app.processing.video.sampling import NoCurrentVideoError

router = APIRouter(tags=["videos"])


@router.post("/videos")
def upload_video(file: UploadFile) -> dict:
    # OpenCV only reads from disk, so spool the upload to a temp file; keep
    # the original extension as a container-format hint for the decoder.
    suffix = Path(file.filename or "").suffix
    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
        tmp_path = Path(tmp.name)
        shutil.copyfileobj(file.file, tmp)

    try:
        return store.save_video(tmp_path, filename=file.filename or "upload")
    except VideoReadError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    finally:
        # No-op on success (save_video moves the file into the store).
        tmp_path.unlink(missing_ok=True)


@router.get("/videos/current")
def current_video() -> dict:
    record = store.load_current()
    if record is None:
        raise HTTPException(status_code=404, detail="No video uploaded yet.")
    return record


@router.get("/videos/current/frame")
def current_video_frame(
    frame_index: int = Query(0, ge=0),
    max_width: int = Query(frames.DEFAULT_MAX_WIDTH, ge=1),
) -> dict:
    """One frame of the current video, for client-side diagnostics."""
    try:
        result = frames.read_current_frame(frame_index, max_width=max_width)
    except NoCurrentVideoError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc

    return {
        "frame_index": result.frame_index,
        "frame_count": result.frame_count,
        "width": result.width,
        "height": result.height,
        "source_width": result.source_width,
        "source_height": result.source_height,
        # Lossless: the frame is differenced against a lossless background,
        # so codec artifacts would read as movement at low thresholds.
        "frame": to_data_url(result.image, ".png"),
    }
