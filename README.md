# FloodGuard Secure MySQL Session Login

## Setup

1. Make sure MySQL Server is running.
2. Create the database once:

```sql
CREATE DATABASE IF NOT EXISTS floodguard;
```

3. Open `.env` and replace:

```text
DB_PASSWORD=YOUR_MYSQL_PASSWORD
```

with your actual MySQL root password. Do not include extra quotes unless your password itself requires them.

4. In the project folder run:

```bash
npm install
npm run dev
```

5. Open:

```text
http://localhost:5000
```

## Important fix in this version

Older FloodGuard database installations could have a different type for `users.id`, causing this MySQL error:

`Referencing column 'userId' and referenced column 'id' in foreign key constraint are incompatible`

This version automatically reads the actual `users.id` type and creates `sessions.userId` with the exact same type. If an old incompatible `sessions` table exists, it is recreated. User accounts in the `users` table are preserved; only old session records may be removed.


## Data layer (rainfall / soil / water / M3 tables)

The tables the rest of the app builds on (locations, sensor readings,
terrain, historical events, model registry) are set up separately from the
auth tables above. See [`db/README.md`](db/README.md) — short version:

```bash
npm run db:migrate   # creates the tables (safe to re-run)
npm run db:seed      # adds 3 example locations
```

## Dashboard features added
- Functional Settings page with saved monitoring preferences and notification toggles.
- Functional Support page with FAQ and support-request form.
- Logout button available from the dashboard sidebar.
- Zone Engine: after an M3 prediction, `GET /api/zones` turns it into Red/Yellow/Green risk rings drawn on the Risk map. See the "Zone Engine" section of [`README_M3_MVP.md`](README_M3_MVP.md) for how it's calculated and how to tune `config/zonePolicy.json`.


## Final hardening / demo safety

This delivery includes:
- `helmet` security headers including CSP, frame protection and MIME-sniffing protection.
- `express-rate-limit` on every `/api/*` route, with tighter windows for authentication and `/api/ml/predict`.
- CSRF protection for state-changing API requests using `SameSite=Lax` session cookies plus same-origin `Origin`/`Referer` validation. Login and signup are excluded because they establish the session. Non-browser tooling may omit these browser headers; it cannot receive the browser's session cookie cross-site.
- Generic client-facing errors. Internal exception details are logged server-side and are not returned in API error bodies.
- Authentication protection on location, zone, geofence, alert, M1, M2, M4, M5 and ML prediction endpoints.
- A persistent Python inference service (`ml/inference_service.py`) that loads M3/M4/M5 artifacts once and serves newline-delimited requests from Node.
- `GET /api/system/versions` for model/module-version auditability (authenticated).
- Manual hardening/E2E test plan in `test/manual_hardening_e2e.md`.

### Demo disclaimer

**All data in this project is synthetic/simulated.** Thresholds, zone radii, model outputs, fallback values and other decision rules are illustrative and have **not** been validated against real flood/landslide events. FloodGuard is a **decision-support prototype, not an operational emergency warning system**. It must not be used as the sole basis for evacuation, public warning, or life-safety decisions.

The M1 module is a calibration/edge-detection prototype and M2 is rule-based; they do not have trained model artifacts. M3/M4/M5 are trained/evaluated on synthetic stand-in data and are not operationally validated.
