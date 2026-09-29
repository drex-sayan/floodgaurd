# M1 calibration config format

One JSON file per camera, stored in `ml/m1/calibration/<camera_id>.json`.
It defines a manual pixel-to-metre mapping for that camera's fixed frame —
there is no trained model and no auto-calibration. A human places the two
`reference_points` by looking at a still from the camera and matching pixel
rows to known real-world elevations (survey marks, a staff gauge painted on
a pillar, a bridge deck height — whatever is available on site).

```jsonc
{
  // Stable identifier for this calibration. Bump the suffix any time the
  // camera is physically moved, re-aimed, or re-zoomed — an old
  // calibration silently reused after the camera moves is worse than no
  // reading at all.
  "calibration_id": "CCTV-04-2026-09",

  "camera_id": "CCTV-04",

  // Which FloodGuard `locations` row this camera's readings belong to.
  "location_id": 1,

  "units": "m",

  // Informational only — the real frame is read from disk at its native
  // size. Kept here so a human reviewing this file can sanity-check
  // search_column_px / search_band_px without opening an image.
  "image_size": { "width": 640, "height": 480 },

  // The vertical pixel column to scan for the waterline. Should sit on (or
  // just beside) a vertical reference feature — a gauge post, a bridge
  // pillar, a wall — that is visible in every frame and shows a clear
  // brightness change where water meets it.
  "search_column_px": 320,

  // Only look for the waterline between these two rows. Keeps the
  // detector from locking onto an unrelated edge elsewhere in the frame
  // (a shadow, a horizon line, a passing vehicle).
  "search_band_px": { "top": 60, "bottom": 440 },

  // Exactly two points, manually read off a reference still. pixel_y is
  // the row in the image; elevation_m is the real-world level at that row
  // in the same datum FloodGuard stores level_m in. The two rows do NOT
  // need to be the search band's top/bottom — pick whatever two marks are
  // actually visible and measured on site.
  "reference_points": [
    { "pixel_y": 400, "elevation_m": 10.00, "label": "low reference mark" },
    { "pixel_y": 120, "elevation_m": 13.50, "label": "high reference mark" }
  ],

  // How many pixels wide the scanned strip is, centered on
  // search_column_px, averaged per row to reduce single-column noise.
  "strip_width_px": 5,

  // Smoothing window (in rows) applied to the intensity profile before
  // edge detection.
  "smoothing_px": 5,

  // Free text. Not read by the script — for the human who calibrated it.
  "notes": "Calibration line placed manually against the Rampur river-crossing gauge post. Not survey-grade. Re-check after any monsoon-season camera remount."
}
```

## Rules the script enforces

- `reference_points` must contain exactly two entries with distinct
  `pixel_y` values (division by zero otherwise) and distinct
  `elevation_m` values.
- `search_band_px.top` must be less than `search_band_px.bottom`, and both
  must fall inside the actual image height read from disk — the script
  clamps to the real image size and lowers `vision_confidence` if the
  configured band had to be clamped, since that usually means the config
  is stale for the current frame size.
- Everything else in this file is a plain estimate aid, not a hard
  constraint — the script degrades `vision_confidence` rather than
  refusing to run when a reading looks marginal (edge near the band
  boundary, very low contrast, etc).

## What this is not

This is a manual, per-camera pixel-ruler, not a trained computer-vision
gauge. It has no lens-distortion correction, no perspective correction, no
water-recognition model, and no automatic re-calibration if the camera
moves. Treat every `level_m` this produces as a rough, camera-specific
estimate for a context card — never as a validated hydrological
measurement. See `ml/m1/README.md`.
