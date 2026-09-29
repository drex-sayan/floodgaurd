// routes/m4.js
//
// M4 Landslide Hazard Estimate — a supporting hazard module only. Its
// output is a separate landslide_probability/risk_level for display on
// the M4 dashboard card; it is never read by runM3Prediction(), the
// Zone Engine (services/zoneEngine.js), or the Alert Engine
// (services/alertEngine.js), and it never modifies M3's flood
// probability. See ml/m4/train_landslide.py and
// ml/m4/predict_landslide.py.
//
//   GET /api/m4/hazard?location_id=...
//     Builds an M4 feature vector for the location from whatever
//     terrain/rainfall/soil-moisture data already exists in the
//     database, spawns ml/m4/predict_landslide.py the same way
//     server.js's runM3Prediction() spawns predict_m3.py, and returns
//     { landslide_probability, risk_level, model_version,
//       data_is_synthetic, data_quality }.
//
//     Most locations have no rainfall/soil-moisture history yet (no
//     ingestion job is wired up for those tables — see db/schema.sql)
//     and may have no terrain_features row at all. Rather than fail,
//     this route falls back to neutral baseline values for whatever is
//     missing and reports `data_quality: "estimated"` so the frontend
//     can show that distinction instead of presenting a guess as a
//     real reading — same pattern as routes/m5.js.

const express = require("express");
const path = require("path");
const inferenceService = require("../services/inferenceService");
const { evaluateFreshnessGate } = require("../utils/freshness");

const M4_ROOT = path.join(__dirname, "..", "ml", "m4");

// Neutral fallback values used only for whatever a location's history is
// missing. Never presented to the user as measured data — see
// data_quality in the response. land_cover/geology default to the
// lowest-risk class in ml/m4/predict_landslide.py's own fallback, so we
// don't duplicate that mapping here — omitting them from the payload has
// the same effect.
const DEFAULTS = {
  slope_deg: 0.0,
  elevation_m: 0.0,
  rainfall_1h: 0.0,
  rainfall_3h: 0.0,
  rainfall_6h: 0.0,
  rainfall_12h: 0.0,
  rainfall_24h: 0.0,
  soil_moisture: 35.0,
  moisture_change_3h: 0.0
};

function toNumberOrNull(value) {
  if (value === undefined || value === null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function runM4Hazard(payload) {
  return inferenceService.predict("m4", payload);
}

function m4Routes(getPool) {
  const router = express.Router();

  async function fetchLocation(pool, locationId) {
    const [rows] = await pool.execute(
      `SELECT location_id, latitude, longitude, place_name, region
       FROM locations WHERE location_id = ? LIMIT 1`,
      [locationId]
    );
    return rows[0] || null;
  }

  async function fetchTerrain(pool, locationId) {
    const [rows] = await pool.execute(
      `SELECT elevation_m, slope_deg, land_cover, geology
       FROM terrain_features WHERE location_id = ? LIMIT 1`,
      [locationId]
    );
    return rows[0] || null;
  }

  async function fetchLatestRainfall(pool, locationId) {
    const [rows] = await pool.execute(
      `SELECT window_1h, window_3h, window_6h, window_12h, window_24h, \`timestamp\`
       FROM rainfall_readings
       WHERE location_id = ?
       ORDER BY \`timestamp\` DESC
       LIMIT 1`,
      [locationId]
    );
    return rows[0] || null;
  }

  async function fetchLatestSoilMoisture(pool, locationId) {
    const [rows] = await pool.execute(
      `SELECT moisture_pct, \`timestamp\` FROM soil_moisture_readings
       WHERE location_id = ?
       ORDER BY \`timestamp\` DESC
       LIMIT 1`,
      [locationId]
    );
    return rows[0] || null;
  }

  // Turns whatever the database has for this location into the exact
  // feature payload ml/m4/predict_landslide.py expects, filling
  // numeric gaps with DEFAULTS and tracking whether anything had to be
  // estimated. land_cover/geology are passed through as strings (or
  // omitted) — predict_landslide.py handles the missing/unknown case.
  function buildFeatures({ terrain, rainfall, soilMoisture }) {
    let estimated = false;
    const need = (v, fallback) => {
      if (v === null || v === undefined || !Number.isFinite(Number(v))) {
        estimated = true;
        return fallback;
      }
      return Number(v);
    };

    if (!terrain) estimated = true;

    const features = {
      slope_deg: need(terrain && terrain.slope_deg, DEFAULTS.slope_deg),
      elevation_m: need(terrain && terrain.elevation_m, DEFAULTS.elevation_m),
      rainfall_1h: need(rainfall && rainfall.window_1h, DEFAULTS.rainfall_1h),
      rainfall_3h: need(rainfall && rainfall.window_3h, DEFAULTS.rainfall_3h),
      rainfall_6h: need(rainfall && rainfall.window_6h, DEFAULTS.rainfall_6h),
      rainfall_12h: need(rainfall && rainfall.window_12h, DEFAULTS.rainfall_12h),
      rainfall_24h: need(rainfall && rainfall.window_24h, DEFAULTS.rainfall_24h),
      soil_moisture: need(soilMoisture && soilMoisture.moisture_pct, DEFAULTS.soil_moisture),
      moisture_change_3h: DEFAULTS.moisture_change_3h,
      land_cover: (terrain && terrain.land_cover) || null,
      geology: (terrain && terrain.geology) || null
    };
    if (!features.land_cover || !features.geology) estimated = true;

    return { features, estimated };
  }

  router.get("/hazard", async (req, res) => {
    try {
      const locationId = toNumberOrNull(req.query.location_id);
      if (!locationId) {
        return res.status(400).json({ message: "location_id query parameter is required." });
      }

      const pool = getPool();
      const location = await fetchLocation(pool, locationId);
      if (!location) {
        return res.status(404).json({ message: "Unknown location_id." });
      }

      const [terrain, rainfall, soilMoisture] = await Promise.all([
        fetchTerrain(pool, locationId),
        fetchLatestRainfall(pool, locationId),
        fetchLatestSoilMoisture(pool, locationId)
      ]);

      const { features, estimated } = buildFeatures({ terrain, rainfall, soilMoisture });
      const hazard = await runM4Hazard(features);

      // Freshness gate on the two time-varying inputs (terrain is a static
      // per-location row with no timestamp, so it's excluded here — its
      // absence is already covered by `estimated` above). This is purely
      // additive: it never changes `features` or what runM4Hazard() saw.
      const gate = evaluateFreshnessGate([
        { key: "rainfall", dataType: "rainfall_readings", timestamp: rainfall && rainfall.timestamp, critical: true },
        { key: "soil_moisture", dataType: "soil_moisture_readings", timestamp: soilMoisture && soilMoisture.timestamp, critical: true }
      ]);

      res.json({
        location_id: location.location_id,
        place_name: location.place_name,
        landslide_probability: hazard.landslide_probability,
        risk_level: hazard.risk_level,
        risk_meaning: hazard.risk_meaning,
        model_version: hazard.model_version,
        data_is_synthetic: hazard.data_is_synthetic,
        data_quality: estimated ? "estimated" : "measured",
        data_freshness: gate.freshness,
        degraded_confidence: estimated || gate.degraded_confidence,
        degraded_confidence_reason: gate.degraded_confidence_reason || (estimated ? "m4_inputs_estimated" : null),
        generated_at: new Date().toISOString()
      });
    } catch (error) {
      console.error("M4 hazard error:", error.message);
      res.status(500).json({ message: "Unable to run the M4 hazard estimate." });
    }
  });

  return router;
}

module.exports = m4Routes;
