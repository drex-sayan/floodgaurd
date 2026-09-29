"""
ml/m5/train_forecast.py

M5 — Water-Level Forecasting (supporting module only).

Trains a minimal multi-horizon water-level regressor (+1h / +3h / +6h)
using the same tabular lag/rolling feature style as M3
(water_level_lag1h/3h/6h, rise_rate, rainfall windows). There is no
dedicated M5 dataset yet, so this reuses the M3 mock dataset's
water-level columns as a stand-in regression target — exactly as M3
uses those same columns as *inputs* for its own flash-flood
classifier. M5 never reads or writes flash_flood_next_3h, and nothing
here changes M3's saved artifacts or its predicted probability.

Chronological split, same philosophy as M3: no random shuffling, train
strictly precedes validation which strictly precedes test.

Run:
    python ml/m5/train_forecast.py
(from the project root, or from ml/m5/ directly)
"""
from pathlib import Path
import json
import joblib
import numpy as np
import pandas as pd
from sklearn.ensemble import RandomForestRegressor
from sklearn.multioutput import MultiOutputRegressor
from sklearn.metrics import mean_absolute_error, mean_squared_error

from mock_m3_fallback import ensure_m3_dataset

ROOT = Path(__file__).resolve().parents[1]   # ml/
DATA = ROOT / 'data'
ART = ROOT / 'artifacts'
REP = ROOT / 'reports'
ART.mkdir(exist_ok=True)
REP.mkdir(exist_ok=True)

# Same input feature style as M3 (station identity/terrain, rainfall
# accumulation windows, soil moisture trend, water-level lags/changes,
# historical context). M5 does not use M3's flash_flood_next_3h target
# as an input or an output.
FEATURES = [
    'station_id', 'latitude', 'longitude', 'elevation_m', 'slope_deg',
    'rainfall_1h', 'rainfall_3h', 'rainfall_6h', 'rainfall_12h', 'rainfall_24h',
    'soil_moisture', 'moisture_change_3h',
    'water_level_m', 'water_level_lag1h', 'water_level_lag3h', 'water_level_lag6h',
    'water_level_change_1h', 'water_level_change_3h', 'rise_rate_m_per_hour',
    'recent_event_count', 'event_proximity_km'
]
HORIZONS = {'1h': 1, '3h': 3, '6h': 6}
TARGET_COLS = [f'target_water_level_{h}' for h in HORIZONS]

used_fallback = ensure_m3_dataset(DATA)
if used_fallback:
    print(
        'NOTE: ml/data/M3_*.csv were not found, so a schema-compatible '
        'synthetic stand-in dataset was generated for this run (see '
        'ml/m5/mock_m3_fallback.py). Drop in the real M3_*.csv files and '
        're-run to train on the actual M3 dataset instead.'
    )

train = pd.read_csv(DATA / 'M3_train.csv', parse_dates=['timestamp'])
val = pd.read_csv(DATA / 'M3_validation.csv', parse_dates=['timestamp'])
test = pd.read_csv(DATA / 'M3_test.csv', parse_dates=['timestamp'])


def add_forecast_targets(df: pd.DataFrame) -> pd.DataFrame:
    """Build the +1h/+3h/+6h water-level targets by shifting water_level_m
    forward in time *within each station's own chronological sequence,
    within this split only* (train/val/test are never recombined, so this
    cannot leak information across the M3 split boundaries).
    """
    df = df.sort_values(['station_id', 'timestamp']).reset_index(drop=True)
    for h_label, h_steps in HORIZONS.items():
        df[f'target_water_level_{h_label}'] = (
            df.groupby('station_id')['water_level_m'].shift(-h_steps)
        )
    # Drop the tail rows per station where a future horizon isn't
    # available yet (nothing to forecast against).
    return df.dropna(subset=TARGET_COLS).reset_index(drop=True)


train = add_forecast_targets(train)
val = add_forecast_targets(val)
test = add_forecast_targets(test)

X_train, y_train = train[FEATURES], train[TARGET_COLS]
X_val, y_val = val[FEATURES], val[TARGET_COLS]
X_test, y_test = test[FEATURES], test[TARGET_COLS]

