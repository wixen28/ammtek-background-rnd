"""Read a single frame of the current video by index.

The movement visualization needs one arbitrary frame, not a sampled
sequence, so the frame is seeked directly instead of streamed from the
start (which is what ``sampling.py`` does for the whole-video passes).

Method-independent on purpose: the diagnostic compares a frame against
whatever background an experiment produced, so this knows nothing about
backgrounds.
"""

from dataclasses import dataclass
from pathlib import Path

import cv2
import numpy as np

from app.processing.video import store
from app.processing.video.inspect import VideoReadError
from app.processing.video.sampling import NoCurrentVideoError

# Enough for a visual diagnostic; keeps the frame payload small.
DEFAULT_MAX_WIDTH = 640


@dataclass
class FrameResult:
    frame_index: int
    frame_count: int
    width: int  # as returned, after any downscale
    height: int
    source_width: int  # as stored in the video
    source_height: int
    image: np.ndarray


def scaled_size(
    source_width: int, source_height: int, max_width: int | None
) -> tuple[int, int]:
    """The (width, height) a frame is served at for a given ``max_width``.

    Shared with the per-pixel range model, which has to be built on exactly
    the grid single frames are later requested at: the model holds one box
    per pixel, so a grid that differs by even one row would compare every
    pixel against its neighbour's ranges. Deriving both from this one
    function makes that agreement structural rather than a coincidence.
    """
    if max_width is None or source_width <= max_width:
        return source_width, source_height
    height = max(1, round(source_height * max_width / source_width))
    return max_width, height


def read_frame_at(path: Path, index: int) -> np.ndarray:
    """Return frame ``index`` of the video as a BGR ndarray.

    Seeks rather than scanning. Raises ValueError if the frame cannot be
    read, which includes indices past the end of the video.
    """
    if index < 0:
        raise ValueError("frame_index must be non-negative.")

    capture = cv2.VideoCapture(str(path))
    try:
        if not capture.isOpened():
            raise VideoReadError("File could not be opened as a video.")
        capture.set(cv2.CAP_PROP_POS_FRAMES, index)
        ok, frame = capture.read()
        if not ok:
            raise ValueError(f"Frame {index} could not be read from the video.")
        return frame
    finally:
        capture.release()


def read_current_frame(
    frame_index: int, max_width: int | None = DEFAULT_MAX_WIDTH
) -> FrameResult:
    """Read one frame of the current input video, optionally downscaled."""
    record = store.load_current()
    path = store.current_video_path()
    if record is None or path is None:
        raise NoCurrentVideoError("No video uploaded yet.")

    frame_count = record["frame_count"]
    if frame_index >= frame_count:
        raise ValueError(
            f"Frame {frame_index} is outside the video's {frame_count} frames."
        )

    image = read_frame_at(path, frame_index)
    source_height, source_width = image.shape[:2]

    target = scaled_size(source_width, source_height, max_width)
    if target != (source_width, source_height):
        image = cv2.resize(image, target, interpolation=cv2.INTER_AREA)

    height, width = image.shape[:2]
    return FrameResult(
        frame_index=frame_index,
        frame_count=frame_count,
        width=width,
        height=height,
        source_width=source_width,
        source_height=source_height,
        image=image,
    )
