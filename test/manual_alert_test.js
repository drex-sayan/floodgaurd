// test/manual_alert_test.js
//
// Manual/integration test for the Alert Engine (services/alertEngine.js,
// services/geofenceEngine.js, routes/geofence.js) and lib/notifyProvider.js.
// Runs a small standalone Express app wired to the real geofence route
// against an in-memory fake DB pool, so it can be run with:
//
//   node test/manual_alert_test.js
//
// ...without needing a live MySQL instance. Follows the same fake-pool
// pattern as test/manual_zone_test.js.
//
// Scenario (one user, one EXTREME-risk location, no auth middleware since
// this targets the geofence/alert logic itself — server.js otherwise mounts
// this behind requireAuth):
//
//   1. User's first ping lands inside the Red ring.
//      outside -> red is a transition AND an upgrade -> alert fires.
//      Expect: current_zone red, transitioned true, delivery_status 'sent',
//      channel 'both' (user has SMS + email enabled).
//
//   2. User's next ping has drifted out to the Yellow ring.
//      red -> yellow is a transition but a DOWNGRADE -> no alert at all.
//      Expect: transitioned true, alert === null.
//
//   3. User's next ping is back inside the Red ring (e.g. GPS noise at the
//      ring boundary — a realistic way to re-enter Red minutes later).
//      yellow -> red is a transition AND an upgrade -> alert engine runs,
//      but the cooldown from step 1 is still active.
//      Expect: current_zone red, transitioned true, delivery_status
//      'skipped_cooldown', cooldown_until unchanged from step 1's alert.
//
//   4. Direct call into alertEngine.evaluateAndNotify for a 'green' zone
//      confirms it never writes to `alerts` at all.

const express = require("express");
const geofenceRoutes = require("../routes/geofence");
const alertEngine = require("../services/alertEngine");
const zonePolicy = require("../config/zonePolicy.json");
const alertPolicy = require("../config/alertPolicy.json");

const USER_ID = 42;
const LOCATION_ID = 1;

// ---- Fake DB pool, mimicking the subset of mysql2/promise used by
// routes/geofence.js and services/alertEngine.js ----
function createFakePool() {
  const locations = [
    { location_id: LOCATION_ID, latitude: 30.4032, longitude: 79.3212, place_name: "Chamoli", region: "Uttarakhand, India" }
  ];
  const zoneState = new Map(); // `${userId}:${locationId}` -> zone
  const notifPrefs = new Map(); // userId -> prefs row
  const alerts = []; // { alert_id, user_id, location_id, zone, channel, delivery_status, cooldown_until, issued_at }
  let nextAlertId = 1;

  // Seed this user's notification prefs: both channels enabled.
  notifPrefs.set(USER_ID, {
    sms_enabled: 1,
    email_enabled: 1,
    phone_number: "+15550001111",
    email_address: "demo.user@example.com"
  });

  return {
    async execute(sql, params) {
      const s = sql.replace(/\s+/g, " ").trim();

      if (s.startsWith("SELECT location_id, latitude, longitude, place_name, region FROM locations")) {
        const [id] = params;
        return [locations.filter((r) => r.location_id === id)];
      }

      if (s.startsWith("SELECT level_m, change_1h")) {
        // No water_level_readings row for this location — Zone Engine falls
        // back to base radii with degraded_confidence: true. Irrelevant to
        // what this test is checking, so intentionally left empty.
        return [[]];
      }

      if (s.startsWith("SELECT current_zone FROM user_zone_state")) {
        const [userId, locationId] = params;
        const zone = zoneState.get(`${userId}:${locationId}`);
        return [zone ? [{ current_zone: zone }] : []];
      }

      if (s.startsWith("INSERT INTO user_zone_state")) {
        const [userId, locationId, zone] = params;
        zoneState.set(`${userId}:${locationId}`, zone);
        return [{ insertId: 0 }];
      }

      if (s.startsWith("SELECT sms_enabled, email_enabled, phone_number, email_address FROM user_notification_prefs")) {
        const [userId] = params;
        const prefs = notifPrefs.get(userId);
        return [prefs ? [prefs] : []];
      }

      if (s.startsWith("SELECT alert_id, delivery_status, cooldown_until FROM alerts")) {
        const [userId, locationId, zone] = params;
        const match = alerts
          .filter((a) => a.user_id === userId && a.location_id === locationId && a.zone === zone && a.delivery_status === "sent")
          .sort((a, b) => b.issued_at - a.issued_at)[0];
        return [match ? [match] : []];
      }

      if (s.startsWith("INSERT INTO alerts")) {
        const [userId, locationId, zone, channel, modelVersion, evidenceSummary, deliveryStatus, cooldownUntil] = params;
        const row = {
          alert_id: nextAlertId++,
          user_id: userId,
          location_id: locationId,
          zone,
          channel,
          model_version: modelVersion,
          evidence_summary: evidenceSummary,
          delivery_status: deliveryStatus,
          cooldown_until: cooldownUntil,
          issued_at: Date.now()
        };
        alerts.push(row);
        return [{ insertId: row.alert_id }];
      }

      throw new Error("Unhandled fake SQL: " + s);
    },
    // Exposed for assertions below, not part of the real mysql2 API.
    _debug: { alerts, zoneState }
  };
}

