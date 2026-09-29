// db/migrate_m1.js
//
// Phase M1 (Water-Level Vision Module) adds four columns to the existing
// `water_level_readings` table: change_10m, change_30m, camera_id, and
// vision_confidence. db/schema.sql already has these in its CREATE TABLE
// statement, so a brand-new database gets them for free via
// `npm run db:migrate`. This script is only for databases that already had
// `water_level_readings` created by an earlier version of schema.sql —
// it ALTERs the table in place, checking information_schema first so it's
// safe to run more than once.
//
// Usage:
//   node db/migrate_m1.js

require("dotenv").config();

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
  database: process.env.DB_NAME
};

const NEW_COLUMNS = [
  { name: "change_10m", ddl: "ADD COLUMN change_10m DECIMAL(7,3) NULL AFTER level_m" },
  { name: "change_30m", ddl: "ADD COLUMN change_30m DECIMAL(7,3) NULL AFTER change_10m" },
  { name: "camera_id", ddl: "ADD COLUMN camera_id VARCHAR(50) NULL AFTER source" },
  { name: "vision_confidence", ddl: "ADD COLUMN vision_confidence DECIMAL(4,3) NULL AFTER camera_id" }
];

async function columnExists(connection, table, column) {
  const [rows] = await connection.query(
    `SELECT COLUMN_NAME FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
    [process.env.DB_NAME, table, column]
  );
  return rows.length > 0;
}

async function main() {
  const connection = await mysql.createConnection(dbConfig);
  console.log(`Connected to database "${process.env.DB_NAME}"`);

  try {
    const [tables] = await connection.query(
      `SELECT TABLE_NAME FROM information_schema.TABLES
       WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'water_level_readings'`,
      [process.env.DB_NAME]
    );
    if (!tables.length) {
      console.log("water_level_readings does not exist yet — run `npm run db:migrate` first, which already includes the M1 columns.");
      return;
    }

    for (const col of NEW_COLUMNS) {
      const exists = await columnExists(connection, "water_level_readings", col.name);
      if (exists) {
        console.log(`= water_level_readings.${col.name} already present`);
        continue;
      }
      await connection.query(`ALTER TABLE water_level_readings ${col.ddl}`);
      console.log(`✓ water_level_readings.${col.name} added`);
    }

    console.log("✓ M1 migration complete.");
  } finally {
    await connection.end();
  }
}

main().catch(error => {
  console.error("✗ M1 migration failed:", error.message);
  process.exit(1);
});
