// test/manual_zone_test.js
//
// Manual/integration test for the Zone Engine (services/zoneEngine.js +
// routes/zones.js). Runs a small standalone Express app wired to the real
// zone route against an in-memory fake DB pool, so it can be run with:
//
//   node test/manual_zone_test.js
//
// ...without needing a live MySQL instance. Covers:
//   1. HIGH risk + fresh/good water level under the lowest rise-rate tier
//      -> base HIGH radii, no adjustment, degraded_confidence: false.
//   2. EXTREME risk + fresh/good water level crossing the top rise-rate
//      tier -> widened radii, degraded_confidence: false.
//   3. MODERATE risk + stale water level -> falls back to base MODERATE
//      radii, degraded_confidence: true.
//   4. LOW risk + no water_level_readings row at all -> base LOW radii,
//      degraded_confidence: true, reason 'no_water_level_data'.
//   5. Invalid risk_level -> 400.
//   6. Unknown location_id -> 404.

const express = require("express");
const zoneRoutes = require("../routes/zones");
const policy = require("../config/zonePolicy.json");

function minutesAgoIso(minutes) {
  return new Date(Date.now() - minutes * 60 * 1000).toISOString().slice(0, 19).replace("T", " ");
}

// ---- Fake DB pool, mimicking the subset of mysql2/promise used by routes/zones.js ----
function createFakePool({ locations, waterLevels }) {
  return {
    async execute(sql, params) {
      const s = sql.replace(/\s+/g, " ").trim();

      if (s.startsWith("SELECT location_id, latitude, longitude, place_name, region FROM locations")) {
        const [id] = params;
        return [locations.filter((r) => r.location_id === id)];
      }

      if (s.startsWith("SELECT level_m, change_1h, change_3h, rise_rate_m_per_hr")) {
        const [id] = params;
        const rows = waterLevels
          .filter((r) => r.location_id === id)
          .sort((a, b) => (a.timestamp < b.timestamp ? 1 : -1));
        return [rows.slice(0, 1)];
      }

      throw new Error("Unhandled fake SQL: " + s);
    }
  };
}

const LOCATIONS = [
  { location_id: 1, latitude: 30.4032, longitude: 79.3212, place_name: "Chamoli", region: "Uttarakhand, India" },
  { location_id: 2, latitude: 30.55, longitude: 79.4, place_name: "Test Ward B", region: "Uttarakhand, India" },
  { location_id: 3, latitude: 30.6, longitude: 79.45, place_name: "Test Ward C", region: "Uttarakhand, India" },
  { location_id: 4, latitude: 30.65, longitude: 79.5, place_name: "Test Ward D", region: "Uttarakhand, India" }
];

const WATER_LEVELS = [
  // Location 1: fresh + good, rise rate 0.12 -> lowest tier only
  { location_id: 1, level_m: 440.3, change_1h: 0.05, change_3h: 0.15, rise_rate_m_per_hr: 0.12, timestamp: minutesAgoIso(5), quality_status: "good" },
  // Location 2: fresh + good, rise rate 0.62 -> top tier
  { location_id: 2, level_m: 441.1, change_1h: 0.5, change_3h: 1.2, rise_rate_m_per_hr: 0.62, timestamp: minutesAgoIso(3), quality_status: "good" },
  // Location 3: stale (older than max_data_age_minutes) despite good quality + high rise rate
  { location_id: 3, level_m: 439.9, change_1h: 0.6, change_3h: 1.4, rise_rate_m_per_hr: 0.7, timestamp: minutesAgoIso(180), quality_status: "good" }
  // Location 4: no water_level_readings row at all (intentionally absent)
];

