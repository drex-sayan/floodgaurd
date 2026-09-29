"""
ml/m4/predict_landslide.py

M4 — Landslide Hazard Estimate inference (supporting module only).

Same stdin/stdout JSON contract as ml/scripts/predict_m3.py and
ml/m5/predict_forecast.py: reads one JSON object of M4 features from
stdin, prints one JSON result to stdout. Intended to be spawned by
routes/m4.js the same way server.js's runM3Prediction() spawns
predict_m3.py.

Input: a JSON object with:
    slope_deg, elevation_m, rainfall_1h, rainfall_3h, rainfall_6h,
    rainfall_12h, rainfall_24h, soil_moisture, moisture_change_3h  (numbers)
    land_cover, geology                                            (strings,
        matching the categorical_encodings in M4_model_metadata.json —
        unknown/missing values fall back to the lowest-risk class rather
        than failing, since this is a context signal, not a hard gate)
(or {"data": {...}} wrapping the same)

Output:
    {
      "model_version": "M4-v1.0",
      "landslide_probability": <0-1>,
      "risk_level": "LOW" | "MODERATE" | "HIGH" | "EXTREME",
      "data_is_synthetic": true
    }

This script never touches ml/artifacts/M3_*.joblib or
ml/artifacts/model_metadata.json, and its output is not consumed by
runM3Prediction(), the Zone Engine, or the Alert Engine — see
routes/m4.js and ml/m4/README.md for why that separation is structural.
"""
import json
import sys
from pathlib import Path

import joblib
import pandas as pd

ROOT = Path(__file__).resolve().parents[1]  # ml/
ART = ROOT / 'artifacts'

NUMERIC_FEATURES = [
    'slope_deg', 'elevation_m',
    'rainfall_1h', 'rainfall_3h', 'rainfall_6h', 'rainfall_12h', 'rainfall_24h',
    'soil_moisture', 'moisture_change_3h',
]
FEATURES = [
    'slope_deg', 'elevation_m', 'land_cover_code', 'geology_code',
    'rainfall_1h', 'rainfall_3h', 'rainfall_6h', 'rainfall_12h', 'rainfall_24h',
    'soil_moisture', 'moisture_change_3h',
]

model = joblib.load(ART / 'M4_calibrated_model.joblib')
meta = json.loads((ART / 'M4_model_metadata.json').read_text())
LAND_COVER_CODES = meta['categorical_encodings']['land_cover']
GEOLOGY_CODES = meta['categorical_encodings']['geology']

# Lowest-risk class in each encoding — used as a neutral fallback when a
# location's terrain_features row has no land_cover/geology yet, rather
# than failing the request. This mirrors M5's "estimated" fallback
# philosophy (see routes/m5.js): never invent a high-risk reading, only
# ever a conservative default.
DEFAULT_LAND_COVER = 'forest'
DEFAULT_GEOLOGY = 'sedimentary'


def risk_from_probability(probability: float):
    p = float(probability)
    if p < 0.30:
        return 'LOW', 'No strong landslide-hazard signal from M4'
    if p < 0.60:
        return 'MODERATE', 'Conditions warrant awareness'
    if p < 0.80:
        return 'HIGH', 'Elevated landslide-hazard signal'
    return 'EXTREME', 'Very high hazard signal on this synthetic model — treat as context only'


payload = json.load(sys.stdin)
if isinstance(payload, dict) and 'data' in payload:
    payload = payload['data']
if not isinstance(payload, dict):
    raise ValueError('Input must be a JSON object of M4 features.')

missing = [f for f in NUMERIC_FEATURES if f not in payload]
if missing:
    raise ValueError('Missing required features: ' + ', '.join(missing))

row = {f: float(payload[f]) for f in NUMERIC_FEATURES}

land_cover = payload.get('land_cover')
geology = payload.get('geology')
row['land_cover_code'] = LAND_COVER_CODES.get(land_cover, LAND_COVER_CODES[DEFAULT_LAND_COVER])
row['geology_code'] = GEOLOGY_CODES.get(geology, GEOLOGY_CODES[DEFAULT_GEOLOGY])

X = pd.DataFrame([row], columns=FEATURES)
prob = float(model.predict_proba(X)[0, 1])
risk, meaning = risk_from_probability(prob)

print(json.dumps({
    'model_version': meta['model_version'],
    'landslide_probability': round(prob, 4),
    'risk_level': risk,
    'risk_meaning': meaning,
    'data_is_synthetic': bool(meta['data_is_synthetic']),
}))
