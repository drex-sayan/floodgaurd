// db/seed.js
//
// Inserts a handful of example locations so later phases (rainfall ingestion,
// the overview dashboard, M3 predictions) have something real to query
// against. Run this AFTER db/migrate.js.
//
// Idempotent: checks existing place_names first, so re-running this script
// will not create duplicate rows.
//
// Usage:
//   node db/seed.js
//   npm run db:seed

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

// A supported flash-flood/landslide-prone hill region, plus an unsupported
// low-lying urban area, so the app has both a "monitored" and a
// "not yet monitored" example to render differently in the UI.
const SEED_LOCATIONS = [
  {
    place_name: "Chamoli",
    region: "Uttarakhand, India",
    latitude: 30.4032,
    longitude: 79.3212
  },
  {
    place_name: "Kolkata",
    region: "West Bengal, India",
    latitude: 22.5726,
    longitude: 88.3639
  },
  {
    place_name: "Guwahati",
    region: "Assam, India",
    latitude: 26.1445,
    longitude: 91.7362
  }
];

async function main() {
  const connection = await mysql.createConnection(dbConfig);
  console.log(`Connected to database "${process.env.DB_NAME}"`);

  try {
    const [existingRows] = await connection.query(
      "SELECT place_name FROM locations WHERE place_name IN (?)",
      [SEED_LOCATIONS.map(l => l.place_name)]
    );
    const existing = new Set(existingRows.map(r => r.place_name));

    for (const loc of SEED_LOCATIONS) {
      if (existing.has(loc.place_name)) {
        console.log(`- ${loc.place_name} already exists, skipping`);
        continue;
      }
      await connection.execute(
        `INSERT INTO locations (latitude, longitude, place_name, region)
         VALUES (?, ?, ?, ?)`,
        [loc.latitude, loc.longitude, loc.place_name, loc.region]
      );
      console.log(`✓ inserted ${loc.place_name}`);
    }

    console.log("✓ Seed complete.");
  } finally {
    await connection.end();
  }
}

main().catch(error => {
  console.error("✗ Seed failed:", error.message);
  process.exit(1);
});
