// routes/zones.js
//
// Zone Engine endpoint — turns an already-computed M3 prediction into
// Red/Yellow/Green geographic risk rings for a resolved location.
//
//   GET /api/zones?location_id=...&risk_level=...&probability=...
//
//     location_id  (required) location_id from POST /api/location/resolve
//     risk_level   (required) LOW | MODERATE | HIGH | EXTREME, exactly as
//                  returned by POST /api/ml/predict's `risk_level` field
//     probability  (optional) the matching `flood_probability` (0-1) from
//                  that same M3 response. Echoed back for display only —
//                  see services/zoneEngine.js for why it never changes the
//                  radii.
//
// This route does not call the M3 model itself. By the time the frontend
// calls /api/zones, it has already run /api/ml/predict and holds the
// result, so we take risk_level/probability as inputs instead of
// re-deriving them. That keeps this endpoint focused on one job: turning a
// risk band + local water-level evidence into zone radii.
//
// Water-level evidence is read straight from `water_level_readings` (the
// most recent row for this location_id); the Zone Engine itself decides
// whether that row is fresh/good enough to use — see
// services/zoneEngine.js and config/zonePolicy.json.

const express = require("express");
const { computeZoneRadii, normalizeRiskLevel, RISK_BANDS } = require("../services/zoneEngine");
const { classifyFreshness } = require("../utils/freshness");

function toNumberOrNull(value) {
  if (value === undefined || value === null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function zoneRoutes(getPool) {
  const router = express.Router();

  async function fetchLocation(pool, locationId) {
    const [rows] = await pool.execute(
      `SELECT location_id, latitude, longitude, place_name, region
       FROM locations WHERE location_id = ? LIMIT 1`,
      [locationId]
    );
    return rows[0] || null;
  }

  async function fetchLatestWaterLevel(pool, locationId) {
    const [rows] = await pool.execute(
      `SELECT level_m, change_1h, change_3h, rise_rate_m_per_hr, \`timestamp\`, quality_status
       FROM water_level_readings
       WHERE location_id = ?
       ORDER BY \`timestamp\` DESC
       LIMIT 1`,
      [locationId]
    );
    return rows[0] || null;
  }

  router.get("/", async (req, res) => {
    try {
      const locationId = toNumberOrNull(req.query.location_id);
      if (!locationId) {
        return res.status(400).json({ message: "location_id query parameter is required." });
      }

      const riskLevel = normalizeRiskLevel(req.query.risk_level);
      if (!riskLevel) {
        return res.status(400).json({
          message: `risk_level query parameter is required and must be one of: ${RISK_BANDS.join(", ")}.`
        });
      }

      const probability = toNumberOrNull(req.query.probability);

      const pool = getPool();

      const location = await fetchLocation(pool, locationId);
      if (!location) {
        return res.status(404).json({ message: "Unknown location_id." });
      }

      const waterLevel = await fetchLatestWaterLevel(pool, locationId);
      const zone = computeZoneRadii({ riskLevel, waterLevel });

      res.json({
        location_id: location.location_id,
        place_name: location.place_name,
        region: location.region,
        latitude: Number(location.latitude),
        longitude: Number(location.longitude),
        flood_probability: probability,
        ...zone,
        // NOTE: this `data_freshness` field is purely additive/display —
        // it's computed independently for the freshness badge and never
        // fed back into computeZoneRadii(). The `degraded_confidence` /
        // `degraded_confidence_reason` above (spread from `...zone`) are
        // the Zone Engine's own core-logic fields and are untouched here.
        water_level_evidence: waterLevel
          ? {
              level_m: waterLevel.level_m !== null ? Number(waterLevel.level_m) : null,
              rise_rate_m_per_hr: waterLevel.rise_rate_m_per_hr !== null ? Number(waterLevel.rise_rate_m_per_hr) : null,
              quality_status: waterLevel.quality_status,
              timestamp: waterLevel.timestamp,
              data_freshness: classifyFreshness({ timestamp: waterLevel.timestamp, dataType: "water_level_readings" })
            }
          : null,
        generated_at: new Date().toISOString()
      });
    } catch (error) {
      if (error.code === "INVALID_RISK_LEVEL" || error.code === "MISSING_POLICY_BAND") {
        return res.status(400).json({ message: error.message });
      }
      console.error("Zone engine error:", error);
      res.status(500).json({ message: "Unable to compute risk zones." });
    }
  });

  return router;
}

module.exports = zoneRoutes;