async function main() {
  const pool = createFakePool({ locations: LOCATIONS, waterLevels: WATER_LEVELS });
  const app = express();
  app.use(express.json());
  // No auth middleware here — this test targets the zone-computation logic
  // itself, which server.js otherwise mounts behind requireAuth.
  app.use("/api/zones", zoneRoutes(() => pool));

  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}/api/zones`;

  let failures = 0;
  function check(label, cond, detail) {
    const ok = !!cond;
    console.log(`${ok ? "PASS" : "FAIL"} — ${label}${detail ? " :: " + detail : ""}`);
    if (!ok) failures++;
  }

  console.log(`\nUsing zone_policy_version: ${policy.zone_policy_version}`);
  const highBase = policy.base_radius_km.HIGH;
  const extremeBase = policy.base_radius_km.EXTREME;
  const moderateBase = policy.base_radius_km.MODERATE;
  const lowBase = policy.base_radius_km.LOW;
  const topTier = policy.water_level_rise_adjustment.tiers[policy.water_level_rise_adjustment.tiers.length - 1];

  console.log("\n=== Case 1: HIGH risk, fresh/good water level, rise rate below lowest tier's neighbor (0.12) ===");
  let r = await fetch(`${base}?location_id=1&risk_level=HIGH&probability=0.71`);
  let z1 = await r.json();
  console.log(z1);
  check("HTTP 200", r.status === 200);
  check("degraded_confidence is false", z1.degraded_confidence === false);
  check("red radius matches HIGH base × lowest tier multiplier (1.20)", z1.red_radius_km === Math.round(highBase.red * 1.2 * 100) / 100);
  check("flood_probability is echoed back unchanged", z1.flood_probability === 0.71);
  check("zone_policy_version is present", z1.zone_policy_version === policy.zone_policy_version);

  console.log("\n=== Case 2: EXTREME risk, fresh/good water level, rise rate crosses the top tier (0.62) ===");
  r = await fetch(`${base}?location_id=2&risk_level=EXTREME&probability=0.94`);
  let z2 = await r.json();
  console.log(z2);
  check("degraded_confidence is false", z2.degraded_confidence === false);
  check("water_level_adjustment_applied is true", z2.water_level_adjustment_applied === true);
  check(
    "red radius matches EXTREME base × top-tier multiplier",
    z2.red_radius_km === Math.round(extremeBase.red * topTier.multiplier.red * 100) / 100
  );
  check("case 2 rings are wider than case 1's HIGH-band rings", z2.red_radius_km > z1.red_radius_km);

  console.log("\n=== Case 3: MODERATE risk, STALE water level (180 min old) -> fallback to base radius ===");
  r = await fetch(`${base}?location_id=3&risk_level=moderate`); // lower-case on purpose: normalization check
  let z3 = await r.json();
  console.log(z3);
  check("degraded_confidence is true", z3.degraded_confidence === true);
  check("reason is water_level_data_stale", z3.degraded_confidence_reason === "water_level_data_stale");
  check("red radius equals unmodified MODERATE base radius", z3.red_radius_km === moderateBase.red);
  check("risk_level normalizes to upper-case MODERATE", z3.risk_level === "MODERATE");

  console.log("\n=== Case 4: LOW risk, no water_level_readings row at all ===");
  r = await fetch(`${base}?location_id=4&risk_level=LOW`);
  let z4 = await r.json();
  console.log(z4);
  check("degraded_confidence is true", z4.degraded_confidence === true);
  check("reason is no_water_level_data", z4.degraded_confidence_reason === "no_water_level_data");
  check("green radius equals unmodified LOW base radius", z4.green_radius_km === lowBase.green);
  check("water_level_evidence is null", z4.water_level_evidence === null);

  console.log("\n=== Case 5: invalid risk_level -> 400, no radii leaked ===");
  r = await fetch(`${base}?location_id=1&risk_level=CATASTROPHIC`);
  let z5 = await r.json();
  console.log(r.status, z5);
  check("HTTP 400", r.status === 400);
  check("no red_radius_km on the error body", z5.red_radius_km === undefined);

  console.log("\n=== Case 6: unknown location_id -> 404 ===");
  r = await fetch(`${base}?location_id=9999&risk_level=HIGH`);
  let z6 = await r.json();
  console.log(r.status, z6);
  check("HTTP 404", r.status === 404);

  console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : failures + " CHECK(S) FAILED"}`);
  server.close();
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
