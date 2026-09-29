"""
ml/m1/make_mock_images.py

Generates a handful of static reference stills for camera CCTV-04, standing
in for real CCTV frames until an actual feed is wired up (see the M1 task
description: "since real CCTV feeds aren't available yet, build this
against static reference images or a short mock video").

Each image shows a simplified gauge post at the calibrated search column
(x=320, matching ml/m1/calibration/CCTV-04.json) with a visible brightness
step at the waterline — bright/dry post above, darker/wet water texture
below — which is exactly the kind of edge estimate_level.py's simple
reference-marker + edge-detection approach is meant to pick up.

This script has no bearing on the M1 estimation logic itself; it only
produces fixtures so the rest of the pipeline (estimate_level.py, the
ingest service, the /api/m1/latest route, the dashboard card) can be
exercised end-to-end without a real camera. Re-run any time to regenerate.

Usage:
    python ml/m1/make_mock_images.py
"""

import numpy as np
from PIL import Image
from pathlib import Path

OUT_DIR = Path(__file__).resolve().parent / "mock_images"
WIDTH, HEIGHT = 640, 480
POST_X0, POST_X1 = 300, 340  # matches search_column_px=320 in the calibration
RNG = np.random.default_rng(42)

# Three snapshots of a rising river, named for a simulated ingest sequence.
# waterline_px is the row where "wet" begins; lower pixel row = higher water
# (matches the calibration's pixel_y-decreases-as-level-rises convention).
SCENES = [
    {"name": "mock_t0_low.png", "waterline_px": 380},
    {"name": "mock_t1_mid.png", "waterline_px": 300},
    {"name": "mock_t2_high.png", "waterline_px": 215},
]


def make_scene(waterline_px):
    # Background: overcast sky / riverbank gradient, nothing near the post
    # column that would create a competing edge.
    bg = np.tile(np.linspace(60, 90, HEIGHT, dtype=np.uint8).reshape(-1, 1), (1, WIDTH))
    img = np.stack([bg, bg, bg + 10], axis=-1).astype(np.float32)

    # The gauge post: a light, mildly noisy vertical strip. Above the
    # waterline it stays dry/light; below it darkens to represent the wet,
    # partially-submerged section.
    post_noise = RNG.normal(0, 3, size=(HEIGHT, POST_X1 - POST_X0))
    dry_level = 205.0
    wet_level = 70.0
    for y in range(HEIGHT):
        base = dry_level if y < waterline_px else wet_level
        # Small transition band so the edge isn't a single infinitely sharp
        # pixel (closer to what a real camera + compression would produce).
        if abs(y - waterline_px) <= 2:
            base = (dry_level + wet_level) / 2
        row = base + post_noise[y]
        img[y, POST_X0:POST_X1, 0] = row
        img[y, POST_X0:POST_X1, 1] = row
        img[y, POST_X0:POST_X1, 2] = row * 0.95

    # A couple of static tick marks so the frame reads as "a gauge post"
    # to a human reviewer. Purely cosmetic — not used by the detector.
    for tick_y in (120, 260, 400):
        img[tick_y - 1:tick_y + 1, POST_X0 - 10:POST_X0, :] = 220

    # General sensor noise across the whole frame.
    img += RNG.normal(0, 2.5, size=img.shape)
    img = np.clip(img, 0, 255).astype(np.uint8)
    return Image.fromarray(img, mode="RGB")


def main():
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    for scene in SCENES:
        im = make_scene(scene["waterline_px"])
        path = OUT_DIR / scene["name"]
        im.save(path)
        print(f"wrote {path} (waterline_px={scene['waterline_px']})")


if __name__ == "__main__":
    main()
