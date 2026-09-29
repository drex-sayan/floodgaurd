// services/alertEngine.js
//
// Decides whether a Red/Yellow zone transition should notify a user, and
// logs the outcome. Called from routes/geofence.js whenever
// /api/geofence/check finds transitioned === true.
//
//   Red zone entry    -> immediate SMS + email (per user prefs)
//   Yellow zone entry -> preparedness notification (per user prefs)
//   Green / outside   -> never notified
//
// IMPORTANT:
// There is NO cooldown for Yellow or Red alerts.
// Every valid Yellow/Red transition is allowed to send a new notification.
// cooldown_until is always NULL for newly created alerts.
//

const policy = require("../config/alertPolicy.json");
const notifyProvider = require("../lib/notifyProvider");

const ALERTABLE_ZONES = ["yellow", "red"];

function isAlertableZone(zone) {
  return ALERTABLE_ZONES.includes(zone);
}

async function fetchUserPrefs(pool, userId) {
  // Always have the account email available as a safe fallback.
  // A user may have created an account but never explicitly saved
  // notification preferences.
  const [rows] = await pool.execute(
    `SELECT p.sms_enabled, p.email_enabled, p.phone_number,
            COALESCE(NULLIF(p.email_address, ''), u.email) AS email_address
     FROM users u
     LEFT JOIN user_notification_prefs p ON p.user_id = u.id
     WHERE u.id = ?
     LIMIT 1`,
    [userId]
  );

  return (
    rows[0] || {
      sms_enabled: 0,
      email_enabled: 1,
      phone_number: null,
      email_address: null
    }
  );
}

// Kept for compatibility with existing code/module structure.
// There is intentionally NO cooldown check anymore.
async function fetchActiveCooldown(pool, userId, locationId, zone) {
  return null;
}

// Kept for compatibility.
// Always returns false because Yellow and Red have no cooldown.
function cooldownStillActive(lastSentAlert, now) {
  return false;
}

// Which channels does policy allow for this zone, intersected with what the
// user actually enabled and gave us contact info for.
function resolveChannels(policyChannel, prefs) {
  const wantsSms =
    policyChannel === "sms" || policyChannel === "both";

  const wantsEmail =
    policyChannel === "email" || policyChannel === "both";

  const attemptSms =
    wantsSms &&
    !!prefs.sms_enabled &&
    !!prefs.phone_number;

  const attemptEmail =
    wantsEmail &&
    !!prefs.email_enabled &&
    !!prefs.email_address;

  return {
    attemptSms,
    attemptEmail
  };
}

function channelLabel(attemptSms, attemptEmail) {
  if (attemptSms && attemptEmail) return "both";
  if (attemptSms) return "sms";
  if (attemptEmail) return "email";
  return null;
}

function alertCopy(zone, placeName) {
  const where = placeName || "your monitored location";

  if (zone === "red") {
    return {
      subject: `FloodGuard RED ALERT — ${where}`,
      message:
        `FloodGuard: You have entered a RED flash-flood risk zone near ${where}. ` +
        `Move to higher ground immediately and follow local authority guidance.`
    };
  }

  return {
    subject: `FloodGuard preparedness notice — ${where}`,
    message:
      `FloodGuard: You have entered a YELLOW flash-flood watch zone near ${where}. ` +
      `Stay alert, monitor conditions, and prepare to move to higher ground if risk increases.`
  };
}

