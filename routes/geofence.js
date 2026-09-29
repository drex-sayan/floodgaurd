// routes/geofence.js
//
//   POST /api/geofence/check
//     Body: { location_id, latitude, longitude, risk_level, probability? }
//
// This is the missing link between the Zone Engine (services/zoneEngine.js,
// which turns an M3 risk_level into Red/Yellow/Green radii around a
// location) and a specific user's live position. On every call it:
//
//   1. Computes the current zone radii for location_id (same logic as
//      GET /api/zones).
//   2. Measures the caller's distance from that location and classifies
//      them into 'red' | 'yellow' | 'green' | 'outside'.
//   3. Reads the user's previously stored zone for this location from
//      `user_zone_state` (defaulting to 'outside' if this is their first
//      check-in) and compares it to the zone just computed.
//   4. Persists the new zone to `user_zone_state`.
//   5. If the zone changed (transitioned === true) and the new zone is
//      Red or Yellow, calls services/alertEngine.js to (attempt to) notify
//      the user — see that file for cooldown/dedup behavior.
//
// Deliberately mirrors routes/zones.js's fetchLocation/fetchLatestWaterLevel
// helpers rather than importing them — this stays consistent with how the
// rest of the codebase keeps each route file's small DB helpers local
// (see e.g. toNumberOrNull duplicated across routes/location.js and
// routes/zones.js).

const express = require("express");
const { computeZoneRadii, normalizeRiskLevel, RISK_BANDS } = require("../services/zoneEngine");
const { haversineKm, classifyZone, isUpgrade } = require("../services/geofenceEngine");
const alertEngine = require("../services/alertEngine");
const { classifyFreshness } = require("../utils/freshness");

function toNumberOrNull(value) {
  if (value === undefined || value === null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function validLat(lat) {
  return typeof lat === "number" && Number.isFinite(lat) && lat >= -90 && lat <= 90;
}

function validLon(lon) {
  return typeof lon === "number" && Number.isFinite(lon) && lon >= -180 && lon <= 180;
}

function geofenceRoutes(getPool) {
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

  async function fetchPreviousZone(pool, userId, locationId) {
    const [rows] = await pool.execute(
      `SELECT current_zone FROM user_zone_state WHERE user_id = ? AND location_id = ? LIMIT 1`,
      [userId, locationId]
    );
    return rows[0] ? rows[0].current_zone : "outside";
  }

  async function persistZone(pool, userId, locationId, zone) {
    await pool.execute(
      `INSERT INTO user_zone_state (user_id, location_id, current_zone)
       VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE current_zone = VALUES(current_zone)`,
      [userId, locationId, zone]
    );
  }

  router.post("/check", async (req, res) => {
    try {
      const body = req.body || {};
      const locationId = toNumberOrNull(body.location_id);
      const latitude = toNumberOrNull(body.latitude);
      const longitude = toNumberOrNull(body.longitude);
      const probability = toNumberOrNull(body.probability);

      if (!locationId) {
        return res.status(400).json({ message: "location_id is required." });
      }
      if (!validLat(latitude) || !validLon(longitude)) {
        return res.status(400).json({ message: "latitude/longitude are required and must be in range." });
      }

      const riskLevel = normalizeRiskLevel(body.risk_level);
      if (!riskLevel) {
        return res.status(400).json({
          message: `risk_level is required and must be one of: ${RISK_BANDS.join(", ")}.`
        });
      }

      const pool = getPool();
      const userId = req.user.id;

      const location = await fetchLocation(pool, locationId);
      if (!location) {
        return res.status(404).json({ message: "Unknown location_id." });
      }

      const waterLevel = await fetchLatestWaterLevel(pool, locationId);
      const radii = computeZoneRadii({ riskLevel, waterLevel });

      const distanceKm = haversineKm(
        latitude,
        longitude,
        Number(location.latitude),
        Number(location.longitude)
      );
      const currentZone = classifyZone(distanceKm, radii);

      const previousZone = await fetchPreviousZone(pool, userId, locationId);
      const transitioned = currentZone !== previousZone;

      await persistZone(pool, userId, locationId, currentZone);

      let alert = null;
      if (transitioned && isUpgrade(previousZone, currentZone) && alertEngine.isAlertableZone(currentZone)) {
        alert = await alertEngine.evaluateAndNotify(pool, {
          userId,
          locationId,
          zone: currentZone,
          placeName: location.place_name,
          modelVersion: riskLevel, // no live model_versions FK here; risk band is the closest audit trail without one
          evidenceSummary: {
            risk_level: riskLevel,
            flood_probability: probability,
            distance_km: Math.round(distanceKm * 1000) / 1000,
            previous_zone: previousZone,
            rise_rate_m_per_hr_used: radii.rise_rate_m_per_hr_used,
            degraded_confidence: radii.degraded_confidence
          }
        });
      }

      res.json({
        location_id: location.location_id,
        place_name: location.place_name,
        current_zone: currentZone,
        previous_zone: previousZone,
        transitioned,
        distance_km: Math.round(distanceKm * 1000) / 1000,
        ...radii,
        // Additive display-only badge for the water-level evidence radii
        // above was computed from — mirrors routes/zones.js. Does not feed
        // back into computeZoneRadii(); radii.degraded_confidence above is
        // the Zone Engine's own core-logic field and is untouched.
        water_level_freshness: waterLevel
          ? classifyFreshness({ timestamp: waterLevel.timestamp, dataType: "water_level_readings" })
          : classifyFreshness({ timestamp: null, dataType: "water_level_readings" }),
        alert
      });
    } catch (error) {
      if (error.code === "INVALID_RISK_LEVEL" || error.code === "MISSING_POLICY_BAND") {
        return res.status(400).json({ message: error.message });
      }
      console.error("Geofence check error:", error);
      res.status(500).json({ message: "Unable to check geofence." });
    }
  });

  return router;
}

module.exports = geofenceRoutes;
