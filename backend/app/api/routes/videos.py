import shutil
import tempfile
from pathlib import Path

from fastapi import APIRouter, HTTPException, UploadFile

from app.processing.video import store
from app.processing.video.inspect import VideoReadError

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
