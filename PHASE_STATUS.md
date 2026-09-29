# FloodGuard M3 Phase Status

## Completed in this package

- Phase 0: Architecture + dataset audit
- Phase 1: Data cleaning/validation for mock dataset
- Phase 2: M3 target engineering (`flash_flood_next_3h`)
- Phase 3: Feature engineering
- Phase 4: Leakage control + chronological train/validation/test split
- Phase 5: Random Forest M3-v1.0 training
- Phase 6: Evaluation + probability calibration
- Phase 7: Prototype risk decision engine
- Phase 8: Node.js API + dashboard demo integration
- Phase 9: Zone Engine — configurable Red/Yellow/Green risk rings (`services/zoneEngine.js`, `config/zonePolicy.json`, `GET /api/zones`) derived from M3's `risk_level` band and the location's latest water-level rise rate, with a degraded-confidence fallback and Risk-map rendering
- Phase 10: Geofencing + Alert Engine — `POST /api/geofence/check` resolves a user's live position against the Zone Engine's radii, persists per-user zone state (`user_zone_state`), and detects transitions. `services/alertEngine.js` sends SMS/email on a Red or Yellow *upgrade* transition (never on a downgrade or an unchanged zone), enforcing a configurable per-user+location+zone cooldown (`config/alertPolicy.json`) and logging every attempt — sent, failed, or skipped by cooldown — to `alerts`. `lib/notifyProvider.js` is a placeholder SMS/email provider (mock; swap for Twilio/SendGrid without touching alertEngine.js). User-facing: notification preferences form and Alert History panel on `overview.html`, backed by `/api/user/preferences` and `/api/alerts`.
- Phase M1: Water-Level Vision Module (prototype, supporting module) — `ml/m1/estimate_level.py` estimates a waterline from one calibrated camera frame using a manually-placed pixel-to-metre reference line plus simple edge detection (`ml/m1/calibration/FORMAT.md` documents the config; no trained CV model, no real CCTV feed yet — see `ml/m1/make_mock_images.py` for the synthetic stills this runs against). `services/m1Ingest.js` compares each estimate against prior `water_level_readings` rows to compute `change_10m`/`change_30m`/`change_1h` and `rise_rate_m_per_hr`, then inserts a row with `quality_status = 'estimated'` always — never `'good'` — which is what keeps this module's output from ever reaching the Zone Engine's rise-rate adjustment or the M3 probability; it only surfaces via `GET /api/m1/latest` and the M1 card on `overview.html`. See `ml/m1/README.md` for the full safety rationale and known limits.

## Caveat (Phase 10 addition)

Phase 10 was built on top of this package's existing Zone Engine, but this
package did not yet contain a geofencing layer connecting a user's live
position to those zone radii, or a `user_zone_state` table — despite being
a prerequisite the Alert Engine needs. `services/geofenceEngine.js` and
`routes/geofence.js` were added to fill that gap. If a geofencing module
already exists elsewhere in your broader FloodGuard codebase, reconcile it
with this one rather than running both.

Phases 0–8 are implemented for the synthetic/mock dataset. This is an engineering-complete MVP pipeline, not a validated real-world emergency warning system. Real deployment requires verified Chamoli data, confirmed event labels, operational threshold calibration, and authority validation.
