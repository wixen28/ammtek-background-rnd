from dataclasses import asdict

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, Field, PositiveInt

from app.api.encoding import to_data_url
from app.processing.background.rgb_mean import (
    DEFAULT_REJECTION_THRESHOLD,
    METHOD,
    run_rgb_mean,
)
from app.processing.video.pixel_timeline import run_pixel_timeline
from app.processing.video.sampling import NoCurrentVideoError

router = APIRouter(tags=["experiments"])


class RgbMeanRequest(BaseModel):
    use_all_frames: bool = True
    target_frames: int = Field(default=30, ge=1)
    resize: tuple[PositiveInt, PositiveInt] | None = None
    rejection_threshold: float = Field(default=DEFAULT_REJECTION_THRESHOLD, ge=0)


@router.post("/experiments/rgb-mean")
def rgb_mean(request: RgbMeanRequest) -> dict:
    try:
        result = run_rgb_mean(
            target_frames=request.target_frames,
            resize=request.resize,
            use_all_frames=request.use_all_frames,
            rejection_threshold=request.rejection_threshold,
        )
    except NoCurrentVideoError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc

    return {
        "use_all_frames": result.use_all_frames,
        "target_frames": result.target_frames,
        "every_n": result.every_n,
        "sampled_frames": result.sampled_frames,
        "resize": result.resize,
        "rejection_threshold": result.rejection_threshold,
        "rejected_fraction": result.rejected_fraction,
        "fallback_pixels": result.fallback_pixels,
        "method": METHOD,
        "processing_time_seconds": result.processing_time_seconds,
        "background": to_data_url(result.background, ".png"),
        "previews": [to_data_url(p, ".jpg") for p in result.previews],
    }


@router.get("/experiments/pixel-timeline")
def pixel_timeline(x: int = Query(ge=0), y: int = Query(ge=0)) -> dict:
    try:
        result = run_pixel_timeline(x, y)
    except NoCurrentVideoError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc

    return {
        "x": result.x,
        "y": result.y,
        "frame_count": result.frame_count,
        "frames": [asdict(sample) for sample in result.frames],
    }