async function insertAlertRow(pool, row) {
  const [result] = await pool.execute(
    `INSERT INTO alerts
       (user_id, location_id, zone, channel, model_version,
        evidence_summary, delivery_status, cooldown_until)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      row.userId,
      row.locationId,
      row.zone,
      row.channel,
      row.modelVersion ?? null,
      row.evidenceSummary
        ? JSON.stringify(row.evidenceSummary)
        : null,
      row.deliveryStatus,
      // Always NULL because there is no cooldown.
      null
    ]
  );

  return result.insertId;
}

/**
 * @param {import('mysql2/promise').Pool} pool
 * @param {Object} input
 * @param {number} input.userId
 * @param {number} input.locationId
 * @param {string} input.zone - 'red' | 'yellow'
 * @param {string} [input.placeName]
 * @param {string} [input.modelVersion]
 * @param {Object} [input.evidenceSummary]
 *
 * @returns {Promise<{
 *   alertId:number,
 *   deliveryStatus:string,
 *   channel:string|null,
 *   cooldownUntil:null
 * }|{skipped:true, reason:string}>}
 */
async function evaluateAndNotify(pool, input) {
  const {
    userId,
    locationId,
    zone,
    placeName,
    modelVersion,
    evidenceSummary
  } = input;

  // Green/outside never alerts.
  if (!isAlertableZone(zone)) {
    return {
      skipped: true,
      reason: "zone_not_alertable"
    };
  }

  const policyChannel = policy.channel_by_zone[zone];

  // ---------------------------------------------------------
  // NO COOLDOWN
  // ---------------------------------------------------------
  //
  // Previously this checked fetchActiveCooldown() and could return
  // "skipped_cooldown".
  //
  // That logic has intentionally been removed.
  //
  // Every Yellow/Red transition reaches the notification provider.
  // ---------------------------------------------------------

  const prefs = await fetchUserPrefs(pool, userId);

  const {
    attemptSms,
    attemptEmail
  } = resolveChannels(policyChannel, prefs);

  const channel = channelLabel(
    attemptSms,
    attemptEmail
  );

  // No cooldown for either Yellow or Red.
  const cooldownUntil = null;

  const {
    subject,
    message
  } = alertCopy(zone, placeName);

  const results = {};

  // Run SMS and email in parallel.
  const [
    smsResult,
    emailResult
  ] = await Promise.all([
    attemptSms
      ? notifyProvider.sendSms(
          prefs.phone_number,
          message
        )
      : Promise.resolve(null),

    attemptEmail
      ? notifyProvider.sendEmail(
          prefs.email_address,
          subject,
          message
        )
      : Promise.resolve(null)
  ]);

  if (attemptSms) {
    results.sms = smsResult;
  }

  if (attemptEmail) {
    results.email = emailResult;
  }

  const attemptedResults =
    Object.values(results);

  const allSucceeded =
    attemptedResults.length > 0 &&
    attemptedResults.every(
      (r) => r && r.success
    );

  const deliveryStatus =
    channel && allSucceeded
      ? "sent"
      : "failed";

  console.log(
    `[alertEngine] user=${userId} ` +
    `location=${locationId} ` +
    `zone=${zone} ` +
    `channel=${channel || policyChannel} ` +
    `delivery=${deliveryStatus} ` +
    `cooldown=NONE`
  );

  if (attemptEmail) {
    console.log(
      `[alertEngine] email recipient configured=` +
      `${Boolean(prefs.email_address)} ` +
      `enabled=${Boolean(prefs.email_enabled)}`
    );
  }

  // Always write the alert to history.
  // cooldown_until is explicitly NULL.
  const alertId = await insertAlertRow(pool, {
    userId,
    locationId,
    zone,

    // Log the nominal policy channel even when delivery fails.
    channel:
      channel || policyChannel,

    modelVersion,

    evidenceSummary: {
      ...evidenceSummary,

      provider_results: results,

      // Useful for debugging/demo verification.
      cooldown_policy: "none",

      reason: channel
        ? undefined
        : "no_enabled_channel_or_contact_info"
    },

    deliveryStatus,

    // No cooldown.
    cooldownUntil: null
  });

  return {
    alertId,
    deliveryStatus,
    channel:
      channel || policyChannel,

    // Always null.
    cooldownUntil: null
  };
}

module.exports = {
  evaluateAndNotify,
  isAlertableZone,
  resolveChannels,
  channelLabel
};