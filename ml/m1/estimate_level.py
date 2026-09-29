"""
ml/m1/estimate_level.py

============================================================================
 PHASE M1 — WATER-LEVEL VISION MODULE (PROTOTYPE, NOT A VALIDATED GAUGE)
============================================================================
Given one image and a per-camera calibration config (see
ml/m1/calibration/FORMAT.md), estimates a waterline level in metres.

This is deliberately the simplest thing that could work for an MVP, per the
task spec: "fixed reference markers + edge detection is fine for MVP — no
need for a trained CV model yet." There is no object detection, no water
segmentation, no lens/perspective correction, and no learning of any kind.
It is a manual pixel ruler:

  1. A human calibrates two (pixel_row, real_elevation_m) points per camera.
  2. This script scans a narrow vertical strip of one frame for the
     strongest brightness step (an edge) within a configured search band.
  3. That edge's pixel row is linearly mapped to metres using the two
     calibration points.

CALIBRATION-BASED PROTOTYPE — NOT A VALIDATED CV GAUGE. Do not treat
level_m as ground truth. It has no mechanism to tell a real waterline apart
from a shadow, reflection, dirt line, or a person standing at the post — it
just finds the strongest edge in the configured search band and trusts the
calibration. vision_confidence is a rough, self-reported signal (edge
prominence + how close the edge sits to the search band's boundary), not a
calibrated probability. See ml/m1/README.md.

CLI usage:
    python ml/m1/estimate_level.py --image path/to/frame.png \
        --calibration ml/m1/calibration/CCTV-04.json

Or, matching the M3 script's convention (see ml/scripts/predict_m3.py),
JSON on stdin:
    echo '{"image_path": "...", "calibration_path": "..."}' \
        | python ml/m1/estimate_level.py

Always prints one line of JSON to stdout and exits 0 on success. On failure
it prints a message to stderr and exits 1 — callers (e.g.
services/m1Ingest.js) should treat any non-zero exit as "no estimate this
cycle," never as a silent zero/blank reading.
"""

import argparse
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
from PIL import Image

METHOD = "reference_marker_edge_detection_v0"


class EstimationError(Exception):
    pass


def load_calibration(calibration_path):
    path = Path(calibration_path)
    if not path.is_file():
        raise EstimationError(f"Calibration file not found: {calibration_path}")
    try:
        config = json.loads(path.read_text())
    except json.JSONDecodeError as exc:
        raise EstimationError(f"Calibration file is not valid JSON: {exc}") from exc

    required = ["camera_id", "location_id", "search_column_px", "search_band_px", "reference_points"]
    missing = [key for key in required if key not in config]
    if missing:
        raise EstimationError(f"Calibration file is missing required fields: {', '.join(missing)}")

    points = config["reference_points"]
    if not isinstance(points, list) or len(points) != 2:
        raise EstimationError("reference_points must contain exactly two entries.")
    for p in points:
        if "pixel_y" not in p or "elevation_m" not in p:
            raise EstimationError("Each reference_point needs pixel_y and elevation_m.")
    if points[0]["pixel_y"] == points[1]["pixel_y"]:
        raise EstimationError("reference_points must have two distinct pixel_y values.")
    if points[0]["elevation_m"] == points[1]["elevation_m"]:
        raise EstimationError("reference_points must have two distinct elevation_m values.")

    band = config["search_band_px"]
    if "top" not in band or "bottom" not in band or band["top"] >= band["bottom"]:
        raise EstimationError("search_band_px must have top < bottom.")

    config.setdefault("strip_width_px", 5)
    config.setdefault("smoothing_px", 5)
    return config


def load_grayscale(image_path):
    path = Path(image_path)
    if not path.is_file():
        raise EstimationError(f"Image file not found: {image_path}")
    try:
        image = Image.open(path).convert("L")
    except Exception as exc:  # noqa: BLE001 - surfacing any Pillow failure the same way
        raise EstimationError(f"Could not read image: {exc}") from exc
    return np.asarray(image, dtype=np.float64)


def smooth(profile, window):
    if window <= 1:
        return profile
    kernel = np.ones(window) / window
    # 'same' keeps the array length stable; edge effects are acceptable
    # here because the search band is required to be well inside the frame.
    return np.convolve(profile, kernel, mode="same")


def pixel_to_metres(pixel_y, reference_points):
    (p1, e1), (p2, e2) = (
        (reference_points[0]["pixel_y"], reference_points[0]["elevation_m"]),
        (reference_points[1]["pixel_y"], reference_points[1]["elevation_m"]),
    )
    slope = (e2 - e1) / (p2 - p1)
    return e1 + slope * (pixel_y - p1)


