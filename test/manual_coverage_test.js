// test/manual_coverage_test.js
//
// Manual/integration test for the Location & Model Coverage Engine.
// Runs a small standalone Express app wired to the real routes/location.js
// against an in-memory fake DB pool (seeded the same way db/seed.js seeds
// the real `locations` table), so it can be run with:
//
//   node test/manual_coverage_test.js
//
// ...without needing a live MySQL instance. It exercises exactly the two
// cases called out in the task: Chamoli (covered) and Kolkata (unsupported),
// plus a couple of edge cases (nearby coordinates, and an unknown far-away
// point that requires the geocode fallback).

const express = require("express");
const locationRoutes = require("../routes/location");

// ---- Fake DB pool, mimicking the subset of mysql2/promise used by routes/location.js ----
function haversineKm(lat1, lon1, lat2, lon2) {
  const toRad = (d) => (d * Math.PI) / 180;
  const R = 6371;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function createFakePool(seedRows) {
  let rows = seedRows.map((r, i) => ({ location_id: i + 1, ...r }));
  let nextId = rows.length + 1;

  return {
    async execute(sql, params) {
      const s = sql.replace(/\s+/g, " ").trim();

      if (s.startsWith("SELECT location_id, latitude, longitude, place_name, region, (6371")) {
        const [lat, lon] = params;
        if (!rows.length) return [[]];
        const withDist = rows
          .map((r) => ({ ...r, distance_km: haversineKm(lat, lon, r.latitude, r.longitude) }))
          .sort((a, b) => a.distance_km - b.distance_km);
        return [[withDist[0]]];
      }

      if (s.startsWith("SELECT location_id, latitude, longitude, place_name, region FROM locations WHERE place_name LIKE")) {
        const [like] = params;
        const needle = like.replace(/%/g, "").toLowerCase();
        const hits = rows.filter(
          (r) => r.place_name.toLowerCase().includes(needle) || (r.region || "").toLowerCase().includes(needle)
        );
        return [hits.slice(0, 1)];
      }

      if (s.startsWith("INSERT INTO locations")) {
        const [latitude, longitude, place_name, region] = params;
        const row = { location_id: nextId++, latitude, longitude, place_name, region };
        rows.push(row);
        return [{ insertId: row.location_id }];
      }

      if (s.startsWith("SELECT location_id, latitude, longitude, place_name, region FROM locations WHERE location_id")) {
        const [id] = params;
        return [rows.filter((r) => r.location_id === id)];
      }

      throw new Error("Unhandled fake SQL: " + s);
    }
  };
}

// Same seed data as db/seed.js
const SEED_LOCATIONS = [
  { place_name: "Chamoli", region: "Uttarakhand, India", latitude: 30.4032, longitude: 79.3212 },
  { place_name: "Kolkata", region: "West Bengal, India", latitude: 22.5726, longitude: 88.3639 },
  { place_name: "Guwahati", region: "Assam, India", latitude: 26.1445, longitude: 91.7362 }
];

async function main() {
  const pool = createFakePool(SEED_LOCATIONS);
  const app = express();
  app.use(express.json());
  // No auth middleware here — this test targets the location logic itself,
  // which server.js otherwise mounts behind requireAuth.
  app.use("/api/location", locationRoutes(() => pool));

  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}/api/location`;

  let failures = 0;
  function check(label, cond, detail) {
    const ok = !!cond;
    console.log(`${ok ? "PASS" : "FAIL"} — ${label}${detail ? " :: " + detail : ""}`);
    if (!ok) failures++;
  }

  console.log("\n=== Case 1: search-resolve a COVERED location (Chamoli) ===");
  let r = await fetch(`${base}/resolve`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query: "Chamoli" })
  });
  let chamoli = await r.json();
  console.log(chamoli);
  check("resolve found existing Chamoli row", chamoli.source === "existing" && chamoli.place_name === "Chamoli");

  r = await fetch(`${base}/coverage?location_id=${chamoli.location_id}`);
  let chamoliCoverage = await r.json();
  console.log(chamoliCoverage);
  check("Chamoli reports coverage_status = covered", chamoliCoverage.coverage_status === "covered");
  check("Chamoli includes a model_region + model_version", !!chamoliCoverage.model_region && !!chamoliCoverage.model_version);

  console.log("\n=== Case 2: search-resolve an UNSUPPORTED location (Kolkata) ===");
  r = await fetch(`${base}/resolve`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query: "Kolkata" })
  });
  let kolkata = await r.json();
  console.log(kolkata);
  check("resolve found existing Kolkata row", kolkata.source === "existing" && kolkata.place_name === "Kolkata");

  r = await fetch(`${base}/coverage?location_id=${kolkata.location_id}`);
  let kolkataCoverage = await r.json();
  console.log(kolkataCoverage);
  check("Kolkata reports coverage_status = unsupported", kolkataCoverage.coverage_status === "unsupported");
  check("Kolkata has no model_region/model_version leaked", !kolkataCoverage.model_region && !kolkataCoverage.model_version);
  check(
    "Frontend safety rule: no /api/ml/predict call would be made for Kolkata",
    kolkataCoverage.coverage_status !== "covered"
  );

  console.log("\n=== Case 3: coordinate-resolve a point near Chamoli (should reuse existing row, still covered) ===");
  r = await fetch(`${base}/resolve`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ latitude: 30.41, longitude: 79.33 })
  });
  let nearChamoli = await r.json();
  console.log(nearChamoli);
  check("nearby coordinates reuse the existing Chamoli row", nearChamoli.source === "existing" && nearChamoli.location_id === chamoli.location_id);

  console.log("\n=== Case 4: coordinate-resolve a far-away, unseeded point (Delhi-ish) — exercises geocode fallback + unsupported coverage ===");
  r = await fetch(`${base}/resolve`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ latitude: 28.6139, longitude: 77.209 })
  });
  let delhi = await r.json();
  console.log(delhi);
  check("a brand-new far point gets inserted as a new location row", ["geocoded", "new"].includes(delhi.source));

  r = await fetch(`${base}/coverage?location_id=${delhi.location_id}`);
  let delhiCoverage = await r.json();
  console.log(delhiCoverage);
  check("new unseeded location is unsupported by the M3 allow-list", delhiCoverage.coverage_status === "unsupported");

  console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : failures + " CHECK(S) FAILED"}`);
  server.close();
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
