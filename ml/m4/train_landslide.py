"""
ml/m4/train_landslide.py

M4 — Landslide Hazard Estimate (supporting module only, prototype).

>>> TRAINED ON A FULLY SYNTHETIC LABEL. THERE IS NO REAL LANDSLIDE EVENT
>>> DATA ANYWHERE IN THIS REPO. Read "Where the label comes from" below
>>> before trusting a single number this script prints.

Same shape as ml/scripts/train_m3.py and ml/m5/train_forecast.py:
  - reuses M3's mock ml/data/M3_train.csv / M3_validation.csv / M3_test.csv
    splits (so there is no leakage across M3's existing chronological
    split boundaries — we never re-shuffle or recombine them)
  - trains a RandomForestClassifier, consistent with M3's approach
  - calibrates probabilities on the validation split only (same
    FrozenEstimator + sigmoid pattern as train_m3.py), test stays untouched
    for final evaluation
  - writes artifacts/reports in the same M4_-prefixed pattern as M3/M5

This module is independent of M3: it never reads flash_flood_next_3h,
never calls runM3Prediction(), and nothing it writes is read by the Zone
Engine or the Alert Engine. It exists solely to drive the M4 card on the
Overview dashboard with a separate, clearly-labeled hazard signal.

Where the label comes from
---------------------------
M3's mock dataset has real (mock) terrain + rainfall + soil-moisture
columns (slope_deg, elevation_m, rainfall_1h..24h, soil_moisture) but:
  1. no land_cover / geology columns, and
  2. no landslide-event column at all.

So two things are synthesized here, and BOTH are rule-based and fully
deterministic (no hidden randomness that would make results
unreproducible), not sampled from any real geological survey:

  (a) land_cover / geology per station — derived deterministically from
      that station's own slope_deg / elevation_m via `assign_terrain()`
      below. This stands in for a real land-cover/geology lookup (e.g.
      a GIS layer) that this prototype doesn't have.

  (b) the binary landslide label — derived via `landslide_risk_score()`
      below: a weighted combination of slope, soil moisture, 24h
      rainfall, and the land_cover/geology risk factors from (a), plus
      a small amount of Gaussian noise so the boundary isn't perfectly
      sharp, thresholded at a fixed cut chosen to target a plausible
      "landslides are rare" positive rate (~10-15%) on the train split.

None of this reflects real landslide susceptibility science with any
precision — it is a plausible-looking stand-in so the pipeline (train ->
artifacts -> inference -> API -> dashboard) can be built and tested
end-to-end. Treat every metric below as "the pipeline works", not "this
predicts real landslides".
"""
from pathlib import Path
import json

import joblib
import numpy as np
import pandas as pd
from sklearn.ensemble import RandomForestClassifier
from sklearn.metrics import (
    accuracy_score, precision_score, recall_score, f1_score,
    roc_auc_score, average_precision_score, confusion_matrix,
    precision_recall_curve, brier_score_loss
)
from sklearn.calibration import CalibratedClassifierCV, calibration_curve
from sklearn.frozen import FrozenEstimator

ROOT = Path(__file__).resolve().parents[1]  # ml/
DATA = ROOT / 'data'
ART = ROOT / 'artifacts'
REP = ROOT / 'reports'
ART.mkdir(exist_ok=True)
REP.mkdir(exist_ok=True)

RANDOM_SEED = 42

# ---------------------------------------------------------------------------
# (a) Deterministic land_cover / geology assignment.
#
# Purely a function of a station's own (static) slope_deg / elevation_m —
# no lookup table, no randomness. This is a documented stand-in for a real
# GIS land-cover/geology layer, which this prototype does not have access
# to. Applied identically to train/validation/test so a given station gets
# the same terrain class in every split.
# ---------------------------------------------------------------------------
LAND_COVER_CODES = {'urban': 0, 'cropland': 1, 'forest': 2, 'sparse_vegetation': 3}
GEOLOGY_CODES = {'unconsolidated_sediment': 0, 'sedimentary': 1, 'fractured_metamorphic': 2}

