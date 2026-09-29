# FloodGuard — Final Manual E2E + Hardening Test

Run the app with MySQL and the Python dependencies installed. Use a seeded covered location and an uncovered location.

## A. Main happy path
1. Open `/login`.
2. Log in with a demo account.
3. Select a **covered** location.
4. Run **M3 prediction**.
5. Confirm the response has a `model_version`, probability/risk level, and no server stack trace.
6. Confirm the Risk Map / Zones view displays the corresponding zone rings.
7. Place/choose the browser position inside the user's calculated zone and run the geofence check.
8. Confirm the UI shows the user's own `current_zone`.
9. Move/choose a position that causes an upgrade into Yellow or Red and trigger the geofence check.
10. Confirm an alert attempt is shown/recorded.
11. Open Alert History and confirm the new alert entry appears.

## B. Coverage safety path
1. Select an **uncovered** location.
2. Attempt M3 prediction through the normal UI.
3. Confirm the UI explicitly says **prediction unavailable / model coverage unavailable**.
4. Confirm it does **not** show a false LOW/SAFE/green result.

## C. Degraded-confidence path
1. For a covered location, temporarily make the latest water-level, rainfall, or soil-moisture reading stale/missing (or use the project's existing synthetic test fixtures).
2. Run M3/M5/zone evaluation.
3. Confirm the response contains `degraded_confidence: true` (and a reason/freshness status where applicable).
4. Confirm the UI shows a degraded/uncertain state, **not** a normal green/healthy result.
5. Restore the synthetic readings.

## D. Security smoke checks
- `GET /api/system/versions` without a session -> `401`.
- `GET /api/zones...` without a session -> `401`.
- `POST /api/ml/predict` without a session -> `401` (or CSRF/origin rejection before auth, depending on request headers).
- Send a cross-origin state-changing request with an invalid Origin -> `403`.
- Inspect response headers: CSP, `X-Frame-Options`/frame protection, and `X-Content-Type-Options: nosniff`.
- Repeatedly call `/api/ml/predict` and confirm the tighter rate limit eventually returns `429`.
- Trigger a server-side error and confirm the client sees only a generic message; server logs contain diagnostic details.

## E. Persistent inference check
1. Start the Node server.
2. Confirm startup logs show the ML service starts once.
3. Run several M3/M4/M5 requests.
4. Confirm the server does not spawn a new Python process for each request.
5. Confirm `/api/system/versions` reports all module/model versions.
