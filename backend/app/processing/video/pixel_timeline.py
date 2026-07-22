"""Diagnostic: RGB values of one pixel across every frame of the video.

Purely for analysis — visualizing how a pixel behaves over time to inform
the design of outlier rejection for background extraction. No sampling:
every frame is read.
"""

from dataclasses import dataclass

from app.processing.video import store
from app.processing.video.sampling import NoCurrentVideoError, sample_frames


@dataclass
class PixelSample:
    frame_index: int
    timestamp_seconds: float
    r: int
    g: int
    b: int


@dataclass
class PixelTimeline:
    x: int
    y: int
    frame_count: int
    frames: list[PixelSample]


def run_pixel_timeline(x: int, y: int) -> PixelTimeline:
    record = store.load_current()
    if record is None:
        raise NoCurrentVideoError("No video uploaded yet.")

    width, height = record["width"], record["height"]
    if not (0 <= x < width and 0 <= y < height):
        raise ValueError(
            f"Pixel ({x}, {y}) is outside the frame bounds {width} × {height}."
        )

    path = store.current_video_path()
    if path is None:
        raise NoCurrentVideoError("No video uploaded yet.")

    fps = record["fps"]
    samples: list[PixelSample] = []
    for index, frame in enumerate(sample_frames(path)):
        blue, green, red = frame[y, x]
        samples.append(
            PixelSample(
                frame_index=index,
                timestamp_seconds=index / fps if fps > 0 else 0.0,
                r=int(red),
                g=int(green),
                b=int(blue),
            )
        )

    return PixelTimeline(x=x, y=y, frame_count=len(samples), frames=samples)
