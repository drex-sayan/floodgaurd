// routes/m2.js
//
// M2 Anomaly/Event Detector — supporting/operational module. Produces
// authority-facing operational alerts; it does not touch M3's flood
// probability, the Zone Engine, or the user-facing geofence Alert Engine
// (services/alertEngine.js / the `alerts` table). See services/m2Detect.js
// for why this is a rule-based stand-in rather than real video analysis.
//
//   GET /api/m2/events?location_id=...&limit=...
//     location_id is optional.
//       - With it: the most recent cctv_events rows for that location
//         (backs the M2 dashboard card).
//       - Without it: the most recent cctv_events rows across every
//         location, joined with place_name (backs the Authority Alerts
//         panel — Phase 10C — since those are operational alerts, not
//         scoped to whichever location a user happens to have selected).
//
//   POST /api/m2/events { location_id }
//     Demo/dev trigger, the same role POST /api/m1/ingest plays for M1:
//     since no scheduled job is wired up yet, this runs one detection
//     cycle for the location against its latest rainfall_readings and
//     water_level_readings rows and, if the rule fires, inserts a
//     cctv_events row. Standing in for what a scheduled check would do.
//     Returns { flagged: false, ... } (no insert) when nothing crosses a
//     threshold, so demo callers can tell "checked, nothing found" apart
//     from a real error.

const express = require("express");
const { detectEvent } = require("../services/m2Detect");
const { classifyFreshness } = require("../utils/freshness");

function toNumberOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function rowToEvent(row) {
  return {
    id: row.id,
    location_id: row.location_id,
    place_name: row.place_name,
    event_type: row.event_type,
    confidence: row.confidence === null ? null : Number(row.confidence),
    anomaly_score: row.anomaly_score === null ? null : Number(row.anomaly_score),
    detected_at: row.detected_at,
    source: row.source,
    // Freshness badge for the M2 dashboard card / Authority Alerts panel —
    // display only, does not change which rows are returned or how M2
    // detection itself works. See utils/freshness.js.
    data_freshness: classifyFreshness({ timestamp: row.detected_at, dataType: "cctv_events" })
  };
}

function m2Routes(getPool) {
  const router = express.Router();

  router.get("/events", async (req, res) => {
    try {
      const pool = getPool();
      const locationId = toNumberOrNull(req.query.location_id);
      const limit = Math.min(Math.max(Math.trunc(toNumberOrNull(req.query.limit) || 20), 1), 100);

      // LIMIT is inlined (not bound), same reasoning as routes/alerts.js:
      // mysql2's prepared-statement protocol handles numeric LIMIT params
      // inconsistently across versions. Safe here because `limit` is
      // clamped to a validated integer in [1, 100] above, never raw input.
      const [rows] = locationId
        ? await pool.execute(
            `SELECT e.id, e.location_id, e.event_type, e.confidence, e.anomaly_score,
                    e.detected_at, e.source, l.place_name
             FROM cctv_events e
             JOIN locations l ON l.location_id = e.location_id
             WHERE e.location_id = ?
             ORDER BY e.detected_at DESC
             LIMIT ${limit}`,
            [locationId]
          )
        : await pool.execute(
            `SELECT e.id, e.location_id, e.event_type, e.confidence, e.anomaly_score,
                    e.detected_at, e.source, l.place_name
             FROM cctv_events e
             JOIN locations l ON l.location_id = e.location_id
             ORDER BY e.detected_at DESC
             LIMIT ${limit}`
          );

      const events = rows.map(rowToEvent);
      // For a single-location query the M2 dashboard card only ever shows
      // events[0] (see overview.html's loadM2Card) — so that's the "result"
      // whose freshness gates degraded_confidence here, same shape as the
      // other M-module routes. The unscoped Authority Alerts query has no
      // single "latest result" to gate, so it only carries per-event badges.
      const gate = locationId && events.length
        ? (() => {
            const f = events[0].data_freshness;
            const degraded = f.status === "stale" || f.status === "expired" || !f.available;
            return { degraded_confidence: degraded, degraded_confidence_reason: degraded ? `m2_latest_event_${f.status}` : null };
          })()
        : { degraded_confidence: locationId ? true : false, degraded_confidence_reason: locationId ? "no_m2_event_data" : null };

      res.json({ events, prototype: true, ...gate });
    } catch (error) {
      console.error("M2 events list error:", error);
      res.status(500).json({ message: "Unable to load M2 events." });
    }
  });

  router.post("/events", async (req, res) => {
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

      const [waterRows] = await pool.execute(
        `SELECT rise_rate_m_per_hr
         FROM water_level_readings
         WHERE location_id = ?
         ORDER BY \`timestamp\` DESC
         LIMIT 1`,
        [locationId]
      );
      const [rainRows] = await pool.execute(
        `SELECT window_1h
         FROM rainfall_readings
         WHERE location_id = ?
         ORDER BY \`timestamp\` DESC
         LIMIT 1`,
        [locationId]
      );

      const riseRate = waterRows[0] ? waterRows[0].rise_rate_m_per_hr : null;
      const rainfall1h = rainRows[0] ? rainRows[0].window_1h : null;

      const event = detectEvent({
        location_id: locationId,
        rise_rate_m_per_hr: riseRate,
        rainfall_1h: rainfall1h
      });

      if (!event) {
        return res.json({
          flagged: false,
          prototype: true,
          location_id: locationId,
          message: "No threshold crossed on the latest mock readings.",
          inputs: { rise_rate_m_per_hr: riseRate, rainfall_1h: rainfall1h }
        });
      }

      const [result] = await pool.execute(
        `INSERT INTO cctv_events (location_id, event_type, confidence, anomaly_score, detected_at, source)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [
          event.location_id,
          event.event_type,
          event.confidence,
          event.anomaly_score,
          new Date(event.timestamp),
          event.source
        ]
      );

      res.json({
        flagged: true,
        prototype: true,
        event: {
          id: result.insertId,
          location_id: event.location_id,
          place_name: locRows[0].place_name,
          event_type: event.event_type,
          confidence: event.confidence,
          anomaly_score: event.anomaly_score,
          detected_at: event.timestamp,
          source: event.source,
          data_freshness: classifyFreshness({ timestamp: event.timestamp, dataType: "cctv_events" })
        },
        triggers: event.triggers,
        degraded_confidence: false,
        degraded_confidence_reason: null
      });
    } catch (error) {
      console.error("M2 event detection error:", error);
      res.status(500).json({ message: "Unable to run the M2 detection check." });
    }
  });

  return router;
}

module.exports = m2Routes;
