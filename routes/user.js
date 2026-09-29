// routes/user.js
//
//   GET  /api/user/preferences   -> current user's notification prefs
//   POST /api/user/preferences   -> upsert notification prefs
//
// Backs the "Notification preferences" form on the Settings page. This is
// deliberately separate from account fields (name/email/password, owned by
// server.js's auth routes) — these are delivery preferences the Alert
// Engine reads, not identity.

const express = require("express");

const PHONE_RE = /^\+?[0-9()\-.\s]{7,20}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function userRoutes(getPool) {
  const router = express.Router();

  router.get("/preferences", async (req, res) => {
    try {
      const pool = getPool();
      const [rows] = await pool.execute(
        `SELECT sms_enabled, email_enabled, phone_number, email_address
         FROM user_notification_prefs WHERE user_id = ? LIMIT 1`,
        [req.user.id]
      );

      const prefs = rows[0] || {
        sms_enabled: 0,
        email_enabled: 1,
        phone_number: null,
        // Sensible default: the account's login email, until the user
        // explicitly overrides it below.
        email_address: req.user.email
      };

      res.json({
        sms_enabled: !!prefs.sms_enabled,
        email_enabled: !!prefs.email_enabled,
        phone_number: prefs.phone_number,
        email_address: prefs.email_address
      });
    } catch (error) {
      console.error("Fetch preferences error:", error);
      res.status(500).json({ message: "Unable to load notification preferences." });
    }
  });

  router.post("/preferences", async (req, res) => {
    try {
      const body = req.body || {};
      const smsEnabled = !!body.sms_enabled;
      const emailEnabled = !!body.email_enabled;
      const phoneNumber = body.phone_number ? String(body.phone_number).trim() : null;
      const emailAddress = body.email_address ? String(body.email_address).trim().toLowerCase() : null;

      if (smsEnabled && (!phoneNumber || !PHONE_RE.test(phoneNumber))) {
        return res.status(400).json({ message: "A valid phone number is required to enable SMS alerts." });
      }
      if (emailEnabled && (!emailAddress || !EMAIL_RE.test(emailAddress))) {
        return res.status(400).json({ message: "A valid email address is required to enable email alerts." });
      }

      const pool = getPool();
      await pool.execute(
        `INSERT INTO user_notification_prefs
           (user_id, sms_enabled, email_enabled, phone_number, email_address)
         VALUES (?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           sms_enabled = VALUES(sms_enabled),
           email_enabled = VALUES(email_enabled),
           phone_number = VALUES(phone_number),
           email_address = VALUES(email_address)`,
        [req.user.id, smsEnabled ? 1 : 0, emailEnabled ? 1 : 0, phoneNumber, emailAddress]
      );

      res.json({
        success: true,
        message: "Notification preferences saved.",
        preferences: {
          sms_enabled: smsEnabled,
          email_enabled: emailEnabled,
          phone_number: phoneNumber,
          email_address: emailAddress
        }
      });
    } catch (error) {
      console.error("Save preferences error:", error);
      res.status(500).json({ message: "Unable to save notification preferences." });
    }
  });

  return router;
}

module.exports = userRoutes;
