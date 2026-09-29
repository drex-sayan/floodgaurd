// routes/devSensorFeed.js
//
// DEV/DEMO ONLY — NOT a real IoT ingestion pipeline.
//
//   POST /api/dev/mock-sensor-feed/trigger { location_id }
//     Inserts one new mock rainfall / water-level / soil-moisture reading
//     for the given location, tagged source = 'dev_mock_sensor_feed' (see
//     services/mockSensorFeed.js). Standing in for a real sensor push, the
//     same role POST /api/m1/ingest and POST /api/m2/events already play
//     for their own tables — this just covers the three reading tables
//     nothing else writes to on a schedule, so the realtime polling loop
//     on the dashboard has fresh data to show during a demo.
//
// Every response is explicitly labeled prototype/demo so it can never be
// mistaken for a real telemetry endpoint by a client.

const express = require("express");
const { insertMockReadings } = require("../services/mockSensorFeed");

function toNumberOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function devSensorFeedRoutes(getPool) {
  const router = express.Router();

  router.post("/trigger", async (req, res) => {
    try {
      const locationId = toNumberOrNull((req.body || {}).location_id);
      if (!locationId) {
        return res.status(400).json({ message: "location_id is required." });
      }

      const pool = getPool();
      const [locRows] = await pool.execute(
        `SELECT location_id, place_name FROM locations WHERE location_id = ? LIMIT 1`,
        [locationId]
      );
      if (!locRows.length) {
        return res.status(404).json({ message: "Unknown location_id." });
      }

      const result = await insertMockReadings(pool, locationId);
      res.json({
        ok: true,
        demo_only: true,
        prototype: true,
        message: "Inserted mock rainfall / water-level / soil-moisture readings — not a real sensor feed.",
        place_name: locRows[0].place_name,
        ...result
      });
    } catch (error) {
      console.error("Dev mock-sensor-feed error:", error.message);
      res.status(500).json({ message: "Unable to insert mock sensor readings." });
    }
  });

  return router;
}

module.exports = devSensorFeedRoutes;
