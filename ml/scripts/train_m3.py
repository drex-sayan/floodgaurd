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
from sklearn.inspection import permutation_importance
from sklearn.frozen import FrozenEstimator

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / 'data'
ART = ROOT / 'artifacts'
REP = ROOT / 'reports'
ART.mkdir(exist_ok=True); REP.mkdir(exist_ok=True)

FEATURES = [
    'station_id','latitude','longitude','elevation_m','slope_deg',
    'rainfall_1h','rainfall_3h','rainfall_6h','rainfall_12h','rainfall_24h',
    'soil_moisture','moisture_change_3h',
    'water_level_m','water_level_lag1h','water_level_lag3h','water_level_lag6h',
    'water_level_change_1h','water_level_change_3h','rise_rate_m_per_hour',
    'recent_event_count','event_proximity_km'
]
TARGET = 'flash_flood_next_3h'

train = pd.read_csv(DATA/'M3_train.csv', parse_dates=['timestamp'])
val = pd.read_csv(DATA/'M3_validation.csv', parse_dates=['timestamp'])
test = pd.read_csv(DATA/'M3_test.csv', parse_dates=['timestamp'])

X_train, y_train = train[FEATURES], train[TARGET]
X_val, y_val = val[FEATURES], val[TARGET]
X_test, y_test = test[FEATURES], test[TARGET]

model = RandomForestClassifier(
    n_estimators=350,
    max_depth=16,
    min_samples_leaf=3,
    class_weight='balanced_subsample',
    random_state=42,
    n_jobs=-1,
)
model.fit(X_train, y_train)

# Calibrate on the validation period only. Test remains untouched for final evaluation.
calibrator = CalibratedClassifierCV(FrozenEstimator(model), method='sigmoid')
calibrator.fit(X_val, y_val)

p_val = calibrator.predict_proba(X_val)[:,1]
p_test = calibrator.predict_proba(X_test)[:,1]

# Select a validation threshold using F1, while preferring reasonable recall.
precision, recall, thresholds = precision_recall_curve(y_val, p_val)
valid = thresholds > 0
f1s = 2*precision[:-1]*recall[:-1]/np.clip(precision[:-1]+recall[:-1], 1e-12, None)
# Maximize F1; if ties, prefer higher recall.
best_idx = int(np.nanargmax(f1s))
best_threshold = float(thresholds[best_idx])

# Keep threshold in a sensible operational range for a prototype.
best_threshold = float(np.clip(best_threshold, 0.20, 0.80))

def metrics(y, p, threshold):
    pred = (p >= threshold).astype(int)
    tn, fp, fn, tp = confusion_matrix(y, pred, labels=[0,1]).ravel()
    return {
        'threshold': threshold,
        'accuracy': float(accuracy_score(y, pred)),
        'precision': float(precision_score(y, pred, zero_division=0)),
        'recall': float(recall_score(y, pred, zero_division=0)),
        'f1': float(f1_score(y, pred, zero_division=0)),
        'roc_auc': float(roc_auc_score(y, p)),
        'pr_auc': float(average_precision_score(y, p)),
        'brier_score': float(brier_score_loss(y, p)),
        'tn': int(tn), 'fp': int(fp), 'fn': int(fn), 'tp': int(tp),
        'positive_rate': float(np.mean(y)),
    }

m_train = metrics(y_train, calibrator.predict_proba(X_train)[:,1], best_threshold)
m_val = metrics(y_val, p_val, best_threshold)
m_test = metrics(y_test, p_test, best_threshold)

# Feature importance from the underlying RF.
imp = pd.DataFrame({'feature': FEATURES, 'importance': model.feature_importances_}).sort_values('importance', ascending=False)
imp.to_csv(REP/'feature_importance.csv', index=False)

# Save predictions for audit/error analysis.
def save_predictions(df, probs, split):
    out = df[['timestamp','station','station_id',TARGET]].copy()
    out['flood_probability'] = probs
    out['predicted_event'] = (probs >= best_threshold).astype(int)
    out['risk_level'] = pd.cut(
        probs, bins=[-np.inf, .30, .60, .80, np.inf],
        labels=['LOW','MODERATE','HIGH','EXTREME'], right=False
    ).astype(str)
    out.to_csv(REP/f'{split}_predictions.csv', index=False)

save_predictions(train, calibrator.predict_proba(X_train)[:,1], 'train')
save_predictions(val, p_val, 'validation')
save_predictions(test, p_test, 'test')

# Calibration table.
cal_frac, cal_mean = calibration_curve(y_test, p_test, n_bins=10, strategy='quantile')
pd.DataFrame({'mean_predicted_probability': cal_mean, 'observed_frequency': cal_frac}).to_csv(REP/'test_calibration.csv', index=False)

# Save artifacts.
joblib.dump(model, ART/'M3_random_forest.joblib')
joblib.dump(calibrator, ART/'M3_calibrated_model.joblib')

metadata = {
    'model_version':'M3-v1.0',
    'model_type':'RandomForestClassifier + sigmoid probability calibration',
    'target':TARGET,
    'prediction_window':'next 1-3 hours',
    'features':FEATURES,
    'risk_thresholds': {'LOW':'<0.30','MODERATE':'0.30-<0.60','HIGH':'0.60-<0.80','EXTREME':'>=0.80'},
    'validation_selected_threshold':best_threshold,
    'random_seed':42,
    'data_is_synthetic':True,
    'splits': {'train_rows':len(train),'validation_rows':len(val),'test_rows':len(test)},
    'metrics': {'train':m_train,'validation':m_val,'test':m_test}
}
(ART/'model_metadata.json').write_text(json.dumps(metadata, indent=2), encoding='utf-8')
(REP/'metrics.json').write_text(json.dumps(metadata['metrics'], indent=2), encoding='utf-8')

# Human-readable report.
report = f'''# FloodGuard M3-v1.0 Training Report\n\nDataset: synthetic/mock\nTarget: {TARGET}\nPrediction window: next 1–3 hours\n\n'''
report += '## Split sizes\n\n'
report += f'- Train: {len(train):,}\n- Validation: {len(val):,}\n- Test: {len(test):,}\n\n'
report += f'## Selected validation threshold\n\n{best_threshold:.4f}\n\n'
for name, m in [('Train',m_train),('Validation',m_val),('Test',m_test)]:
    report += f'''## {name}\n\n| Metric | Value |\n|---|---:|\n| Accuracy | {m['accuracy']:.4f} |\n| Precision | {m['precision']:.4f} |\n| Recall | {m['recall']:.4f} |\n| F1 | {m['f1']:.4f} |\n| ROC-AUC | {m['roc_auc']:.4f} |\n| PR-AUC | {m['pr_auc']:.4f} |\n| Brier score | {m['brier_score']:.4f} |\n| TP | {m['tp']} |\n| FP | {m['fp']} |\n| FN | {m['fn']} |\n| TN | {m['tn']} |\n\n'''
report += '## Risk mapping\n\nProbability is mapped to the prototype LOW/MODERATE/HIGH/EXTREME bands defined in the architecture. These are visualization thresholds, not official emergency thresholds.\n\n'
report += '## Important limitation\n\nThe dataset and target are synthetic. Metrics demonstrate that the pipeline trains and evaluates correctly; they do not establish real-world flood prediction performance.\n'
(REP/'M3_training_report.md').write_text(report, encoding='utf-8')

print(json.dumps({'threshold':best_threshold,'test':m_test,'top_features':imp.head(10).to_dict('records')}, indent=2))
