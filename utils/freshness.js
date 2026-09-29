// utils/freshness.js
//
// Shared "data freshness" utility — Realtime Behavior phase.
//
// Every reading table in the schema (rainfall_readings, water_level_readings,
// soil_moisture_readings, cctv_events) already carries a `timestamp` /
// `detected_at` column. Until now, nothing looked at how OLD that timestamp
// was before a module used the row: the Zone Engine hand-rolled its own
// age check for water_level_readings only (services/zoneEngine.js's
// isFreshGoodWaterLevel(), against config/zonePolicy.json's
// water_level_rise_adjustment.max_data_age_minutes). This file generalizes
// that same idea — age_seconds against a per-data-type threshold, read from
// config, never hardcoded — into one place every route can share, instead
// of duplicating the pattern per module.
//
// DESIGN RULE (mirrors services/zoneEngine.js): this module never guesses.
// A missing timestamp is reported as status 'missing', not silently treated
// as fresh. Callers decide what to do with that status; this file only
// classifies.
//
// This is purely additive: nothing here changes how M1–M5 compute their
// results. It only classifies how old the inputs they already read were,
// so routes can attach a freshness badge and (per data type) a
// degraded_confidence flag to their existing response — the same
// degraded_confidence / degraded_confidence_reason field pair
// services/zoneEngine.js already returns (see its header comment / Phase
// 8B), just generalized here so every module can set it consistently.

const policy = require("../config/freshnessPolicy.json");

const STATUS = Object.freeze({
  FRESH: "fresh",
  STALE: "stale",
  EXPIRED: "expired",
  MISSING: "missing"
});

function getThresholds(dataType) {
  const entry = (policy.thresholds && policy.thresholds[dataType]) || policy.default || {};
  const staleAfterMinutes = Number.isFinite(Number(entry.stale_after_minutes)) ? Number(entry.stale_after_minutes) : 30;
  const expiredAfterMinutes = Number.isFinite(Number(entry.expired_after_minutes)) ? Number(entry.expired_after_minutes) : 120;
  return { stale_after_minutes: staleAfterMinutes, expired_after_minutes: expiredAfterMinutes };
}

// Classifies a single reading's age.
//
//   classifyFreshness({ timestamp, dataType })
//
//   timestamp — the reading's own timestamp (Date, ISO string, or anything
//               `new Date()` accepts). null/undefined -> status 'missing'.
//   dataType  — one of config/freshnessPolicy.json's `thresholds` keys
//               (e.g. 'water_level_readings'). Unknown types fall back to
//               the policy's `default` thresholds rather than throwing, so
//               a new reading table can be wired in before its own
//               threshold entry is added.
//
// Returns:
//   {
//     available: boolean,           // false only when timestamp is missing/unparseable
//     status: 'fresh'|'stale'|'expired'|'missing',
//     age_seconds: number|null,     // null when unavailable
//     data_type: string,
//     stale_after_minutes: number,
//     expired_after_minutes: number,
//     policy_version: string
//   }
function classifyFreshness({ timestamp, dataType } = {}) {
  const { stale_after_minutes, expired_after_minutes } = getThresholds(dataType);

  if (timestamp === null || timestamp === undefined || timestamp === "") {
    return {
      available: false,
      status: STATUS.MISSING,
      age_seconds: null,
      data_type: dataType || null,
      stale_after_minutes,
      expired_after_minutes,
      policy_version: policy.freshness_policy_version
    };
  }

  const readingMs = new Date(timestamp).getTime();
  if (!Number.isFinite(readingMs)) {
    return {
      available: false,
      status: STATUS.MISSING,
      age_seconds: null,
      data_type: dataType || null,
      stale_after_minutes,
      expired_after_minutes,
      policy_version: policy.freshness_policy_version
    };
  }

  // Clock skew / just-inserted rows can land a hair in the future — clamp
  // to 0 rather than reporting a negative age.
  const ageSeconds = Math.max(0, (Date.now() - readingMs) / 1000);
  const ageMinutes = ageSeconds / 60;

  let status = STATUS.FRESH;
  if (ageMinutes > expired_after_minutes) status = STATUS.EXPIRED;
  else if (ageMinutes > stale_after_minutes) status = STATUS.STALE;

  return {
    available: true,
    status,
    age_seconds: Math.round(ageSeconds),
    data_type: dataType || null,
    stale_after_minutes,
    expired_after_minutes,
    policy_version: policy.freshness_policy_version
  };
}

// Evaluates a set of named inputs and derives one degraded_confidence
// flag from them — the same field shape services/zoneEngine.js already
// returns (degraded_confidence: boolean, degraded_confidence_reason:
// string|null), generalized so any route can call this instead of
// hand-rolling its own gate.
//
//   evaluateFreshnessGate([
//     { key: 'rainfall', dataType: 'rainfall_readings', timestamp, critical: true },
//     { key: 'water_level', dataType: 'water_level_readings', timestamp, critical: true },
//     ...
//   ])
//
// Only entries with critical: true (default true when omitted) can force
// degraded_confidence: true; non-critical entries still get classified and
// returned in `freshness` for display, they just can't gate the flag —
// e.g. a card that shows a reading for context but doesn't rely on it
// being fresh.
//
// Returns:
//   {
//     degraded_confidence: boolean,
//     degraded_confidence_reason: string|null,   // comma-joined offending keys+status
//     freshness: { [key]: <classifyFreshness() result> }
//   }
function evaluateFreshnessGate(entries) {
  const freshness = {};
  const reasons = [];
  let degraded = false;

  for (const entry of entries || []) {
    const result = classifyFreshness({ timestamp: entry.timestamp, dataType: entry.dataType });
    freshness[entry.key] = result;

    const critical = entry.critical !== false;
    const isBad = result.status === STATUS.STALE || result.status === STATUS.EXPIRED || result.status === STATUS.MISSING;
    if (critical && isBad) {
      degraded = true;
      reasons.push(`${entry.key}_${result.status}`);
    }
  }

  return {
    degraded_confidence: degraded,
    degraded_confidence_reason: reasons.length ? reasons.join(",") : null,
    freshness
  };
}

module.exports = {
  STATUS,
  getThresholds,
  classifyFreshness,
  evaluateFreshnessGate
};
