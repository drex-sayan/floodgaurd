// services/mockSensorFeed.js
//
// DEV/DEMO ONLY — NOT a real IoT ingestion pipeline.
//
// The realtime polling loop added on the frontend (overview.html) needs
// something to actually change between polls during a demo, since nothing
// in this codebase runs a scheduled job against rainfall_readings,
// water_level_readings, or soil_moisture_readings — the M1/M2 "run
// estimate" buttons are the only existing writers, and only for
// water_level_readings / cctv_events respectively. This file is the same
// role for the other reading tables: a mock generator standing in for a
// real sensor feed, exactly like ml/m1/README.md documents for M1's mock
// camera frames.
//
// Every row this module inserts is tagged source = 'dev_mock_sensor_feed'
// so it is never confused with a real telemetry source, and every value is
// a plausible-but-synthetic random walk — NOT measured data. Called from
// two places, both clearly dev/demo-only:
//   - routes/devSensorFeed.js  (manual "Insert mock sensor reading" button)
//   - scripts/mock_sensor_cron.js (optional standalone cron-style loop —
//     not started by `npm start`, run separately for a live demo)

const SOURCE = "dev_mock_sensor_feed";

function round(value, decimals) {
  const factor = Math.pow(10, decimals);
  return Math.round(value * factor) / factor;
}

function randomBetween(min, max) {
  return min + Math.random() * (max - min);
}

// Small random walk from a prior value, clamped to [min, max] so repeated
// inserts don't drift into nonsense readings over a long-running demo.
function walk(prior, step, min, max, fallback) {
  const base = Number.isFinite(Number(prior)) ? Number(prior) : fallback;
  const next = base + randomBetween(-step, step);
  return Math.min(max, Math.max(min, next));
}

async function fetchLatest(pool, table, columns, locationId) {
  const [rows] = await pool.execute(
    `SELECT ${columns}, \`timestamp\` FROM ${table} WHERE location_id = ? ORDER BY \`timestamp\` DESC LIMIT 1`,
    [locationId]
  );
  return rows[0] || null;
}

async function insertMockRainfall(pool, locationId, now) {
  const prior = await fetchLatest(pool, "rainfall_readings", "window_15m, window_30m, window_1h", locationId);
  const window15m = round(walk(prior && prior.window_15m, 1.5, 0, 40, 2), 2);
  const window30m = round(window15m + randomBetween(0, 3), 2);
  const window1h = round(window30m + randomBetween(0, 4), 2);
  const window3h = round(window1h * randomBetween(1.5, 2.5), 2);
  const window6h = round(window3h * randomBetween(1.3, 1.8), 2);
  const window12h = round(window6h * randomBetween(1.2, 1.6), 2);
  const window24h = round(window12h * randomBetween(1.2, 1.6), 2);
  const intensity = round(window1h, 2);

  await pool.execute(
    `INSERT INTO rainfall_readings
       (location_id, \`timestamp\`, window_15m, window_30m, window_1h, window_3h, window_6h, window_12h, window_24h,
        intensity, forecast_flag, source, units, quality_status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, 'mm', 'good')`,
    [locationId, now, window15m, window30m, window1h, window3h, window6h, window12h, window24h, intensity, SOURCE]
  );

  return { window_15m: window15m, window_1h: window1h, window_24h: window24h };
}

async function insertMockWaterLevel(pool, locationId, now) {
  const prior = await fetchLatest(pool, "water_level_readings", "level_m, `timestamp`", locationId);
  const priorLevel = prior && Number.isFinite(Number(prior.level_m)) ? Number(prior.level_m) : 0.6;
  const level = round(walk(priorLevel, 0.05, 0.1, 6, 0.6), 3);

  let change10m = null, change30m = null, change1h = null, riseRate = null;
  if (prior && prior.timestamp) {
    const elapsedHours = Math.max((now.getTime() - new Date(prior.timestamp).getTime()) / 3600000, 1 / 3600);
    const change = round(level - priorLevel, 3);
    change10m = change;
    change30m = change;
    change1h = change;
    riseRate = round(change / elapsedHours, 3);
  }

  await pool.execute(
    `INSERT INTO water_level_readings
       (location_id, \`timestamp\`, level_m, change_10m, change_30m, change_1h, change_3h,
        rise_rate_m_per_hr, source, camera_id, vision_confidence, units, quality_status)
     VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, NULL, NULL, 'm', 'good')`,
    [locationId, now, level, change10m, change30m, change1h, riseRate, SOURCE]
  );

  return { level_m: level, rise_rate_m_per_hr: riseRate };
}

async function insertMockSoilMoisture(pool, locationId, now) {
  const prior = await fetchLatest(pool, "soil_moisture_readings", "moisture_pct", locationId);
  const priorPct = prior && Number.isFinite(Number(prior.moisture_pct)) ? Number(prior.moisture_pct) : 35;
  const pct = round(walk(priorPct, 2.5, 5, 100, 35), 2);
  const trend = pct > priorPct + 0.5 ? "rising" : pct < priorPct - 0.5 ? "falling" : "stable";
  const saturationFlag = pct >= 90 ? 1 : 0;

  await pool.execute(
    `INSERT INTO soil_moisture_readings
       (location_id, \`timestamp\`, moisture_pct, trend, saturation_flag, source, units, quality_status)
     VALUES (?, ?, ?, ?, ?, ?, '%', 'good')`,
    [locationId, now, pct, trend, saturationFlag, SOURCE]
  );

  return { moisture_pct: pct, trend };
}

// Inserts one new mock reading into each of the three reading tables for a
// single location. Returns a small summary for the demo button's status
// line / the cron script's log line.
async function insertMockReadings(pool, locationId) {
  const now = new Date();
  const [rainfall, waterLevel, soilMoisture] = await Promise.all([
    insertMockRainfall(pool, locationId, now),
    insertMockWaterLevel(pool, locationId, now),
    insertMockSoilMoisture(pool, locationId, now)
  ]);
  return { location_id: locationId, timestamp: now.toISOString(), rainfall, water_level: waterLevel, soil_moisture: soilMoisture, source: SOURCE };
}

async function fetchAllLocationIds(pool) {
  const [rows] = await pool.execute(`SELECT location_id FROM locations ORDER BY location_id ASC`);
  return rows.map((r) => r.location_id);
}

module.exports = {
  SOURCE,
  insertMockReadings,
  fetchAllLocationIds
};
