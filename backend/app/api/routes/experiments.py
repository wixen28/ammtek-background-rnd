from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field, PositiveInt

from app.api.encoding import to_data_url
from app.processing.background.rgb_mean import run_rgb_mean
from app.processing.video.sampling import NoCurrentVideoError

router = APIRouter(tags=["experiments"])


class RgbMeanRequest(BaseModel):
    target_frames: int = Field(default=30, ge=1)
    resize: tuple[PositiveInt, PositiveInt] | None = None


@router.post("/experiments/rgb-mean")
def rgb_mean(request: RgbMeanRequest) -> dict:
    try:
        result = run_rgb_mean(
            target_frames=request.target_frames, resize=request.resize
        )
    except NoCurrentVideoError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc

    return {
        "target_frames": result.target_frames,
        "every_n": result.every_n,
        "sampled_frames": result.sampled_frames,
        "resize": result.resize,
        "processing_time_seconds": result.processing_time_seconds,
        "background": to_data_url(result.background, ".png"),
        "previews": [to_data_url(p, ".jpg") for p in result.previews],
    }
