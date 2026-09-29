# FloodGuard M5 — Water-Level Forecasting Module (prototype)

> **TRAINED ON A SYNTHETIC STAND-IN DATASET — NOT VALIDATED FORECASTS.**
> There is no dedicated M5 dataset yet, so this model is trained against
> the M3 mock dataset's own water-level columns, used as a *stand-in
> regression target* (see "Where the training data comes from" below).
> Treat `forecast_1h/3h/6h` as a rough context signal for the dashboard,
> never as ground truth or as input to the M3 flood model.

## What this is

M5 is a **supporting module**, structurally the same shape as M1. It does
not feed the M3 flash-flood probability in any way — `runM3Prediction()`
in `server.js`, `services/zoneEngine.js`, and `services/alertEngine.js`
never call anything in `ml/m5/` or `routes/m5.js`, and nothing M5 writes
is read back by M3. It exists solely to drive the M5 card on the Overview
dashboard.

## Pipeline

```
        ml/data/M3_train.csv / M3_validation.csv / M3_test.csv
     (M3's mock dataset — water_level_m columns reused as a stand-in
      regression target; M5 never reads flash_flood_next_3h)
                             │
                             ▼
                ml/m5/train_forecast.py
   shifts water_level_m forward per-station, within each split only,
   to build target_water_level_{1h,3h,6h}; trains one
   MultiOutputRegressor(RandomForestRegressor)
                             │
                             ▼
     ml/artifacts/M5_forecast_model.joblib + M5_model_metadata.json
        ml/reports/M5_training_report.md + M5_metrics.json
                             │
                             ▼
                ml/m5/predict_forecast.py
        (JSON features in on stdin → JSON forecast out on stdout,
         same contract as ml/scripts/predict_m3.py)
                             │
                             ▼
                     routes/m5.js
   builds a feature vector for a location from whatever DB history
   exists (locations, terrain_features, water_level_readings,
   rainfall_readings, soil_moisture_readings, historical_events),
   falling back to neutral defaults for anything missing
                             │
                             ▼
          GET /api/m5/forecast?location_id=...
                             │
                             ▼
                 M5 card on the Overview dashboard
```

## Files

| File | Purpose |
|---|---|
| `train_forecast.py` | Loads the M3 CSVs, builds the +1h/+3h/+6h targets, trains the model, and writes artifacts/reports. Run with `python ml/m5/train_forecast.py`. |
| `predict_forecast.py` | Core inference script: JSON features in, `{forecast_1h, forecast_3h, forecast_6h, model_version, data_is_synthetic}` out. No DB access, no network — same "pure function" shape as `ml/scripts/predict_m3.py`. |
| `mock_m3_fallback.py` | Bootstraps a schema-compatible synthetic `ml/data/M3_*.csv` **only if those files are missing** (they're not part of this delivery bundle — `ml/data/` isn't checked in). If your environment already has the real M3 CSVs, this module is never invoked; `train_forecast.py` reads them directly, exactly like `train_m3.py` does. |

`../../routes/m5.js` (Node) lives outside this folder — see its file
header for the DB/query side.

## Where the training data comes from

M3's mock dataset already has hourly `water_level_m` per station, plus
lag/rolling features (`water_level_lag1h/3h/6h`, `rise_rate_m_per_hour`,
`rainfall_1h/3h/6h/12h/24h`, `soil_moisture`, etc.) built for its own
classifier. M5 reuses that same feature set as **input** and derives its
**target** by shifting `water_level_m` forward in time within each
station's own chronological sequence:

```python
df.groupby('station_id')['water_level_m'].shift(-1)   # target_water_level_1h
df.groupby('station_id')['water_level_m'].shift(-3)   # target_water_level_3h
df.groupby('station_id')['water_level_m'].shift(-6)   # target_water_level_6h
```

This shift happens **within each of `M3_train.csv` / `M3_validation.csv`
/ `M3_test.csv` separately** — the three files are never recombined, so
there is no leakage across M3's existing chronological split boundaries.
Rows at the tail of a station's sequence in a given split, where a future
horizon isn't available yet, are dropped rather than imputed.

M5 never reads or writes `flash_flood_next_3h` (M3's own target).

## Running it directly

```bash
python -m pip install -r ml/requirements.txt
python ml/m5/train_forecast.py
```

```bash
echo '{"station_id":1,"latitude":30.4032,"longitude":79.3212,"elevation_m":1800,"slope_deg":22,
       "rainfall_1h":0,"rainfall_3h":0,"rainfall_6h":2.1,"rainfall_12h":4.0,"rainfall_24h":9.9,
       "soil_moisture":42.0,"moisture_change_3h":1.5,"water_level_m":1.3,
       "water_level_lag1h":1.28,"water_level_lag3h":1.22,"water_level_lag6h":1.15,
       "water_level_change_1h":0.02,"water_level_change_3h":0.08,"rise_rate_m_per_hour":0.02,
       "recent_event_count":0,"event_proximity_km":10.0}' \
  | python ml/m5/predict_forecast.py
```

```json
{"model_version": "M5-v1.0", "forecast_1h": 1.303, "forecast_3h": 1.323, "forecast_6h": 1.402, "data_is_synthetic": true}
```

## API

```
GET /api/m5/forecast?location_id=...
```

```json
{
  "location_id": 1,
  "place_name": "Chamoli",
  "current_level_m": 1.3,
  "forecast_1h": 1.31,
  "forecast_3h": 1.34,
  "forecast_6h": 1.37,
  "model_version": "M5-v1.0",
  "data_is_synthetic": true,
  "data_quality": "estimated",
  "generated_at": "2026-09-08T09:20:00.000Z"
}
```

`data_quality` is `"measured"` only when every input (terrain, rainfall
windows, soil moisture, and 7 hourly water-level readings for lags) came
from the database. Most locations don't have rainfall/soil-moisture
ingestion wired up yet (see `db/schema.sql` — no ingestion job populates
those tables in this MVP) and may have no `water_level_readings` at all
if nobody has run an M1 estimate for them. Rather than fail, the route
substitutes neutral baseline values for whatever is missing and reports
`"estimated"` so the frontend never presents a guess as a real reading —
same spirit as M1's `quality_status`.

## Why this is safe alongside M3

Same mechanism as M1: M5's route, model, and artifacts are entirely
separate files (`M5_`-prefixed in `ml/artifacts/` and `ml/reports/`, a
dedicated `ml/m5/` folder, a dedicated `/api/m5` mount in `server.js`).
Nothing in `runM3Prediction()`, `services/zoneEngine.js`, or
`services/alertEngine.js` was changed, and none of them import from
`ml/m5/` or call `/api/m5/forecast`. M5 is additive only.
