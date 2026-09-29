// routes/alerts.js
//
//   GET /api/alerts?limit=20
//
// Returns the current user's own alert delivery history (most recent
// first), joined with place_name so the UI doesn't need a second call.
// Backs the "Alert History" panel on overview.html.

const express = require("express");

function toNumberOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function alertsRoutes(getPool) {
  const router = express.Router();

  router.get("/", async (req, res) => {
    try {
      const pool = getPool();
      // LIMIT is inlined (not bound) because mysql2's prepared-statement
      // protocol handles numeric LIMIT params inconsistently across
      // versions. Safe here because `limit` is clamped to a validated
      // integer in [1, 100] on the line above, never raw user input.
      const limit = Math.min(Math.max(Math.trunc(toNumberOrNull(req.query.limit) || 20), 1), 100);

      const [rows] = await pool.execute(
        `SELECT a.alert_id, a.zone, a.channel, a.delivery_status, a.issued_at,
                a.model_version, a.evidence_summary, l.place_name
         FROM alerts a
         JOIN locations l ON l.location_id = a.location_id
         WHERE a.user_id = ?
         ORDER BY a.issued_at DESC
         LIMIT ${limit}`,
        [req.user.id]
      );

      res.json({
        alerts: rows.map((row) => ({
          alert_id: row.alert_id,
          place_name: row.place_name,
          zone: row.zone,
          channel: row.channel,
          delivery_status: row.delivery_status,
          issued_at: row.issued_at,
          model_version: row.model_version
        }))
      });
    } catch (error) {
      console.error("Alert history error:", error);
      res.status(500).json({ message: "Unable to load alert history." });
    }
  });

  return router;
}

module.exports = alertsRoutes;
