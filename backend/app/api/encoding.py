"""Encode ndarray images as data URLs for JSON responses.

An R&D-sized convenience: images ride inside the JSON payload, so no
output files are written and no static file serving is needed.
"""

import base64

import cv2
import numpy as np

_MIME = {".png": "image/png", ".jpg": "image/jpeg"}


def to_data_url(image: np.ndarray, ext: str = ".png") -> str:
    ok, buffer = cv2.imencode(ext, image)
    if not ok:
        raise ValueError(f"Failed to encode image as {ext}.")
    return f"data:{_MIME[ext]};base64,{base64.b64encode(buffer).decode('ascii')}"