# Relative landslide-susceptibility weight per class (0 = most stable,
# 1 = most susceptible). Used only to build the synthetic label below —
# rough, illustrative ordering (dense vegetation/roots stabilize slopes;
# unconsolidated/fractured material fails more easily), not a calibrated
# geotechnical scale.
LAND_COVER_RISK = {'forest': 0.3, 'urban': 0.5, 'cropland': 0.7, 'sparse_vegetation': 1.0}
GEOLOGY_RISK = {'sedimentary': 0.5, 'fractured_metamorphic': 0.8, 'unconsolidated_sediment': 1.0}


def assign_terrain(slope_deg: float, elevation_m: float):
    """Deterministic land_cover / geology stand-in — see module docstring."""
    if slope_deg >= 15:
        land_cover = 'sparse_vegetation'
    elif slope_deg >= 5:
        land_cover = 'forest'
    else:
        land_cover = 'urban' if elevation_m < 20 else 'cropland'

    if elevation_m >= 500:
        geology = 'fractured_metamorphic'
    elif elevation_m >= 50:
        geology = 'sedimentary'
    else:
        geology = 'unconsolidated_sediment'

    return land_cover, geology


def add_terrain_columns(df: pd.DataFrame) -> pd.DataFrame:
    df = df.copy()
    assigned = df.apply(lambda r: assign_terrain(r['slope_deg'], r['elevation_m']), axis=1)
    df['land_cover'] = [a[0] for a in assigned]
    df['geology'] = [a[1] for a in assigned]
    df['land_cover_code'] = df['land_cover'].map(LAND_COVER_CODES)
    df['geology_code'] = df['geology'].map(GEOLOGY_CODES)
    return df


# ---------------------------------------------------------------------------
# (b) Synthetic landslide label — documented rule, see module docstring.
# ---------------------------------------------------------------------------
LABEL_WEIGHTS = {'slope': 0.35, 'moisture': 0.30, 'rainfall': 0.20, 'terrain': 0.20}
SLOPE_NORM_DEG = 45.0        # slope_deg treated as "maximal" risk at/above this
MOISTURE_NORM_PCT = 100.0    # soil_moisture is already a 0-100 percentage
RAINFALL_NORM_MM = 150.0     # 24h rainfall treated as "maximal" risk at/above this
LABEL_NOISE_SIGMA = 0.05
LABEL_THRESHOLD = 0.55       # fixed cut, tuned below to give a plausible positive rate


def landslide_risk_score(df: pd.DataFrame, rng: np.random.Generator) -> np.ndarray:
    slope_component = np.clip(df['slope_deg'] / SLOPE_NORM_DEG, 0, 1)
    moisture_component = np.clip(df['soil_moisture'] / MOISTURE_NORM_PCT, 0, 1)
    rainfall_component = np.clip(df['rainfall_24h'] / RAINFALL_NORM_MM, 0, 1)
    terrain_component = 0.5 * df['land_cover'].map(LAND_COVER_RISK).to_numpy() \
        + 0.5 * df['geology'].map(GEOLOGY_RISK).to_numpy()

    score = (
        LABEL_WEIGHTS['slope'] * slope_component
        + LABEL_WEIGHTS['moisture'] * moisture_component
        + LABEL_WEIGHTS['rainfall'] * rainfall_component
        + LABEL_WEIGHTS['terrain'] * terrain_component
    )
    noise = rng.normal(0, LABEL_NOISE_SIGMA, size=len(df))
    return np.clip(score + noise, 0, 1)


FEATURES = [
    'slope_deg', 'elevation_m', 'land_cover_code', 'geology_code',
    'rainfall_1h', 'rainfall_3h', 'rainfall_6h', 'rainfall_12h', 'rainfall_24h',
    'soil_moisture', 'moisture_change_3h',
]
TARGET = 'landslide_synthetic_label'

train = pd.read_csv(DATA / 'M3_train.csv', parse_dates=['timestamp'])
val = pd.read_csv(DATA / 'M3_validation.csv', parse_dates=['timestamp'])
test = pd.read_csv(DATA / 'M3_test.csv', parse_dates=['timestamp'])