def detect_waterline(gray, config):
    height, width = gray.shape
    strip_half = max(1, config["strip_width_px"] // 2)
    col = config["search_column_px"]
    if not (0 <= col < width):
        raise EstimationError(f"search_column_px ({col}) is outside the image width ({width}).")

    col_lo = max(0, col - strip_half)
    col_hi = min(width, col + strip_half + 1)
    strip = gray[:, col_lo:col_hi].mean(axis=1)  # 1D intensity profile, top-to-bottom

    band_top_cfg = config["search_band_px"]["top"]
    band_bottom_cfg = config["search_band_px"]["bottom"]
    band_top = max(0, min(band_top_cfg, height - 2))
    band_bottom = max(band_top + 1, min(band_bottom_cfg, height - 1))
    band_clamped = (band_top != band_top_cfg) or (band_bottom != band_bottom_cfg)

    smoothed = smooth(strip, config["smoothing_px"])

    band_slice = smoothed[band_top:band_bottom + 1]
    if band_slice.size < 3:
        raise EstimationError("search_band_px is too narrow to detect an edge.")

    gradient = np.abs(np.diff(band_slice))  # gradient[i] is the edge strength between row i and i+1
    if gradient.size == 0 or not np.isfinite(gradient).any():
        raise EstimationError("Could not compute an intensity gradient for this frame.")

    peak_index = int(np.argmax(gradient))
    waterline_pixel_y = band_top + peak_index  # row just above the strongest step

    peak_strength = float(gradient[peak_index])
    mean_strength = float(np.mean(gradient))
    std_strength = float(np.std(gradient))

    return {
        "waterline_pixel_y": waterline_pixel_y,
        "peak_strength": peak_strength,
        "mean_strength": mean_strength,
        "std_strength": std_strength,
        "band_top": band_top,
        "band_bottom": band_bottom,
        "band_clamped": band_clamped,
        "band_size": band_slice.size,
    }


def estimate_confidence(detection):
    peak = detection["peak_strength"]
    mean = detection["mean_strength"]
    std = detection["std_strength"]

    if peak <= 0:
        return 0.0

    # Peak prominence as a z-score-ish measure: how far the strongest edge
    # stands out above the noise floor of the rest of the search band.
    # A flat, featureless strip (no real edge) scores near zero; a single
    # sharp step against a low-variance background scores high.
    prominence = (peak - mean) / (std + 1e-6)
    confidence = np.clip(prominence / 4.0, 0.0, 1.0)

    # An edge sitting right at the search band's boundary is likely
    # truncated (the real edge could be just outside the configured band),
    # so treat it as less trustworthy.
    edge_margin = min(
        detection["waterline_pixel_y"] - detection["band_top"],
        detection["band_bottom"] - detection["waterline_pixel_y"],
    )
    if edge_margin <= 3:
        confidence *= 0.5

    if detection["band_clamped"]:
        confidence *= 0.7

    return round(float(np.clip(confidence, 0.0, 1.0)), 3)


def estimate_level(image_path, calibration_path):
    config = load_calibration(calibration_path)
    gray = load_grayscale(image_path)
    detection = detect_waterline(gray, config)
    level_m = pixel_to_metres(detection["waterline_pixel_y"], config["reference_points"])
    confidence = estimate_confidence(detection)

    return {
        "level_m": round(float(level_m), 3),
        "vision_confidence": confidence,
        "waterline_pixel_y": detection["waterline_pixel_y"],
        "calibration_id": config.get("calibration_id"),
        "camera_id": config["camera_id"],
        "location_id": config["location_id"],
        "units": config.get("units", "m"),
        "method": METHOD,
        "prototype": True,
        "disclaimer": "Calibration-based prototype estimate — not a validated computer-vision gauge.",
        "generated_at": datetime.now(timezone.utc).isoformat(),
    }


def _read_payload_from_stdin():
    raw = sys.stdin.read()
    if not raw.strip():
        return None
    try:
        payload = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise EstimationError(f"stdin was not valid JSON: {exc}") from exc
    if not isinstance(payload, dict):
        raise EstimationError("stdin JSON must be an object with image_path and calibration_path.")
    return payload


def main():
    parser = argparse.ArgumentParser(description="Estimate a waterline level from one calibrated camera frame.")
    parser.add_argument("--image", help="Path to the image to analyze.")
    parser.add_argument("--calibration", help="Path to the camera's calibration JSON config.")
    args = parser.parse_args()

    image_path = args.image
    calibration_path = args.calibration

    if not image_path or not calibration_path:
        payload = _read_payload_from_stdin() or {}
        image_path = image_path or payload.get("image_path")
        calibration_path = calibration_path or payload.get("calibration_path")

    if not image_path or not calibration_path:
        print("Usage: --image <path> --calibration <path>, or pipe {\"image_path\":..,\"calibration_path\":..} on stdin.", file=sys.stderr)
        sys.exit(1)

    try:
        result = estimate_level(image_path, calibration_path)
    except EstimationError as exc:
        print(str(exc), file=sys.stderr)
        sys.exit(1)

    print(json.dumps(result))


if __name__ == "__main__":
    main()
