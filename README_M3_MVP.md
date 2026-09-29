# FloodGuard M3 MVP — Complete Implementation

This package combines the FloodGuard web application with the M3 flash-flood prediction training/inference pipeline.

## What is included

1. Mock M3 dataset with a real classification target: `flash_flood_next_3h`.
2. Chronological train/validation/test splits.
3. Random Forest M3-v1.0 model.
4. Sigmoid probability calibration.
5. Validation threshold selection.
6. Precision/recall/F1, ROC-AUC, PR-AUC and Brier-score evaluation.
7. Feature-importance and prediction audit files.
8. Prototype risk decision engine using the architecture's LOW/MODERATE/HIGH/EXTREME probability bands.
9. Node.js `/api/ml/health`, `/api/ml/demo` and `/api/ml/predict` endpoints.
10. Dashboard integration that displays the M3 demo prediction after authentication.
11. Original architecture documentation and supplied CSV under `docs/source/`.

## M3 result on mock test data

- Precision: 0.9330
- Recall: 0.6111
- F1: 0.7385
- ROC-AUC: 0.8423
- PR-AUC: 0.7538
- Brier score: 0.0583

These numbers are for synthetic data only and are not evidence of real-world flood prediction performance.

## Run the ML pipeline

From this directory:

```bash
python -m pip install -r ml/requirements.txt
python ml/scripts/train_m3.py
python ml/scripts/demo_input.py
python ml/scripts/predict_m3.py < ml/demo_input.json
```

The trained artifacts are stored in `ml/artifacts/` and reports in `ml/reports/`.

## Run the web application

1. Install Node.js and MySQL.
2. Configure `.env` with `DB_HOST`, `DB_USER`, `DB_PASSWORD`, and `DB_NAME`.
3. Run:

```bash
npm install
npm start
```

4. Open `http://localhost:5000`.
5. Sign in and open the dashboard. The dashboard calls `/api/ml/demo` and displays the M3 mock prediction.

## API

### GET `/api/ml/health`

Returns model version/type and confirms that the M3 artifact is present.

### GET `/api/ml/demo`

Runs the saved demo observation through M3-v1.0.

### POST `/api/ml/predict`

Accepts the 21 M3 feature fields as JSON and returns:

- `flood_probability`
- `risk_level`
- `prediction_window`
- `model_version`
- `data_quality`

All ML endpoints require an authenticated FloodGuard session.

### GET `/api/zones?location_id=...&risk_level=...&probability=...`

Zone Engine. Turns an M3 prediction you already have (`risk_level`, and
optionally `probability`) into Red/Yellow/Green risk-ring radii centered on
`location_id`. Requires an authenticated session. See "Zone Engine" below
for how the radii are calculated and how to tune them.

## Architecture note

The implementation follows the supplied simplified architecture: data → validation → feature engineering → M3 supervised classification → probability-to-risk decision → dashboard/API. The current MVP does not implement CCTV, M5 water-level forecasting, M4 landslide assessment or real-time IoT streaming.

## Zone Engine (Red/Yellow/Green risk rings)

After the dashboard runs an M3 prediction for a location, it calls
`GET /api/zones` and draws three concentric circles on the Risk map —
Red (innermost), Yellow, Green (outermost) — centered on that location,
with a legend. The map is always labeled **"Illustrative zones — not
validated emergency thresholds"**, because these radii are prototype
placeholders, not a validated emergency-response product.

**Files:**

| File | Purpose |
|---|---|
| `services/zoneEngine.js` | Pure radius-calculation logic |
| `config/zonePolicy.json` | Editable policy: base radii + water-level adjustment |
| `routes/zones.js` | `GET /api/zones` — looks up the location + latest water-level reading, calls the engine |
| `test/manual_zone_test.js` | `node test/manual_zone_test.js` — runs the engine/route against a fake DB, no MySQL needed |

**How a radius is decided (in order):**

1. **Base radius per M3 risk band.** `config/zonePolicy.json`'s
   `base_radius_km` gives a starting `{ red, yellow, green }` in kilometers
   for each of LOW / MODERATE / HIGH / EXTREME. This is the only place the
   M3 output influences distance, and it only uses the categorical
   `risk_level`, not the raw probability — the engine has no code path
   that maps probability directly onto distance.
2. **Water-level rise-rate adjustment.** The engine looks at the most
   recent `water_level_readings` row for the location. If that row is
   fresh (within `max_data_age_minutes`) and has
   `quality_status = 'good'` (the same explicit quality flag the data
   layer already requires — see `db/README.md`), its
   `rise_rate_m_per_hr` is checked against the `tiers` list and the
   matching tier's multiplier widens all three radii.
3. **Degraded confidence fallback.** If the water-level row is missing,
   stale, or not `'good'` quality, the engine skips the adjustment,
   returns the unmodified M3-only base radius, and sets
   `degraded_confidence: true` (with a `degraded_confidence_reason`, e.g.
   `water_level_data_stale`). The dashboard shows this as a note in the
   map legend so it's visible, not silent.

**How to tune the policy — edit `config/zonePolicy.json`, no code changes:**

- To make a risk band's zone bigger or smaller, edit its `red` / `yellow` /
  `green` values under `base_radius_km` (kilometers).
- To change how aggressively a fast-rising water level widens the zones,
  edit the `multiplier` on the relevant entry in
  `water_level_rise_adjustment.tiers`, or add/remove tiers (keep them
  sorted ascending by `min_rise_rate_m_per_hr`).
- To change how fresh a water-level reading must be to count, edit
  `water_level_rise_adjustment.max_data_age_minutes`.
- Bump `zone_policy_version` whenever you change the numbers, so API
  responses and logs make it obvious which policy produced a given zone.
- Restart the server after editing (the JSON is `require()`'d once at
  startup, the same reload rule `config/coverage.json` already follows).

Run `node test/manual_zone_test.js` after any policy edit — it prints the
computed radii for a few scenarios (fresh/good water level under and over
the rise-rate tiers, stale data, missing data, an invalid `risk_level`) so
you can sanity-check a config change before it goes live.

## Production limitation

Before using the system operationally, replace the mock dataset and synthetic labels with verified Chamoli-area observations and confirmed historical flood-event labels. Re-train, calibrate thresholds, perform location-aware evaluation where necessary, and validate the warning policy with the responsible authorities.
