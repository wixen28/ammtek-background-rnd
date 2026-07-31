from dataclasses import asdict
from typing import Annotated

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, Field, PositiveInt

from app.api.encoding import to_data_url
from app.processing.background import rgb_mean, rgb_median, variation
from app.processing.video.pixel_timeline import run_pixel_timeline
from app.processing.video.sampling import NoCurrentVideoError

router = APIRouter(tags=["experiments"])


class RgbMeanRequest(BaseModel):
    use_all_frames: bool = True
    target_frames: int = Field(default=30, ge=1)
    resize: tuple[PositiveInt, PositiveInt] | None = None
    # One background is produced per threshold, from a single decode pass.
    rejection_thresholds: list[Annotated[float, Field(ge=0)]] = Field(
        default=list(rgb_mean.DEFAULT_REJECTION_THRESHOLDS),
        min_length=1,
        max_length=rgb_mean.MAX_REJECTION_THRESHOLDS,
    )


@router.post("/experiments/rgb-mean")
def run_rgb_mean_experiment(request: RgbMeanRequest) -> dict:
    try:
        result = rgb_mean.run_rgb_mean(
            target_frames=request.target_frames,
            resize=request.resize,
            use_all_frames=request.use_all_frames,
            rejection_thresholds=request.rejection_thresholds,
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
        "method": rgb_mean.METHOD,
        "processing_time_seconds": result.processing_time_seconds,
        "previews": [to_data_url(p, ".jpg") for p in result.previews],
        "variants": [
            {
                "rejection_threshold": variant.rejection_threshold,
                "rejected_fraction": variant.rejected_fraction,
                "fallback_pixels": variant.fallback_pixels,
                "background": to_data_url(variant.background, ".png"),
            }
            for variant in result.variants
        ],
    }


class RgbMedianRequest(BaseModel):
    use_all_frames: bool = True
    target_frames: int = Field(default=30, ge=1)
    resize: tuple[PositiveInt, PositiveInt] | None = None


@router.post("/experiments/rgb-median")
def run_rgb_median_experiment(request: RgbMedianRequest) -> dict:
    try:
        result = rgb_median.run_rgb_median(
            target_frames=request.target_frames,
            resize=request.resize,
            use_all_frames=request.use_all_frames,
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
        "method": rgb_median.METHOD,
        "processing_time_seconds": result.processing_time_seconds,
        "background": to_data_url(result.background, ".png"),
        "previews": [to_data_url(p, ".jpg") for p in result.previews],
    }


class BackgroundVariationRequest(BaseModel):
    use_all_frames: bool = True
    target_frames: int = Field(default=30, ge=1)
    resize: tuple[PositiveInt, PositiveInt] | None = None
    # No upper bound: >= 442 exceeds the largest possible RGB distance and so
    # disables rejection, which is a meaningful baseline to compare against.
    rejection_threshold: float = Field(
        default=variation.DEFAULT_REJECTION_THRESHOLD, ge=0
    )


@router.post("/experiments/background-variation")
def run_background_variation_experiment(request: BackgroundVariationRequest) -> dict:
    try:
        result = variation.run_background_variation(
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
        "method": variation.METHOD,
        "processing_time_seconds": result.processing_time_seconds,
        "rejection_threshold": result.rejection_threshold,
        "rejected_fraction": result.rejected_fraction,
        "fallback_pixels": result.fallback_pixels,
        "deviation_min": result.deviation_min,
        "deviation_max": result.deviation_max,
        "background": to_data_url(result.background, ".png"),
        # Lossless and single channel: the mask is a measurement, and JPEG
        # ringing around edges would read as variation that is not there.
        "variation_mask": to_data_url(result.variation_mask, ".png"),
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
