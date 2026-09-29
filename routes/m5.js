// routes/m5.js
//
// M5 Water-Level Forecasting Module — a supporting module only. Its
// output is a +1h/+3h/+6h water-level estimate for display on the M5
// dashboard card; it is never read by runM3Prediction(), the Zone
// Engine (services/zoneEngine.js), or the Alert Engine. See
// ml/m5/train_forecast.py and ml/m5/predict_forecast.py.
//
//   GET /api/m5/forecast?location_id=...
//     Builds an M5 feature vector for the location from whatever
//     rainfall/soil-moisture/water-level/terrain history already exists
//     in the database, spawns ml/m5/predict_forecast.py the same way
//     server.js's runM3Prediction() spawns predict_m3.py, and returns
//     { forecast_1h, forecast_3h, forecast_6h, model_version,
//       data_is_synthetic }.
//
//     Most locations have no rainfall/soil-moisture history yet (no
//     ingestion job is wired up for those tables — see db/schema.sql)
//     and may have no water_level_readings either if nobody has run an
//     M1 estimate for them. Rather than fail, this route falls back to
//     neutral baseline values for whatever is missing and reports
//     `data_quality: "estimated"` so the frontend can show that
//     distinction instead of presenting a guess as a real reading.

const express = require("express");
const path = require("path");
const inferenceService = require("../services/inferenceService");
const { evaluateFreshnessGate } = require("../utils/freshness");

const M5_ROOT = path.join(__dirname, "..", "ml", "m5");

// Neutral fallback values used only for whatever a location's history is
// missing. Never presented to the user as measured data — see
// data_quality in the response.
const DEFAULTS = {
  water_level_m: 0.5,
  soil_moisture: 35.0,
  moisture_change_3h: 0.0,
  rainfall_1h: 0.0,
  rainfall_3h: 0.0,
  rainfall_6h: 0.0,
  rainfall_12h: 0.0,
  rainfall_24h: 0.0,
  elevation_m: 0.0,
  slope_deg: 0.0,
  event_proximity_km: 10.0
};

