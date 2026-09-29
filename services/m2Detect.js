// services/m2Detect.js
//
// M2 Anomaly/Event Detector — supporting/operational module.
//
// FloodGuard's brief calls for M2 to classify flash-flood events from
// live CCTV video. No real camera-video pipeline exists yet (same
// constraint M1 documents for its single-frame estimate — see
// ml/m1/README.md), so this module runs a RULE-BASED check against the
// same mock rainfall/water-level data the rest of the app already uses,
// as a stand-in for that video-based event classification.
//
//   *** A real version of M2 would run a trained video/event-classification
//   *** model (e.g. a CNN or temporal model looking at camera frames for
//   *** debris surges, sudden waterline jumps, or turbulent-flow patterns)
//   *** and would report event_type/confidence/anomaly_score from THAT
//   *** model's output — not from a threshold comparison on numeric
//   *** telemetry, which is all this prototype does. ***
//
// Detection rule (either trigger alone is enough to flag an event; both
// triggering together is reported as a distinct, more severe event_type):
//   - rise_rate_m_per_hr (the location's latest water_level_readings row)
//     exceeds config/m2Policy.json's rise_rate_threshold_m_per_hr
//   - rainfall_1h (the location's latest rainfall_readings row) exceeds
//     config/m2Policy.json's rainfall_1h_threshold_mm
//
// confidence and anomaly_score are both deterministic functions of how far
// past its threshold the triggering value is (capped at 1.0) — a
// placeholder stand-in for a real model's learned confidence, not a
// calibrated probability. Never presented to the user as anything but a
// prototype value (see routes/m2.js's `prototype: true` on every response).

const fs = require("fs");
const path = require("path");

const POLICY_PATH = path.join(__dirname, "..", "config", "m2Policy.json");

function loadPolicy() {
  const raw = fs.readFileSync(POLICY_PATH, "utf8");
  return JSON.parse(raw);
}

// Scales how far `value` is past `threshold` into a 0-1 score. 0 right at
// the threshold, saturating at 1.0 once value reaches
// threshold * (1 + headroom).
function severity(value, threshold, headroom) {
  if (!Number.isFinite(value) || !Number.isFinite(threshold) || threshold <= 0) return 0;
  if (value <= threshold) return 0;
  const span = threshold * headroom;
  if (span <= 0) return 1;
  return Math.min(1, (value - threshold) / span);
}

/**
 * Runs the rule-based check against one location's latest mock readings.
 *
 * @param {object} input
 * @param {number} input.location_id
 * @param {number|null} input.rise_rate_m_per_hr - latest water-level rise rate, or null if no reading exists
 * @param {number|null} input.rainfall_1h - latest 1h rainfall accumulation in mm, or null if no reading exists
 * @param {string|Date} [input.timestamp] - defaults to now
 * @param {object} [policyOverride] - injects a policy object directly (tests); defaults to reading config/m2Policy.json
 * @returns {object|null} the event object below, or null if neither threshold was crossed
 *   { location_id, event_type, confidence, anomaly_score, timestamp, source, triggers }
 */
function detectEvent(input, policyOverride) {
  const policy = policyOverride || loadPolicy();

  const riseRate = input.rise_rate_m_per_hr === null || input.rise_rate_m_per_hr === undefined
    ? null : Number(input.rise_rate_m_per_hr);
  const rainfall1h = input.rainfall_1h === null || input.rainfall_1h === undefined
    ? null : Number(input.rainfall_1h);

  const riseTriggered = riseRate !== null && Number.isFinite(riseRate) && riseRate > policy.rise_rate_threshold_m_per_hr;
  const rainTriggered = rainfall1h !== null && Number.isFinite(rainfall1h) && rainfall1h > policy.rainfall_1h_threshold_mm;

  if (!riseTriggered && !rainTriggered) return null;

  const riseSeverity = riseTriggered ? severity(riseRate, policy.rise_rate_threshold_m_per_hr, policy.saturation_headroom) : 0;
  const rainSeverity = rainTriggered ? severity(rainfall1h, policy.rainfall_1h_threshold_mm, policy.saturation_headroom) : 0;

  let event_type;
  if (riseTriggered && rainTriggered) event_type = "combined_surge";
  else if (riseTriggered) event_type = "rapid_water_rise";
  else event_type = "heavy_rainfall";

  const anomaly_score = Number(Math.max(riseSeverity, rainSeverity).toFixed(3));
  // A rule that has fired is never "unsure" about whether the threshold was
  // crossed, so confidence starts at policy.base_confidence (not 0) and
  // climbs toward 1.0 with severity — this is a placeholder curve standing
  // in for a real classifier's confidence, not a calibrated probability.
  const confidence = Number(
    Math.min(1, policy.base_confidence + anomaly_score * (1 - policy.base_confidence)).toFixed(3)
  );

  return {
    location_id: input.location_id,
    event_type,
    confidence,
    anomaly_score,
    timestamp: input.timestamp ? new Date(input.timestamp).toISOString() : new Date().toISOString(),
    source: "m2_rule_based_prototype",
    triggers: {
      rise_rate_m_per_hr: riseRate,
      rainfall_1h_mm: rainfall1h,
      rise_rate_threshold_m_per_hr: policy.rise_rate_threshold_m_per_hr,
      rainfall_1h_threshold_mm: policy.rainfall_1h_threshold_mm
    }
  };
}

module.exports = { detectEvent, loadPolicy };