train = add_terrain_columns(train)
val = add_terrain_columns(val)
test = add_terrain_columns(test)

# Separate RNG per split so labeling is reproducible and one split's noise
# draws never depend on another split's size/order.
rng_train = np.random.default_rng(RANDOM_SEED)
rng_val = np.random.default_rng(RANDOM_SEED + 1)
rng_test = np.random.default_rng(RANDOM_SEED + 2)

train['landslide_risk_score'] = landslide_risk_score(train, rng_train)
val['landslide_risk_score'] = landslide_risk_score(val, rng_val)
test['landslide_risk_score'] = landslide_risk_score(test, rng_test)

train[TARGET] = (train['landslide_risk_score'] >= LABEL_THRESHOLD).astype(int)
val[TARGET] = (val['landslide_risk_score'] >= LABEL_THRESHOLD).astype(int)
test[TARGET] = (test['landslide_risk_score'] >= LABEL_THRESHOLD).astype(int)

X_train, y_train = train[FEATURES], train[TARGET]
X_val, y_val = val[FEATURES], val[TARGET]
X_test, y_test = test[FEATURES], test[TARGET]

model = RandomForestClassifier(
    n_estimators=300,
    max_depth=14,
    min_samples_leaf=3,
    class_weight='balanced_subsample',
    random_state=RANDOM_SEED,
    n_jobs=-1,
)
model.fit(X_train, y_train)

# Calibrate on the validation split only, same FrozenEstimator + sigmoid
# pattern as train_m3.py. Test remains untouched for final evaluation.
calibrator = CalibratedClassifierCV(FrozenEstimator(model), method='sigmoid')
calibrator.fit(X_val, y_val)

p_val = calibrator.predict_proba(X_val)[:, 1]
p_test = calibrator.predict_proba(X_test)[:, 1]

# Select an operating threshold on validation via F1, clipped to a sane
# prototype range — same approach as train_m3.py.
precision, recall, thresholds = precision_recall_curve(y_val, p_val)
f1s = 2 * precision[:-1] * recall[:-1] / np.clip(precision[:-1] + recall[:-1], 1e-12, None)
best_idx = int(np.nanargmax(f1s)) if len(f1s) else 0
best_threshold = float(thresholds[best_idx]) if len(thresholds) else 0.5
best_threshold = float(np.clip(best_threshold, 0.20, 0.80))


def metrics(y, p, threshold):
    pred = (p >= threshold).astype(int)
    tn, fp, fn, tp = confusion_matrix(y, pred, labels=[0, 1]).ravel()
    return {
        'threshold': threshold,
        'accuracy': float(accuracy_score(y, pred)),
        'precision': float(precision_score(y, pred, zero_division=0)),
        'recall': float(recall_score(y, pred, zero_division=0)),
        'f1': float(f1_score(y, pred, zero_division=0)),
        'roc_auc': float(roc_auc_score(y, p)) if len(set(y)) > 1 else None,
        'pr_auc': float(average_precision_score(y, p)) if len(set(y)) > 1 else None,
        'brier_score': float(brier_score_loss(y, p)),
        'tn': int(tn), 'fp': int(fp), 'fn': int(fn), 'tp': int(tp),
        'positive_rate': float(np.mean(y)),
    }


m_train = metrics(y_train, calibrator.predict_proba(X_train)[:, 1], best_threshold)
m_val = metrics(y_val, p_val, best_threshold)
m_test = metrics(y_test, p_test, best_threshold)

# Feature importance from the underlying RF.
imp = pd.DataFrame({'feature': FEATURES, 'importance': model.feature_importances_}) \
    .sort_values('importance', ascending=False)
imp.to_csv(REP / 'M4_feature_importance.csv', index=False)


def save_predictions(df, probs, split):
    out = df[['timestamp', 'station', 'station_id', 'land_cover', 'geology', TARGET]].copy()
    out['landslide_probability'] = probs
    out['predicted_event'] = (probs >= best_threshold).astype(int)
    out['risk_level'] = pd.cut(
        probs, bins=[-np.inf, .30, .60, .80, np.inf],
        labels=['LOW', 'MODERATE', 'HIGH', 'EXTREME'], right=False
    ).astype(str)
    out.to_csv(REP / f'M4_{split}_predictions.csv', index=False)


