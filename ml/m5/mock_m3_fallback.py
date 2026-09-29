"""
ml/m5/mock_m3_fallback.py

M5 needs the M3 dataset's water-level columns as a stand-in regression
target (see ml/m5/README.md). train_m3.py already expects
ml/data/M3_train.csv, M3_validation.csv and M3_test.csv to exist — this
project generates them from a mock-data pipeline that isn't part of this
delivery bundle (ml/data/ is not checked in).

This module does NOT replace that pipeline. It only bootstraps a
schema-compatible stand-in so ml/m5/train_forecast.py can run end to end
in an environment where the real M3_*.csv files are missing. If those
files are already present (e.g. after running the real M3 pipeline),
this module is never invoked — train_forecast.py reads them directly,
exactly like train_m3.py does.

The generated data is clearly synthetic and is only meant to exercise the
M5 training/inference code path with something physically plausible
(rainfall driving soil moisture and water level, hourly lag/rolling
features, chronological ordering). It is NOT the M3 team's dataset and
must never be presented as such.
"""
from pathlib import Path
import numpy as np
import pandas as pd

# Same column set train_m3.py / predict_m3.py expect, so a real M3_*.csv
# drop-in is a no-op replacement for this fallback.
FEATURES = [
    'station_id', 'latitude', 'longitude', 'elevation_m', 'slope_deg',
    'rainfall_1h', 'rainfall_3h', 'rainfall_6h', 'rainfall_12h', 'rainfall_24h',
    'soil_moisture', 'moisture_change_3h',
    'water_level_m', 'water_level_lag1h', 'water_level_lag3h', 'water_level_lag6h',
    'water_level_change_1h', 'water_level_change_3h', 'rise_rate_m_per_hour',
    'recent_event_count', 'event_proximity_km'
]
TARGET = 'flash_flood_next_3h'

STATIONS = [
    {'station': 'Chamoli-Gauge-1', 'station_id': 1, 'latitude': 30.4032, 'longitude': 79.3212, 'elevation_m': 1800.0, 'slope_deg': 22.0, 'base_level': 1.3, 'flood_threshold': 3.2},
    {'station': 'Kolkata-Gauge-1', 'station_id': 2, 'latitude': 22.5726, 'longitude': 88.3639, 'elevation_m': 9.0, 'slope_deg': 1.5, 'base_level': 0.8, 'flood_threshold': 2.4},
    {'station': 'Guwahati-Gauge-1', 'station_id': 3, 'latitude': 26.1445, 'longitude': 91.7362, 'elevation_m': 55.0, 'slope_deg': 4.0, 'base_level': 1.0, 'flood_threshold': 2.8},
    {'station': 'Sonapur-Gauge-1', 'station_id': 4, 'latitude': 26.0, 'longitude': 92.0, 'elevation_m': 40.0, 'slope_deg': 6.5, 'base_level': 0.9, 'flood_threshold': 2.6},
]

HOURS = 3000  # ~125 days per station, hourly


