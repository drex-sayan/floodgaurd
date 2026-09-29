# FloodGuard M1 — Water-Level Vision Module (prototype)

> **CALIBRATION-BASED PROTOTYPE — NOT A VALIDATED COMPUTER-VISION GAUGE.**
> `level_m` comes from a manually-placed pixel-to-metre calibration line
> plus a simple edge detector, run against static reference stills (no
> real CCTV feed is wired up yet). Treat it as a rough context signal for
> the dashboard, never as ground truth or as input to the M3 flood model.

## What this is

M1 is a **supporting module**. It does not feed the M3 flash-flood
probability in any way — M3's inputs are unchanged, and `services/zoneEngine.js`
only widens Red/Yellow/Green zone radii for a water-level reading whose
`quality_status` is `'good'`. Every row M1 writes uses
`quality_status = 'estimated'` (see "Why `quality_status` is always
`'estimated'`" below), so M1's output is structurally inert everywhere
except the M1 dashboard card. It is context, not evidence.

## Pipeline

```
 static camera still (PNG)              per-camera calibration JSON
            │                                       │
            └───────────────┬───────────────────────┘
                             ▼
                  ml/m1/estimate_level.py
              { level_m, vision_confidence, ... }
                             │
                             ▼
                services/m1Ingest.js (Node)
   compares against prior water_level_readings rows for the same
   location + camera to compute change_10m / change_30m / change_1h
   and rise_rate_m_per_hr, then INSERTs one row
                             │
                             ▼
                    water_level_readings
                             │
                             ▼
              GET /api/m1/latest?location_id=...
                             │
                             ▼
                 M1 card on the Overview dashboard
```

## Files

| File | Purpose |
|---|---|
| `estimate_level.py` | Core CV script: image + calibration in, `{level_m, vision_confidence, ...}` out. No DB access, no network — same "pure function" shape as `ml/scripts/predict_m3.py`. |
| `calibration/FORMAT.md` | The calibration config schema, field by field. |
| `calibration/CCTV-04.json` | One illustrative calibration, mapped to `location_id` 1 (Chamoli, the seeded supported region) and named after the `CCTV-04` camera already shown on the dashboard's Cameras view. |
| `make_mock_images.py` | Generates `mock_images/mock_t0_low.png` → `mock_t2_high.png`: three synthetic gauge-post stills at rising water levels, standing in for real CCTV frames per the task spec ("build this against static reference images or a short mock video"). |
| `mock_images/` | Output of the script above. Regenerate any time with `python ml/m1/make_mock_images.py`. |

`../../services/m1Ingest.js` and `../../routes/m1.js` (Node) live outside
this folder — see their file headers for the ingest/query side.

## Running it directly

```bash
python ml/m1/estimate_level.py \
  --image ml/m1/mock_images/mock_t1_mid.png \
  --calibration ml/m1/calibration/CCTV-04.json
```

```json
{"level_m": 11.2, "vision_confidence": 1.0, "waterline_pixel_y": 304,
 "calibration_id": "CCTV-04-2026-09", "camera_id": "CCTV-04", "location_id": 1,
 "units": "m", "method": "reference_marker_edge_detection_v0", "prototype": true,
 "disclaimer": "Calibration-based prototype estimate — not a validated computer-vision gauge.",
 "generated_at": "..."}
```

It also accepts JSON on stdin (`{"image_path": "...", "calibration_path": "..."}`),
matching `predict_m3.py`'s convention — this is the mode
`services/m1Ingest.js` uses.

## How the estimate works (and its limits)

1. Average a narrow vertical strip of pixels around the calibrated
   `search_column_px` into a single top-to-bottom brightness profile.
2. Smooth it, then take the absolute difference between consecutive rows
   (a 1D edge/gradient) inside the configured `search_band_px`.
3. The row with the single strongest step is called the waterline.
4. Map that pixel row to metres by linear interpolation between the two
   `reference_points` in the calibration file.
5. `vision_confidence` is a rough peak-prominence score (how much the
   strongest edge stands out from the rest of the band), reduced further
   if the edge sits right at the search band's boundary or the band had
   to be clamped to the image size. It is **not** a calibrated probability
   — treat 0.3 vs 0.6 as "less trustworthy" vs "more trustworthy," not as
   precise numbers.

What it deliberately does **not** do: no water/non-water classification,
no lens or perspective correction, no rejection of a false edge caused by
a shadow, reflection, dirt line, or person standing at the post, and no
automatic re-calibration if the camera moves. A calibration file needs a
human to re-place its `reference_points` whenever the camera is
re-aimed, remounted, or replaced.

## Why `quality_status` is always `'estimated'`

`water_level_readings.quality_status` has four possible values —
`'good' | 'stale' | 'missing' | 'estimated'` — and
`config/zonePolicy.json`'s `water_level_rise_adjustment.required_quality_status`
defaults to `'good'`. `services/zoneEngine.js` only widens a zone's radius
for a rise-rate reading when that exact condition is met. Every row
`services/m1Ingest.js` inserts hardcodes `quality_status: 'estimated'`,
which the Zone Engine already treats as unusable evidence (same as no
reading at all — it falls back to the base M3-only radius). That is
intentional, not a gap to fix later: it is the mechanism that keeps this
supporting module's output from silently changing anything besides the
M1 context card, exactly as the task requires. If M1 ever becomes a
validated gauge, that decision — and the zone policy config — would need
a deliberate, separate review before flipping to `'good'`.

## Multi-camera note (MVP limitation)

`routes/m1.js` resolves a location's camera by scanning
`calibration/*.json` for a `location_id` match and using the first hit.
This MVP ships one calibration file (`CCTV-04.json`, for `location_id` 1),
so that lookup is unambiguous today. Supporting more than one camera per
location is a small extension (return/select among all matches) but is
out of scope for this module.