model = MultiOutputRegressor(
    RandomForestRegressor(
        n_estimators=120,
        max_depth=10,
        min_samples_leaf=5,
        random_state=42,
        n_jobs=-1,
    )
)
model.fit(X_train, y_train)


def horizon_metrics(y_true: pd.DataFrame, y_pred: np.ndarray) -> dict:
    out = {}
    for i, h_label in enumerate(HORIZONS):
        yt = y_true.iloc[:, i].values
        yp = y_pred[:, i]
        mae = float(mean_absolute_error(yt, yp))
        rmse = float(np.sqrt(mean_squared_error(yt, yp)))
        out[h_label] = {'mae_m': mae, 'rmse_m': rmse, 'n': int(len(yt))}
    return out


p_train = model.predict(X_train)
p_val = model.predict(X_val)
p_test = model.predict(X_test)

m_train = horizon_metrics(y_train, p_train)
m_val = horizon_metrics(y_val, p_val)
m_test = horizon_metrics(y_test, p_test)


def save_predictions(df, preds, split):
    out = df[['timestamp', 'station', 'station_id', 'water_level_m']].copy()
    for i, h_label in enumerate(HORIZONS):
        out[f'actual_{h_label}'] = df[f'target_water_level_{h_label}'].values
        out[f'predicted_{h_label}'] = preds[:, i]
    out.to_csv(REP / f'M5_{split}_predictions.csv', index=False)


save_predictions(train, p_train, 'train')
save_predictions(val, p_val, 'validation')
save_predictions(test, p_test, 'test')

joblib.dump(model, ART / 'M5_forecast_model.joblib')

metadata = {
    'model_version': 'M5-v1.0',
    'model_type': 'MultiOutputRegressor(RandomForestRegressor) — one model, three horizon outputs',
    'target': 'water_level_m at +1h / +3h / +6h (stand-in target: M3 dataset water-level columns, shifted forward)',
    'note': "Supporting module — output does not change M3's flash-flood probability.",
    'features': FEATURES,
    'horizons_hours': list(HORIZONS.values()),
    'random_seed': 42,
    'data_is_synthetic': True,
    'data_source': (
        'synthetic stand-in dataset generated by ml/m5/mock_m3_fallback.py '
        '(ml/data/M3_*.csv were not present)'
        if used_fallback else
        "project's ml/data/M3_*.csv (M3's mock dataset, reused as a stand-in target)"
    ),
    'splits': {'train_rows': len(train), 'validation_rows': len(val), 'test_rows': len(test)},
    'metrics': {'train': m_train, 'validation': m_val, 'test': m_test},
}
(ART / 'M5_model_metadata.json').write_text(json.dumps(metadata, indent=2), encoding='utf-8')
(REP / 'M5_metrics.json').write_text(json.dumps(metadata['metrics'], indent=2), encoding='utf-8')

report = '# FloodGuard M5-v1.0 Training Report\n\n'
report += 'Supporting module — output does not change M3\'s flash-flood probability.\n\n'
report += f"Dataset: {'synthetic stand-in (see ml/m5/mock_m3_fallback.py)' if used_fallback else 'M3 mock dataset (reused water-level columns)'}\n\n"
report += 'Target: water_level_m at +1h / +3h / +6h\n\n'
report += '## Split sizes\n\n'
report += f'- Train: {len(train):,}\n- Validation: {len(val):,}\n- Test: {len(test):,}\n\n'
for name, m in [('Train', m_train), ('Validation', m_val), ('Test', m_test)]:
    report += f'## {name}\n\n| Horizon | MAE (m) | RMSE (m) | n |\n|---|---:|---:|---:|\n'
    for h_label in HORIZONS:
        row = m[h_label]
        report += f"| +{h_label} | {row['mae_m']:.4f} | {row['rmse_m']:.4f} | {row['n']} |\n"
    report += '\n'
report += (
    '## Important limitation\n\n'
    'The dataset and target are synthetic. Metrics demonstrate that the '
    'training/inference pipeline works correctly; they do not establish '
    'real-world water-level forecasting accuracy. M5 is a supporting '
    "module only and its output never feeds into M3's flash-flood "
    'probability or the Zone Engine.\n'
)
(REP / 'M5_training_report.md').write_text(report, encoding='utf-8')

print(json.dumps({'test_metrics': m_test}, indent=2))
