from pathlib import Path

import cv2
import numpy as np

WIDTH, HEIGHT, FPS = 64, 48, 10.0


def make_video(
    path: Path,
    frames: int = 20,
    width: int = WIDTH,
    height: int = HEIGHT,
    fps: float = FPS,
) -> Path:
    """Write a synthetic test video; frame i is filled with value i * 5.

    The per-frame fill value lets tests verify *which* frames were sampled
    (MJPG is lossy, so compare with a small tolerance).
    """
    writer = cv2.VideoWriter(
        str(path), cv2.VideoWriter_fourcc(*"MJPG"), fps, (width, height)
    )
    assert writer.isOpened()
    for i in range(frames):
        frame = np.full((height, width, 3), i * 5 % 256, dtype=np.uint8)
        writer.write(frame)
    writer.release()
    return path
