import json, sys
from pathlib import Path
import joblib
import pandas as pd
from risk_engine import risk_from_probability

ROOT = Path(__file__).resolve().parents[1]
ART = ROOT / 'artifacts'
FEATURES = [
    'station_id','latitude','longitude','elevation_m','slope_deg',
    'rainfall_1h','rainfall_3h','rainfall_6h','rainfall_12h','rainfall_24h',
    'soil_moisture','moisture_change_3h',
    'water_level_m','water_level_lag1h','water_level_lag3h','water_level_lag6h',
    'water_level_change_1h','water_level_change_3h','rise_rate_m_per_hour',
    'recent_event_count','event_proximity_km'
]
model = joblib.load(ART/'M3_calibrated_model.joblib')
meta = json.loads((ART/'model_metadata.json').read_text())

payload = json.load(sys.stdin)
if isinstance(payload, dict) and 'data' in payload:
    payload = payload['data']
if not isinstance(payload, dict):
    raise ValueError('Input must be a JSON object of M3 features.')

missing = [f for f in FEATURES if f not in payload]
if missing:
    raise ValueError('Missing required features: ' + ', '.join(missing))

row = {f: float(payload[f]) for f in FEATURES}
X = pd.DataFrame([row], columns=FEATURES)
prob = float(model.predict_proba(X)[0,1])
risk, meaning = risk_from_probability(prob)

print(json.dumps({
    'model_version': meta['model_version'],
    'flood_probability': prob,
    'risk_level': risk,
    'risk_meaning': meaning,
    'prediction_window': meta['prediction_window'],
    'data_quality': 1.0,
}))
