// services/zoneEngine.js
//
// Zone Engine — turns an M3 flash-flood prediction into Red/Yellow/Green
// geographic risk rings, centered on a resolved location.
//
// DESIGN RULE: computeZoneRadii() intentionally does NOT accept the raw
// M3 flood_probability at all — only the categorical risk_level band
// (LOW/MODERATE/HIGH/EXTREME) and the location's latest water-level
// reading. That is not an oversight: the task calls out that this engine
// must not "map probability linearly to distance," and the easiest way to
// guarantee that is to make it structurally impossible for probability to
// reach the radius math. Probability is still accepted by the /api/zones
// route (see routes/zones.js) and echoed back in the response for display,
// it just never touches this function.
//
// Everything else that shapes a radius — the base per-band distance, the
// water-level rise-rate tiers, and the multipliers each tier applies — is
// read from config/zonePolicy.json, so ops/product can retune the policy
// without touching this file. See the "Zone Engine" section of
// README_M3_MVP.md for how to edit that config.

const policy = require("../config/zonePolicy.json");

const RISK_BANDS = ["LOW", "MODERATE", "HIGH", "EXTREME"];

function normalizeRiskLevel(riskLevel) {
  const upper = String(riskLevel || "").trim().toUpperCase();
  return RISK_BANDS.includes(upper) ? upper : null;
}

function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

// A water-level reading is only usable evidence if it explicitly states
// good data quality, has a numeric rise rate, and is fresh enough per
// config/zonePolicy.json's max_data_age_minutes. Anything else (missing
// row, stale timestamp, non-'good' quality_status, null rise rate) must
// fall back to the M3-only radius rather than silently guessing.
function isFreshGoodWaterLevel(reading, adjustmentConfig) {
  if (!reading) return false;

  const requiredQuality = adjustmentConfig.required_quality_status || "good";
  if (reading.quality_status !== requiredQuality) return false;

  const riseRate = Number(reading.rise_rate_m_per_hr);
  if (!Number.isFinite(riseRate)) return false;

  if (!reading.timestamp) return false;
  const readingTime = new Date(reading.timestamp).getTime();
  if (!Number.isFinite(readingTime)) return false;

  const ageMinutes = (Date.now() - readingTime) / 60000;
  const maxAgeMinutes = Number(adjustmentConfig.max_data_age_minutes ?? 45);
  if (ageMinutes < 0 || ageMinutes > maxAgeMinutes) return false;

  return true;
}

function degradedReason(reading, adjustmentConfig) {
  if (!reading) return "no_water_level_data";
  const requiredQuality = adjustmentConfig.required_quality_status || "good";
  if (reading.quality_status !== requiredQuality) return "water_level_quality_not_" + requiredQuality;
  if (!Number.isFinite(Number(reading.rise_rate_m_per_hr))) return "water_level_rise_rate_missing";
  return "water_level_data_stale";
}

// Tiers are configured ascending by min_rise_rate_m_per_hr. We walk the
// whole list and keep the last (highest) tier the rise rate still clears,
// so e.g. a rise rate of 0.9 m/hr with tiers at 0.10/0.25/0.50 lands on
// the 0.50 tier, not the first one it happened to cross.
function pickTierMultiplier(riseRateMPerHr, tiers) {
  let matched = null;
  for (const tier of tiers || []) {
    if (riseRateMPerHr >= Number(tier.min_rise_rate_m_per_hr)) matched = tier;
  }
  return matched ? matched.multiplier : { red: 1, yellow: 1, green: 1 };
}

function round(value, decimals) {
  const factor = Math.pow(10, decimals);
  return Math.round(value * factor) / factor;
}

/**
 * @param {Object} input
 * @param {string} input.riskLevel - LOW | MODERATE | HIGH | EXTREME (from M3 risk_level)
 * @param {Object|null} [input.waterLevel] - latest water_level_readings row for the
 *   location, e.g. { rise_rate_m_per_hr, quality_status, timestamp, level_m, ... }.
 *   Pass null/undefined when no reading exists for this location.
 * @returns {{
 *   red_radius_km: number, yellow_radius_km: number, green_radius_km: number,
 *   zone_policy_version: string, degraded_confidence: boolean,
 *   degraded_confidence_reason: string|null, risk_level: string,
 *   water_level_adjustment_applied: boolean, rise_rate_m_per_hr_used: number|null
 * }}
 */
function computeZoneRadii({ riskLevel, waterLevel } = {}) {
  const band = normalizeRiskLevel(riskLevel);
  if (!band) {
    const err = new Error(`Unknown risk_level "${riskLevel}". Expected one of: ${RISK_BANDS.join(", ")}.`);
    err.code = "INVALID_RISK_LEVEL";
    throw err;
  }

  const base = policy.base_radius_km && policy.base_radius_km[band];
  if (!base || !isFiniteNumber(base.red) || !isFiniteNumber(base.yellow) || !isFiniteNumber(base.green)) {
    const err = new Error(`config/zonePolicy.json has no complete base_radius_km entry for risk band "${band}".`);
    err.code = "MISSING_POLICY_BAND";
    throw err;
  }

  const adjustmentConfig = policy.water_level_rise_adjustment || {};
  const decimals = Number.isInteger(policy.rounding_decimals) ? policy.rounding_decimals : 2;

  const usable = isFreshGoodWaterLevel(waterLevel, adjustmentConfig);

  let multiplier = { red: 1, yellow: 1, green: 1 };
  let riseRateUsed = null;
  let degraded_confidence = !usable;
  let degraded_confidence_reason = usable ? null : degradedReason(waterLevel, adjustmentConfig);

  if (usable) {
    riseRateUsed = Number(waterLevel.rise_rate_m_per_hr);
    multiplier = pickTierMultiplier(riseRateUsed, adjustmentConfig.tiers);
  }

  const water_level_adjustment_applied =
    usable && (multiplier.red !== 1 || multiplier.yellow !== 1 || multiplier.green !== 1);

  return {
    red_radius_km: round(base.red * multiplier.red, decimals),
    yellow_radius_km: round(base.yellow * multiplier.yellow, decimals),
    green_radius_km: round(base.green * multiplier.green, decimals),
    zone_policy_version: policy.zone_policy_version,
    degraded_confidence,
    degraded_confidence_reason,
    risk_level: band,
    water_level_adjustment_applied,
    rise_rate_m_per_hr_used: riseRateUsed
  };
}

module.exports = {
  computeZoneRadii,
  normalizeRiskLevel,
  RISK_BANDS
};
