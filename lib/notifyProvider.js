// lib/notifyProvider.js
// Real SMTP email provider. AlertEngine keeps the same sendEmail() interface.
// Configure SMTP in .env; never put credentials in source code.

const nodemailer = require("nodemailer");

function envBool(value, fallback = false) {
  if (value == null || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(String(value).trim().toLowerCase());
}

const EMAIL_ENABLED = envBool(process.env.EMAIL_ENABLED, false);
const SMTP_HOST = String(process.env.SMTP_HOST || "").trim();
const SMTP_PORT = Number(process.env.SMTP_PORT || 587);
const SMTP_SECURE = envBool(process.env.SMTP_SECURE, SMTP_PORT === 465);
const SMTP_USER = String(process.env.SMTP_USER || "").trim();
const SMTP_PASS = String(process.env.SMTP_PASS || "");
const ALERT_FROM = String(process.env.ALERT_FROM || SMTP_USER).trim();

let transporter = null;

function emailConfigError() {
  if (!EMAIL_ENABLED) return "Real email delivery is disabled. Set EMAIL_ENABLED=true in .env.";
  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS || !ALERT_FROM) {
    return "SMTP email is not configured. Set SMTP_HOST, SMTP_USER, SMTP_PASS and ALERT_FROM in .env.";
  }
  if (!Number.isInteger(SMTP_PORT) || SMTP_PORT <= 0) return "SMTP_PORT must be a valid port number.";
  return null;
}

function getTransporter() {
  const configError = emailConfigError();
  if (configError) return { transporter: null, error: configError };

  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: SMTP_HOST,
      port: SMTP_PORT,
      secure: SMTP_SECURE,
      auth: { user: SMTP_USER, pass: SMTP_PASS },
      pool: true,
      maxConnections: 3,
      maxMessages: 100,
      connectionTimeout: 10000,
      greetingTimeout: 10000,
      socketTimeout: 20000
    });
  }
  return { transporter, error: null };
}

async function sendEmail(to, subject, body) {
  if (!to) return { success: false, providerId: null, error: "No email address on file." };

  const { transporter: mailer, error: configError } = getTransporter();
  if (configError) {
    console.error(`[notifyProvider] EMAIL not sent: ${configError}`);
    return { success: false, providerId: null, error: configError };
  }

  try {
    const info = await mailer.sendMail({
      from: ALERT_FROM,
      to,
      subject,
      text: body
    });

    console.log(`[notifyProvider] REAL EMAIL sent to ${to} (messageId=${info.messageId})`);
    return { success: true, providerId: info.messageId || null, error: null };
  } catch (error) {
    console.error(`[notifyProvider] REAL EMAIL failed for ${to}:`, error.message);
    return { success: false, providerId: null, error: error.message };
  }
}

async function verifyEmailTransport() {
  const { transporter: mailer, error: configError } = getTransporter();
  if (configError) {
    console.error(`[notifyProvider] SMTP verification skipped: ${configError}`);
    return { success: false, error: configError };
  }
  try {
    await mailer.verify();
    console.log(`[notifyProvider] SMTP connection verified (${SMTP_HOST}:${SMTP_PORT})`);
    return { success: true, error: null };
  } catch (error) {
    console.error(`[notifyProvider] SMTP verification failed: ${error.message}`);
    return { success: false, error: error.message };
  }
}

// SMS remains a deliberate mock until a real SMS provider is configured.
async function sendSms(to, message) {
  if (!to) return { success: false, providerId: null, error: "No phone number on file." };
  console.log(`[notifyProvider mock] SMS -> ${to}: ${message}`);
  return { success: true, providerId: `mock_sms_${Date.now().toString(36)}`, error: null };
}

module.exports = { sendSms, sendEmail, verifyEmailTransport };