function toNumberOrNull(value) {
  if (value === undefined || value === null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function runM5Forecast(payload) {
  return inferenceService.predict("m5", payload);
}

function m5Routes(getPool) {
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
      `SELECT elevation_m, slope_deg FROM terrain_features WHERE location_id = ? LIMIT 1`,
      [locationId]
    );
    return rows[0] || null;
  }

  // Most recent readings, newest first, enough to derive lag1h/3h/6h and
  // change_1h/3h assuming roughly-hourly cadence (the same cadence the
  // M5 model was trained on).
  async function fetchRecentWaterLevels(pool, locationId) {
    const [rows] = await pool.execute(
      `SELECT level_m, \`timestamp\`
       FROM water_level_readings
       WHERE location_id = ?
       ORDER BY \`timestamp\` DESC
       LIMIT 7`,
      [locationId]
    );
    return rows;
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

  async function fetchRecentEventCount(pool, locationId) {
    const [rows] = await pool.execute(
      `SELECT COUNT(*) AS n FROM historical_events
       WHERE location_id = ? AND event_date >= DATE_SUB(CURDATE(), INTERVAL 30 DAY)`,
      [locationId]
    );
    return rows[0] ? Number(rows[0].n) : 0;
  }

  // Turns whatever the database has for this location into the exact
  // feature vector ml/m5/predict_forecast.py expects, filling gaps with
  // DEFAULTS and tracking whether anything had to be estimated.
  function buildFeatures({ location, terrain, waterLevels, rainfall, soilMoisture, recentEventCount }) {
    let estimated = false;
    const need = (v, fallback) => {
      if (v === null || v === undefined || !Number.isFinite(Number(v))) {
        estimated = true;
        return fallback;
      }
      return Number(v);
    };

    // waterLevels is newest-first. Index 0 = current, 1 = ~1h ago, 3 =
    // ~3h ago, 6 = ~6h ago, matching the model's hourly-cadence training.
    const levelAt = (idx) => (waterLevels[idx] ? Number(waterLevels[idx].level_m) : null);
    const currentLevel = need(levelAt(0), DEFAULTS.water_level_m);
    const lag1 = need(levelAt(1), currentLevel);
    const lag3 = need(levelAt(3), currentLevel);
    const lag6 = need(levelAt(6), currentLevel);
    if (waterLevels.length < 7) estimated = true;

    const features = {
      station_id: location.location_id,
      latitude: Number(location.latitude),
      longitude: Number(location.longitude),
      elevation_m: need(terrain && terrain.elevation_m, DEFAULTS.elevation_m),
      slope_deg: need(terrain && terrain.slope_deg, DEFAULTS.slope_deg),
      rainfall_1h: need(rainfall && rainfall.window_1h, DEFAULTS.rainfall_1h),
      rainfall_3h: need(rainfall && rainfall.window_3h, DEFAULTS.rainfall_3h),
      rainfall_6h: need(rainfall && rainfall.window_6h, DEFAULTS.rainfall_6h),
      rainfall_12h: need(rainfall && rainfall.window_12h, DEFAULTS.rainfall_12h),
      rainfall_24h: need(rainfall && rainfall.window_24h, DEFAULTS.rainfall_24h),
      soil_moisture: need(soilMoisture && soilMoisture.moisture_pct, DEFAULTS.soil_moisture),
      moisture_change_3h: DEFAULTS.moisture_change_3h,
      water_level_m: currentLevel,
      water_level_lag1h: lag1,
      water_level_lag3h: lag3,
      water_level_lag6h: lag6,
      water_level_change_1h: currentLevel - lag1,
      water_level_change_3h: currentLevel - lag3,
      rise_rate_m_per_hour: currentLevel - lag1,
      recent_event_count: recentEventCount,
      event_proximity_km: DEFAULTS.event_proximity_km
    };
    return { features, estimated };
  }

  router.get("/forecast", async (req, res) => {
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

      const [terrain, waterLevels, rainfall, soilMoisture, recentEventCount] = await Promise.all([
        fetchTerrain(pool, locationId),
        fetchRecentWaterLevels(pool, locationId),
        fetchLatestRainfall(pool, locationId),
        fetchLatestSoilMoisture(pool, locationId),
        fetchRecentEventCount(pool, locationId)
      ]);

      const { features, estimated } = buildFeatures({
        location, terrain, waterLevels, rainfall, soilMoisture, recentEventCount
      });

      const forecast = await runM5Forecast(features);

      // Freshness gate on the three time-varying inputs the forecast reads
      // (terrain is static, no timestamp). Purely additive — never touches
      // `features` or what runM5Forecast() saw.
      const gate = evaluateFreshnessGate([
        { key: "water_level", dataType: "water_level_readings", timestamp: waterLevels[0] && waterLevels[0].timestamp, critical: true },
        { key: "rainfall", dataType: "rainfall_readings", timestamp: rainfall && rainfall.timestamp, critical: true },
        { key: "soil_moisture", dataType: "soil_moisture_readings", timestamp: soilMoisture && soilMoisture.timestamp, critical: true }
      ]);

      res.json({
        location_id: location.location_id,
        place_name: location.place_name,
        current_level_m: features.water_level_m,
        forecast_1h: forecast.forecast_1h,
        forecast_3h: forecast.forecast_3h,
        forecast_6h: forecast.forecast_6h,
        model_version: forecast.model_version,
        data_is_synthetic: forecast.data_is_synthetic,
        data_quality: estimated ? "estimated" : "measured",
        data_freshness: gate.freshness,
        degraded_confidence: estimated || gate.degraded_confidence,
        degraded_confidence_reason: gate.degraded_confidence_reason || (estimated ? "m5_inputs_estimated" : null),
        generated_at: new Date().toISOString()
      });
    } catch (error) {
      console.error("M5 forecast error:", error.message);
      res.status(500).json({ message: "Unable to run the M5 forecast." });
    }
  });

  return router;
}

module.exports = m5Routes;