save_predictions(train, calibrator.predict_proba(X_train)[:, 1], 'train')
save_predictions(val, p_val, 'validation')
save_predictions(test, p_test, 'test')

# Calibration table.
if len(set(y_test)) > 1:
    cal_frac, cal_mean = calibration_curve(y_test, p_test, n_bins=10, strategy='quantile')
    pd.DataFrame({
        'mean_predicted_probability': cal_mean,
        'observed_frequency': cal_frac
    }).to_csv(REP / 'M4_test_calibration.csv', index=False)

# Save artifacts.
joblib.dump(model, ART / 'M4_random_forest.joblib')
joblib.dump(calibrator, ART / 'M4_calibrated_model.joblib')

metadata = {
    'model_version': 'M4-v1.0',
    'model_type': 'RandomForestClassifier + sigmoid probability calibration',
    'target': TARGET,
    'features': FEATURES,
    'categorical_encodings': {
        'land_cover': LAND_COVER_CODES,
        'geology': GEOLOGY_CODES,
    },
    'risk_thresholds': {'LOW': '<0.30', 'MODERATE': '0.30-<0.60', 'HIGH': '0.60-<0.80', 'EXTREME': '>=0.80'},
    'validation_selected_threshold': best_threshold,
    'random_seed': RANDOM_SEED,
    'data_is_synthetic': True,
    'label_is_synthetic': True,
    'label_rule': {
        'description': (
            'landslide_synthetic_label = 1 if a weighted combination of '
            'normalized slope, soil moisture, 24h rainfall, and a '
            'land_cover/geology terrain-risk factor (see landslide_risk_score() '
            'in train_landslide.py), plus Gaussian noise, is >= threshold. '
            'Not derived from any real landslide event data.'
        ),
        'weights': LABEL_WEIGHTS,
        'slope_norm_deg': SLOPE_NORM_DEG,
        'moisture_norm_pct': MOISTURE_NORM_PCT,
        'rainfall_24h_norm_mm': RAINFALL_NORM_MM,
        'noise_sigma': LABEL_NOISE_SIGMA,
        'label_threshold': LABEL_THRESHOLD,
        'land_cover_risk_weights': LAND_COVER_RISK,
        'geology_risk_weights': GEOLOGY_RISK,
    },
    'terrain_assignment_rule': (
        'land_cover/geology are derived deterministically per station from '
        'that station\'s own slope_deg/elevation_m via assign_terrain() in '
        'train_landslide.py — a stand-in for a real GIS land-cover/geology '
        'lookup, which this prototype does not have.'
    ),
    'splits': {'train_rows': len(train), 'validation_rows': len(val), 'test_rows': len(test)},
    'metrics': {'train': m_train, 'validation': m_val, 'test': m_test},
}
(ART / 'M4_model_metadata.json').write_text(json.dumps(metadata, indent=2), encoding='utf-8')
(REP / 'M4_metrics.json').write_text(json.dumps(metadata['metrics'], indent=2), encoding='utf-8')

