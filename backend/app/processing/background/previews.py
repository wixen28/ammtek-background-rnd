"""Shared sampled-frame preview thumbnails for background experiments."""

import cv2
import numpy as np

PREVIEW_MAX = 6
PREVIEW_WIDTH = 160


def thumbnail(frame: np.ndarray) -> np.ndarray:
    height = max(1, round(frame.shape[0] * PREVIEW_WIDTH / frame.shape[1]))
    return cv2.resize(frame, (PREVIEW_WIDTH, height), interpolation=cv2.INTER_AREA)
