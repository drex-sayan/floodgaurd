require("dotenv").config();

const { sendEmail, verifyEmailTransport } = require("../lib/notifyProvider");

async function main() {
  const to = process.argv[2];
  if (!to) {
    console.error("Usage: npm run test:email -- recipient@example.com");
    process.exit(1);
  }

  const verification = await verifyEmailTransport();
  if (!verification.success) {
    console.error("SMTP verification failed. Check your .env SMTP settings and credentials.");
    process.exit(1);
  }

  const result = await sendEmail(
    to,
    "FloodGuard SMTP test",
    "This is a real SMTP test from FloodGuard. If you received this email, SMTP delivery is configured correctly."
  );

  if (!result.success) {
    console.error(`Email test failed: ${result.error || "unknown error"}`);
    process.exit(1);
  }

  console.log(`Email test accepted by SMTP server. Message ID: ${result.providerId || "n/a"}`);
}

main().catch((error) => {
  console.error("Email test crashed:", error.message);
  process.exit(1);
});