# Human-readable report.
report = '# FloodGuard M4-v1.0 Training Report — Landslide Hazard Estimate\n\n'
report += (
    '> **SYNTHETIC LABEL — NOT REAL LANDSLIDE EVENT DATA.** Both the '
    'land_cover/geology terrain classes and the landslide_synthetic_label '
    'target used to train this model are generated by a documented rule '
    'in `train_landslide.py`, not observed landslide events. Metrics below '
    'show that the pipeline trains/evaluates correctly; they say nothing '
    'about real-world landslide prediction skill.\n\n'
)
report += '## Dataset\n\n'
report += (
    'Reuses M3\'s mock ml/data/M3_train.csv / M3_validation.csv / '
    'M3_test.csv splits (same rows, same chronological split boundaries — '
    'no leakage introduced). M4 never reads flash_flood_next_3h or any '
    'water-level column; it only uses terrain (slope_deg, elevation_m, '
    'and the synthesized land_cover/geology), rainfall windows, and '
    'soil_moisture.\n\n'
)
report += '## Where land_cover / geology come from\n\n'
report += (
    'The M3 dataset has no land_cover/geology columns. `assign_terrain()` '
    'derives them deterministically from each station\'s own slope_deg / '
    'elevation_m (steeper -> sparse_vegetation, higher elevation -> '
    'fractured_metamorphic, etc. — see the module docstring for the full '
    'rule). This is a stand-in for a real GIS terrain lookup.\n\n'
)
report += '## Where the landslide label comes from\n\n'
report += (
    f'`landslide_synthetic_label = 1` when '
    f'`{LABEL_WEIGHTS["slope"]}*norm(slope_deg) + {LABEL_WEIGHTS["moisture"]}*norm(soil_moisture) '
    f'+ {LABEL_WEIGHTS["rainfall"]}*norm(rainfall_24h) + {LABEL_WEIGHTS["terrain"]}*terrain_risk '
    f'+ noise(σ={LABEL_NOISE_SIGMA}) >= {LABEL_THRESHOLD}`, where terrain_risk averages a '
    'land_cover risk weight and a geology risk weight (both illustrative, not '
    'geotechnical). Full weights and normalization constants are stored in '
    '`M4_model_metadata.json` under `label_rule`. This rule is a stand-in for '
    'a real landslide inventory — treat it as a documented assumption, not '
    'ground truth.\n\n'
)
report += '## Split sizes\n\n'
report += f'- Train: {len(train):,}\n- Validation: {len(val):,}\n- Test: {len(test):,}\n\n'
report += f'## Selected validation threshold\n\n{best_threshold:.4f}\n\n'
for name, m in [('Train', m_train), ('Validation', m_val), ('Test', m_test)]:
    roc = f"{m['roc_auc']:.4f}" if m['roc_auc'] is not None else 'n/a (single class in split)'
    pr = f"{m['pr_auc']:.4f}" if m['pr_auc'] is not None else 'n/a (single class in split)'
    report += (
        f"## {name}\n\n"
        f"| Metric | Value |\n|---|---:|\n"
        f"| Accuracy | {m['accuracy']:.4f} |\n"
        f"| Precision | {m['precision']:.4f} |\n"
        f"| Recall | {m['recall']:.4f} |\n"
        f"| F1 | {m['f1']:.4f} |\n"
        f"| ROC-AUC | {roc} |\n"
        f"| PR-AUC | {pr} |\n"
        f"| Brier score | {m['brier_score']:.4f} |\n"
        f"| Positive rate | {m['positive_rate']:.4f} |\n"
        f"| TP | {m['tp']} |\n| FP | {m['fp']} |\n| FN | {m['fn']} |\n| TN | {m['tn']} |\n\n"
    )
report += (
    '## Risk mapping\n\n'
    'Probability is mapped to the same prototype LOW/MODERATE/HIGH/EXTREME '
    'bands used elsewhere in FloodGuard (0.30 / 0.60 / 0.80 cuts). These are '
    'visualization thresholds, not official hazard-assessment thresholds.\n\n'
)
report += (
    '## Independence from M3\n\n'
    'This module never reads `flash_flood_next_3h`, never calls '
    '`runM3Prediction()`, and nothing it writes is read by the Zone Engine '
    'or the Alert Engine. `GET /api/m4/hazard` is additive only — see '
    '`routes/m4.js`.\n\n'
)
report += (
    '## Important limitation\n\n'
    'The terrain classes, the label, and therefore every metric above are '
    'synthetic. This demonstrates that the M4 pipeline trains, calibrates, '
    'and serves predictions correctly end-to-end; it does not establish '
    'real-world landslide prediction performance.\n'
)
(REP / 'M4_training_report.md').write_text(report, encoding='utf-8')

print(json.dumps({
    'threshold': best_threshold,
    'test': m_test,
    'top_features': imp.head(10).to_dict('records'),
}, indent=2))
