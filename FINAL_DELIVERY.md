# FloodGuard M3 — Final Delivery

## Completed phases

### Phase 0 — Architecture + Dataset Audit
Reviewed the supplied architecture and existing CSV; identified that the original CSV's `target_water_level_3h` is a future water-level target and is not the M3 flash-flood classification target.

### Phase 1 — Data Cleaning & Validation
Created the mock M3 dataset with consistent hourly timestamps, station identifiers, numeric features and no missing feature values.

### Phase 2 — Target Engineering
Created `flash_flood_next_3h` for the mock dataset. It is synthetic and must be replaced by verified historical flood-event labels for real deployment.

### Phase 3 — Feature Engineering
Implemented rainfall accumulation, soil moisture, moisture trend, water-level lags/changes, rise rate, terrain and historical-context features.

### Phase 4 — Leakage Control + Time Split
Excluded future-looking inputs and used chronological 70/15/15 train/validation/test splits.

### Phase 5 — M3 Training
Trained Random Forest M3-v1.0 and saved both the base and calibrated model artifacts.

### Phase 6 — Evaluation + Calibration
Calibrated probabilities on the validation period, selected a validation decision threshold and evaluated on the untouched test period.

### Phase 7 — Risk Decision Engine
Implemented the documented prototype probability bands: LOW <0.30, MODERATE 0.30–<0.60, HIGH 0.60–<0.80, EXTREME >=0.80.

### Phase 8 — API + Dashboard Integration
Added authenticated Node.js endpoints for model health, demo prediction and custom prediction. The dashboard fetches the M3 demo prediction after login.

## Mock test result

Precision 0.9330; Recall 0.6111; F1 0.7385; ROC-AUC 0.8423; PR-AUC 0.7538; Brier 0.0583.

These are synthetic-data development metrics only.

## Main model artifact

`ml/artifacts/M3_calibrated_model.joblib`

## Run

```bash
python -m pip install -r ml/requirements.txt
python ml/scripts/train_m3.py
npm install
npm start
```

Configure MySQL environment variables as described in `README.md` before starting the web application.


## Final hardening pass

The final demo hardening adds rate limiting, security headers, CSRF/origin protection, sanitized error handling, authenticated sensitive endpoints, persistent Python inference for M3/M4/M5, an authenticated `/api/system/versions` audit endpoint, and a manual end-to-end/degraded-confidence test plan.

### Safety / validation disclaimer

**All data used by this prototype is synthetic/simulated.** Thresholds and zone radii are illustrative and have **not been validated against real flood or landslide events**. FloodGuard is a **decision-support prototype, not an operational emergency warning system**. Its outputs must not be treated as authoritative emergency warnings or used as the sole basis for life-safety decisions.

### Model/module versions

Use `GET /api/system/versions` after login. It reports M1/M2 module versions plus the model versions and artifacts for M3, M4 and M5.

### Persistent inference architecture

Node starts `ml/inference_service.py` once during server startup. The Python process loads the M3, M4 and M5 artifacts once and handles newline-delimited JSON requests until shutdown. Node no longer spawns a new Python interpreter for each M3/M4/M5 request.

### Security notes

- All `/api/*` endpoints are rate limited.
- `/api/auth/*` and `/api/ml/predict` use stricter limits.
- Helmet provides CSP, X-Frame-Options/frame-ancestors, X-Content-Type-Options and related headers.
- State-changing API requests use SameSite session cookies plus same-origin Origin/Referer checks for CSRF defense; login/signup are excluded.
- Server errors are logged server-side. Client responses do not expose exception messages or stack traces.
- Location, zones, geofence, alerts, M1, M2, M4, M5 and ML prediction routes are mounted behind `requireAuth`.