async function main() {
  const pool = createFakePool();
  const app = express();
  app.use(express.json());
  // No requireAuth here — attach a fixed req.user the way server.js's real
  // middleware would after verifying a session cookie. This test targets
  // the geofence/alert logic itself.
  app.use((req, res, next) => {
    req.user = { id: USER_ID, email: "demo.user@example.com" };
    next();
  });
  app.use("/api/geofence", geofenceRoutes(() => pool));

  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}/api/geofence/check`;

  let failures = 0;
  function check(label, cond, detail) {
    const ok = !!cond;
    console.log(`${ok ? "PASS" : "FAIL"} — ${label}${detail ? " :: " + detail : ""}`);
    if (!ok) failures++;
  }

  console.log(`\nUsing zone_policy_version: ${zonePolicy.zone_policy_version}, alert_policy_version: ${alertPolicy.alert_policy_version}`);
  const extremeBase = zonePolicy.base_radius_km.EXTREME; // { red: 2.0, yellow: 5.5, green: 10.0 }
  console.log(`EXTREME base radii (no water-level adjustment, none seeded): red=${extremeBase.red}km yellow=${extremeBase.yellow}km green=${extremeBase.green}km`);

  const center = { latitude: 30.4032, longitude: 79.3212 };
  // ~0.10 deg latitude ≈ 11.1km — used below to place the user at a known
  // approximate distance from the location center without needing a real
  // geodesy library in the test itself.
  const KM_PER_DEG_LAT = 111.0;

  async function ping(latOffsetDeg, label) {
    const body = {
      location_id: LOCATION_ID,
      latitude: center.latitude + latOffsetDeg,
      longitude: center.longitude,
      risk_level: "EXTREME",
      probability: 0.93
    };
    const r = await fetch(base, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    const data = await r.json();
    console.log(`\n=== ${label} (~${(latOffsetDeg * KM_PER_DEG_LAT).toFixed(2)}km offset) ===`);
    console.log(JSON.stringify(data, null, 2));
    return { status: r.status, data };
  }

  console.log("\n--- Step 1: user's first ping lands inside the Red ring ---");
  let step1 = await ping(0, "Step 1: enter RED");
  check("HTTP 200", step1.status === 200);
  check("current_zone is red", step1.data.current_zone === "red");
  check("previous_zone is outside (first-ever ping)", step1.data.previous_zone === "outside");
  check("transitioned is true", step1.data.transitioned === true);
  check("alert fired (not null)", step1.data.alert !== null);
  check("delivery_status is 'sent'", step1.data.alert && step1.data.alert.deliveryStatus === "sent");
  check("channel is 'both' (SMS + email both enabled)", step1.data.alert && step1.data.alert.channel === "both");

  console.log("\n--- Step 2: user drifts out to the Yellow ring (a downgrade) ---");
  // ~3.3km offset: inside yellow (5.5km) but outside red (2.0km).
  let step2 = await ping(3.3 / KM_PER_DEG_LAT, "Step 2: drift to YELLOW");
  check("HTTP 200", step2.status === 200);
  check("current_zone is yellow", step2.data.current_zone === "yellow");
  check("previous_zone is red", step2.data.previous_zone === "red");
  check("transitioned is true", step2.data.transitioned === true);
  check("no alert on a downgrade (alert is null)", step2.data.alert === null);

  console.log("\n--- Step 3: user re-enters the Red ring shortly after (cooldown still active) ---");
  let step3 = await ping(0.5 / KM_PER_DEG_LAT, "Step 3: re-enter RED within cooldown");
  check("HTTP 200", step3.status === 200);
  check("current_zone is red", step3.data.current_zone === "red");
  check("previous_zone is yellow", step3.data.previous_zone === "yellow");
  check("transitioned is true (yellow -> red is an upgrade)", step3.data.transitioned === true);
  check("alert engine ran (not null)", step3.data.alert !== null);
  check(
    "delivery_status is 'skipped_cooldown'",
    step3.data.alert && step3.data.alert.deliveryStatus === "skipped_cooldown"
  );
  check(
    "cooldown_until matches step 1's alert (no new cooldown window started)",
    step3.data.alert && step1.data.alert && step3.data.alert.cooldownUntil === step1.data.alert.cooldownUntil
  );

  console.log("\n--- Step 4: alertEngine.evaluateAndNotify() is a no-op for non-alertable zones ---");
  const beforeCount = pool._debug.alerts.length;
  const greenResult = await alertEngine.evaluateAndNotify(pool, {
    userId: USER_ID,
    locationId: LOCATION_ID,
    zone: "green",
    placeName: "Chamoli"
  });
  check("returns { skipped: true }", greenResult.skipped === true);
  check("no new row written to `alerts`", pool._debug.alerts.length === beforeCount);

  console.log(`\nTotal alerts logged: ${pool._debug.alerts.length} (expected 2: one 'sent', one 'skipped_cooldown')`);
  check("exactly 2 alerts rows total", pool._debug.alerts.length === 2);
  check(
    "row 1 is 'sent', row 2 is 'skipped_cooldown'",
    pool._debug.alerts[0].delivery_status === "sent" && pool._debug.alerts[1].delivery_status === "skipped_cooldown"
  );

  console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : failures + " CHECK(S) FAILED"}`);
  server.close();
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