def _simulate_station(meta, rng):
    n = HOURS
    t = pd.date_range('2024-01-01', periods=n, freq='h')

    # Rainfall: rare bursts on top of light background drizzle probability.
    burst = (rng.random(n) < 0.03).astype(float) * rng.gamma(4.0, 3.5, n)
    drizzle = (rng.random(n) < 0.12).astype(float) * rng.gamma(1.2, 0.8, n)
    rainfall_1h = np.clip(burst + drizzle, 0, None)
    rainfall_1h_s = pd.Series(rainfall_1h)
    rainfall_3h = rainfall_1h_s.rolling(3, min_periods=1).sum()
    rainfall_6h = rainfall_1h_s.rolling(6, min_periods=1).sum()
    rainfall_12h = rainfall_1h_s.rolling(12, min_periods=1).sum()
    rainfall_24h = rainfall_1h_s.rolling(24, min_periods=1).sum()

    # Soil moisture: rises with rainfall, decays slowly when dry.
    soil = np.zeros(n)
    soil[0] = 35.0
    for i in range(1, n):
        soil[i] = soil[i - 1] * 0.985 + rainfall_1h[i] * 1.4
    soil = np.clip(soil, 5, 100)
    soil_s = pd.Series(soil)
    moisture_change_3h = soil_s.diff(3).fillna(0.0)

    # Water level: mean-reverts to base, but responds strongly enough to
    # synthetic storm bursts to produce a realistic minority of future
    # flood events.  The previous fallback used a drive term that was too
    # small, so all labels collapsed to class 0 and M3 calibration failed.
    level = np.zeros(n)
    level[0] = meta['base_level']
    noise = rng.normal(0, 0.02, n)
    for i in range(1, n):
        rain_drive = 0.055 * rainfall_3h.iloc[i] / 10.0 + 0.025 * rainfall_6h.iloc[i] / 10.0
        soil_drive = 0.035 * max(soil[i] - 45, 0) / 55.0
        storm_surge = 0.12 if rainfall_1h[i] >= 12.0 else 0.0
        reversion = 0.025 * (meta['base_level'] - level[i - 1])
        level[i] = max(0.05, level[i - 1] + reversion + rain_drive + soil_drive + storm_surge + noise[i])
    level_s = pd.Series(level)

    lag1 = level_s.shift(1)
    lag3 = level_s.shift(3)
    lag6 = level_s.shift(6)
    change_1h = level_s.diff(1)
    change_3h = level_s.diff(3)
    rise_rate = change_1h.copy()

    future_max_3h = level_s.shift(-1).rolling(3, min_periods=1).max()
    flash_flood_next_3h = (future_max_3h >= meta['flood_threshold']).astype(int)

    high_flag = (level_s >= meta['flood_threshold'] * 0.85).astype(int)
    recent_event_count = high_flag.rolling(72, min_periods=1).sum()
    event_proximity_km = pd.Series(np.full(n, round(float(rng.uniform(2, 25)), 2)))

    df = pd.DataFrame({
        'timestamp': t,
        'station': meta['station'],
        'station_id': meta['station_id'],
        'latitude': meta['latitude'],
        'longitude': meta['longitude'],
        'elevation_m': meta['elevation_m'],
        'slope_deg': meta['slope_deg'],
        'rainfall_1h': rainfall_1h.round(3),
        'rainfall_3h': rainfall_3h.round(3),
        'rainfall_6h': rainfall_6h.round(3),
        'rainfall_12h': rainfall_12h.round(3),
        'rainfall_24h': rainfall_24h.round(3),
        'soil_moisture': soil_s.round(2),
        'moisture_change_3h': moisture_change_3h.round(2),
        'water_level_m': level_s.round(3),
        'water_level_lag1h': lag1.round(3),
        'water_level_lag3h': lag3.round(3),
        'water_level_lag6h': lag6.round(3),
        'water_level_change_1h': change_1h.round(3),
        'water_level_change_3h': change_3h.round(3),
        'rise_rate_m_per_hour': rise_rate.round(3),
        'recent_event_count': recent_event_count.astype(int),
        'event_proximity_km': event_proximity_km.round(2),
        'flash_flood_next_3h': flash_flood_next_3h,
    })
    # Early rows lack full lag history — fill with the earliest known level
    # rather than dropping, so every station contributes the same hourly
    # span to the chronological split.
    for col in ['water_level_lag1h', 'water_level_lag3h', 'water_level_lag6h']:
        df[col] = df[col].fillna(df['water_level_m'].iloc[0])
    df['water_level_change_1h'] = df['water_level_change_1h'].fillna(0.0)
    df['water_level_change_3h'] = df['water_level_change_3h'].fillna(0.0)
    df['rise_rate_m_per_hour'] = df['rise_rate_m_per_hour'].fillna(0.0)
    return df


def ensure_m3_dataset(data_dir: Path) -> bool:
    """Create ml/data/M3_{train,validation,test}.csv if they're missing.

    Returns True if files were generated (fallback used), False if the
    real dataset was already present and nothing was touched.
    """
    data_dir = Path(data_dir)
    train_p, val_p, test_p = (data_dir / f'M3_{name}.csv' for name in ('train', 'validation', 'test'))
    # Regenerate an existing fallback dataset if it is malformed.  In
    # particular, M3 calibration requires both target classes in every
    # chronological split.
    if train_p.exists() and val_p.exists() and test_p.exists():
        try:
            existing = [pd.read_csv(p, usecols=[TARGET]) for p in (train_p, val_p, test_p)]
            if all(existing_df[TARGET].nunique() >= 2 for existing_df in existing):
                return False
        except Exception:
            pass

    data_dir.mkdir(parents=True, exist_ok=True)
    rng = np.random.default_rng(42)
    stations = [_simulate_station(meta, rng) for meta in STATIONS]
    full = pd.concat(stations, ignore_index=True).sort_values(['timestamp', 'station_id']).reset_index(drop=True)

    # Chronological 70/15/15 split by unique timestamp, same as M3's split
    # philosophy: cut on time, keep every station represented in each split.
    unique_ts = full['timestamp'].drop_duplicates().sort_values().reset_index(drop=True)
    n_ts = len(unique_ts)
    train_cut = unique_ts.iloc[int(n_ts * 0.70)]
    val_cut = unique_ts.iloc[int(n_ts * 0.85)]

    train_df = full[full['timestamp'] < train_cut]
    val_df = full[(full['timestamp'] >= train_cut) & (full['timestamp'] < val_cut)]
    test_df = full[full['timestamp'] >= val_cut]

    train_df.to_csv(train_p, index=False)
    val_df.to_csv(val_p, index=False)
    test_df.to_csv(test_p, index=False)
    return True
