// scripts/mock_sensor_cron.js
//
// DEV/DEMO ONLY — NOT a real IoT ingestion pipeline.
//
// Standalone loop that periodically inserts mock rainfall / water-level /
// soil-moisture readings for every known location, using the exact same
// generator routes/devSensorFeed.js's manual button calls
// (services/mockSensorFeed.js). This is the "Node cron job" half of the
// realtime-demo deliverable — the manual trigger button is the other half.
//
// NOT started by `npm start` / server.js. Run it as its own process,
// alongside the app, only when you want the dashboard's realtime polling
// to have continuously-changing data for a demo:
//
//   node scripts/mock_sensor_cron.js
//   npm run demo:sensor-cron
//
// Optional env vars:
//   MOCK_SENSOR_FEED_INTERVAL_MS   how often to insert (default 60000 = 60s)
//   MOCK_SENSOR_FEED_LOCATION_IDS  comma-separated location_id list to
//                                  restrict to (default: every location in
//                                  the `locations` table)
//
// Ctrl+C to stop. Safe to leave running only in a dev/demo environment —
// every row it writes is tagged source = 'dev_mock_sensor_feed'.

require("dotenv").config();

const mysql = require("mysql2/promise");
const { insertMockReadings, fetchAllLocationIds } = require("../services/mockSensorFeed");

const requiredEnv = ["DB_HOST", "DB_USER", "DB_NAME"];
for (const key of requiredEnv) {
  if (!process.env[key]) {
    console.error(`Missing required environment variable: ${key}`);
    process.exit(1);
  }
}

const dbConfig = {
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT) || 3306,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD ?? "",
  database: process.env.DB_NAME
};

const INTERVAL_MS = Number(process.env.MOCK_SENSOR_FEED_INTERVAL_MS) || 60000;
const FIXED_LOCATION_IDS = (process.env.MOCK_SENSOR_FEED_LOCATION_IDS || "")
  .split(",")
  .map((s) => Number(s.trim()))
  .filter((n) => Number.isFinite(n));

async function tick(pool) {
  try {
    const locationIds = FIXED_LOCATION_IDS.length ? FIXED_LOCATION_IDS : await fetchAllLocationIds(pool);
    if (!locationIds.length) {
      console.log("[mock-sensor-cron] No locations found yet — nothing to insert this tick.");
      return;
    }
    for (const locationId of locationIds) {
      const result = await insertMockReadings(pool, locationId);
      console.log(
        `[mock-sensor-cron] location ${locationId}: ` +
          `rainfall_1h=${result.rainfall.window_1h}mm, ` +
          `level=${result.water_level.level_m}m, ` +
          `soil=${result.soil_moisture.moisture_pct}%`
      );
    }
  } catch (error) {
    console.error("[mock-sensor-cron] tick failed:", error.message);
  }
}

async function main() {
  const pool = mysql.createPool({ ...dbConfig, waitForConnections: true, connectionLimit: 5, queueLimit: 0 });
  console.log(`✓ mock-sensor-cron connected — inserting every ${Math.round(INTERVAL_MS / 1000)}s (demo only, not real IoT)`);

  await tick(pool); // run once immediately so a demo doesn't wait a full interval
  const handle = setInterval(() => tick(pool), INTERVAL_MS);

  process.on("SIGINT", async () => {
    clearInterval(handle);
    await pool.end();
    console.log("\n✓ mock-sensor-cron stopped");
    process.exit(0);
  });
}

main().catch((error) => {
  console.error("✗ mock-sensor-cron failed to start:", error.message);
  process.exit(1);
});
