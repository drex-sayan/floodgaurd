"""
ml/m5/predict_forecast.py

M5 — Water-Level Forecasting inference (supporting module only).

Same stdin/stdout JSON contract as ml/scripts/predict_m3.py: reads one
JSON object of M5 features from stdin, prints one JSON result to
stdout. Intended to be spawned by routes/m5.js exactly the way
server.js's runM3Prediction() spawns predict_m3.py.

Input: a JSON object with every field in FEATURES below (or
{"data": {...}} wrapping the same).

Output:
    {
      "model_version": "...",
      "forecast_1h": <water level, metres>,
      "forecast_3h": <water level, metres>,
      "forecast_6h": <water level, metres>,
      "data_is_synthetic": true
    }

This script never touches ml/artifacts/M3_*.joblib or
ml/artifacts/model_metadata.json, and its output is not consumed by
runM3Prediction(), the Zone Engine, or the Alert Engine.
"""
import json
import sys
from pathlib import Path

import joblib
import pandas as pd

ROOT = Path(__file__).resolve().parents[1]  # ml/
ART = ROOT / 'artifacts'

FEATURES = [
    'station_id', 'latitude', 'longitude', 'elevation_m', 'slope_deg',
    'rainfall_1h', 'rainfall_3h', 'rainfall_6h', 'rainfall_12h', 'rainfall_24h',
    'soil_moisture', 'moisture_change_3h',
    'water_level_m', 'water_level_lag1h', 'water_level_lag3h', 'water_level_lag6h',
    'water_level_change_1h', 'water_level_change_3h', 'rise_rate_m_per_hour',
    'recent_event_count', 'event_proximity_km'
]
HORIZON_ORDER = ['1h', '3h', '6h']  # must match HORIZONS order in train_forecast.py

model = joblib.load(ART / 'M5_forecast_model.joblib')
meta = json.loads((ART / 'M5_model_metadata.json').read_text())

payload = json.load(sys.stdin)
if isinstance(payload, dict) and 'data' in payload:
    payload = payload['data']
if not isinstance(payload, dict):
    raise ValueError('Input must be a JSON object of M5 features.')

missing = [f for f in FEATURES if f not in payload]
if missing:
    raise ValueError('Missing required features: ' + ', '.join(missing))

row = {f: float(payload[f]) for f in FEATURES}
X = pd.DataFrame([row], columns=FEATURES)
pred = model.predict(X)[0]  # [level_+1h, level_+3h, level_+6h]

result = {
    'model_version': meta['model_version'],
    'forecast_1h': round(float(pred[0]), 3),
    'forecast_3h': round(float(pred[1]), 3),
    'forecast_6h': round(float(pred[2]), 3),
    'data_is_synthetic': bool(meta['data_is_synthetic']),
}
print(json.dumps(result))
