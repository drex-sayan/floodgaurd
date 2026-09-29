// routes/m1.js
//
// M1 Water-Level Vision Module — supporting module only. Its output never
// changes the M3 flood probability or the Zone Engine's radii (see
// services/m1Ingest.js's header and ml/m1/README.md for why); it exists
// solely to feed the M1 context card on the dashboard.
//
//   GET /api/m1/latest?location_id=...
//     Returns the most recent M1-sourced water_level_readings row for a
//     location, or { available: false } if none exists yet.
//
//   POST /api/m1/ingest { location_id }
//     Demo/dev trigger: since no real CCTV feed is wired up yet, this runs
//     one full ingest cycle against a static mock frame (see
//     ml/m1/make_mock_images.py) and inserts a new reading. Standing in for
//     what a scheduled job would do against a real camera capture. Not
//     part of the strict deliverable list, but needed so the dashboard
//     card in Phase 10C has something real to show without a live feed.

const express = require("express");
const { ingestForLocation, findCalibrationForLocation, M1IngestError } = require("../services/m1Ingest");
const { classifyFreshness } = require("../utils/freshness");

function toNumberOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

// The M1 reading itself is the "critical input" this card displays — if
// it's gone stale/expired, the level/rise-rate on screen no longer
// reflects current conditions, so we surface that the same way
// services/zoneEngine.js flags a stale water-level row: a badge plus an
// explicit degraded_confidence flag, never a silent stale number.
function freshnessFields(timestamp) {
  const freshness = classifyFreshness({ timestamp, dataType: "water_level_readings" });
  const degraded = freshness.status === "stale" || freshness.status === "expired" || !freshness.available;
  return {
    data_freshness: freshness,
    degraded_confidence: degraded,
    degraded_confidence_reason: degraded ? `m1_reading_${freshness.status}` : null
  };
}

function rowToLatest(row) {
  return {
    available: true,
    location_id: row.location_id,
    camera_id: row.camera_id,
    timestamp: row.timestamp,
    level_m: row.level_m === null ? null : Number(row.level_m),
    change_10m: row.change_10m === null ? null : Number(row.change_10m),
    change_30m: row.change_30m === null ? null : Number(row.change_30m),
    change_1h: row.change_1h === null ? null : Number(row.change_1h),
    rise_rate_m_per_hr: row.rise_rate_m_per_hr === null ? null : Number(row.rise_rate_m_per_hr),
    vision_confidence: row.vision_confidence === null ? null : Number(row.vision_confidence),
    units: row.units,
    quality_status: row.quality_status,
    source: row.source,
    prototype: true,
    disclaimer: "Calibration-based prototype estimate — not a validated computer-vision gauge.",
    ...freshnessFields(row.timestamp)
  };
}

function m1Routes(getPool) {
  const router = express.Router();

  router.get("/latest", async (req, res) => {
    try {
      const locationId = toNumberOrNull(req.query.location_id);
      if (!locationId) {
        return res.status(400).json({ message: "location_id query parameter is required." });
      }

      const pool = getPool();
      const [rows] = await pool.execute(
        `SELECT location_id, \`timestamp\`, level_m, change_10m, change_30m, change_1h,
                rise_rate_m_per_hr, camera_id, vision_confidence, units, quality_status, source
         FROM water_level_readings
         WHERE location_id = ? AND source = 'm1_cv_prototype'
         ORDER BY \`timestamp\` DESC
         LIMIT 1`,
        [locationId]
      );

      if (!rows.length) {
        return res.json({
          available: false,
          location_id: locationId,
          message: "No M1 reading yet for this location.",
          prototype: true,
          ...freshnessFields(null)
        });
      }

      res.json(rowToLatest(rows[0]));
    } catch (error) {
      console.error("M1 latest-reading error:", error);
      res.status(500).json({ message: "Unable to load the M1 water-level reading." });
    }
  });

  router.post("/ingest", async (req, res) => {
    try {
      const locationId = toNumberOrNull((req.body || {}).location_id);
      if (!locationId) {
        return res.status(400).json({ message: "location_id is required." });
      }

      const pool = getPool();
      if (!findCalibrationForLocation(locationId)) {
        return res.status(404).json({
          message: "No M1 camera calibration is configured for this location.",
          prototype: true
        });
      }

      const result = await ingestForLocation(pool, locationId);
      res.json({ available: true, ...result, ...freshnessFields(result.timestamp) });
    } catch (error) {
      if (error instanceof M1IngestError) {
        console.error("M1 ingest error:", error.message);
        return res.status(422).json({ message: "Could not produce an M1 estimate." });
      }
      console.error("M1 ingest error:", error);
      res.status(500).json({ message: "Unable to run the M1 estimate." });
    }
  });

  return router;
}

module.exports = m1Routes;
