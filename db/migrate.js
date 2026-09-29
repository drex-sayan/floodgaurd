// db/migrate.js
//
// Creates the MySQL tables needed for FloodGuard's data layer (locations,
// sensor reading tables, terrain, historical events, model registry).
// Does NOT touch `users` or `sessions` — those stay owned by server.js/auth.js.
//
// Safe to re-run any time: every statement is CREATE TABLE IF NOT EXISTS.
//
// Usage:
//   node db/migrate.js
//   npm run db:migrate

require("dotenv").config();

const fs = require("fs");
const path = require("path");
const mysql = require("mysql2/promise");

const requiredEnv = ["DB_HOST", "DB_USER", "DB_NAME"];
for (const key of requiredEnv) {
  if (!process.env[key]) {
    console.error(`Missing required environment variable: ${key}`);
    process.exit(1);
  }
}

const dbConfig = {
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT) || 3306,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD ?? "",
  database: process.env.DB_NAME,
  multipleStatements: true
};

// Order matters: locations must exist before anything that has a
// FOREIGN KEY back to it.
const TABLE_ORDER = [
  "locations",
  "rainfall_readings",
  "soil_moisture_readings",
  "water_level_readings",
  "terrain_features",
  "historical_events",
  // M2 Anomaly/Event Detector output — see services/m2Detect.js.
  "cctv_events",
  "model_versions",
  // Alert Engine tables — these reference users(id), so `users` must already
  // exist (start the app once with `npm start` before running this on a
  // brand-new database).
  "user_zone_state",
  "user_notification_prefs",
  "alerts"
];

function splitStatements(sql) {
  // Strip full-line SQL comments first, then split on statement-terminating
  // semicolons. (Simple and safe here: this file only ever contains
  // CREATE TABLE statements with no semicolons inside string literals.)
  const withoutComments = sql
    .split("\n")
    .filter(line => !line.trim().startsWith("--"))
    .join("\n");

  return withoutComments
    .split(";")
    .map(s => s.trim())
    .filter(s => s.length > 0);
}

async function main() {
  const schemaPath = path.join(__dirname, "schema.sql");
  const schemaSql = fs.readFileSync(schemaPath, "utf8");
  const statements = splitStatements(schemaSql);

  const connection = await mysql.createConnection(dbConfig);
  console.log(`Connected to database "${process.env.DB_NAME}"`);

  try {
    for (const statement of statements) {
      const tableMatch = statement.match(/CREATE TABLE IF NOT EXISTS (\w+)/i);
      const label = tableMatch ? tableMatch[1] : "statement";
      await connection.query(statement);
      console.log(`✓ ${label} ready`);
    }

    // Sanity check: confirm every table we expect is actually present.
    const [rows] = await connection.query(
      `SELECT TABLE_NAME FROM information_schema.TABLES
       WHERE TABLE_SCHEMA = ? AND TABLE_NAME IN (?)`,
      [process.env.DB_NAME, TABLE_ORDER]
    );
    const found = new Set(rows.map(r => r.TABLE_NAME));
    const missing = TABLE_ORDER.filter(t => !found.has(t));

    if (missing.length) {
      console.error(`✗ Migration incomplete, missing: ${missing.join(", ")}`);
      process.exitCode = 1;
    } else {
      console.log("✓ All FloodGuard data-layer tables are present.");
    }
  } finally {
    await connection.end();
  }
}

main().catch(error => {
  console.error("✗ Migration failed:", error.message);
  process.exit(1);
});
