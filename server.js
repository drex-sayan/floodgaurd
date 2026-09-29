require("dotenv").config();

const path = require("path");
const notifyProvider = require("./lib/notifyProvider");
const crypto = require("crypto");
const { execFile } = require("child_process");
const express = require("express");
const inferenceService = require("./services/inferenceService");
const mysql = require("mysql2/promise");
const bcrypt = require("bcryptjs");
const locationRoutes = require("./routes/location");
const zoneRoutes = require("./routes/zones");
const geofenceRoutes = require("./routes/geofence");
const userRoutes = require("./routes/user");
const alertsRoutes = require("./routes/alerts");
const m1Routes = require("./routes/m1");
const m2Routes = require("./routes/m2");
const m4Routes = require("./routes/m4");
const m5Routes = require("./routes/m5");
const devSensorFeedRoutes = require("./routes/devSensorFeed");
const { evaluateFreshnessGate } = require("./utils/freshness");

const app = express();
const PORT = Number(process.env.PORT) || 5000;
const SESSION_COOKIE = "floodguard_session";
const SESSION_DAYS = 7;

const requiredEnv = ["DB_HOST", "DB_USER", "DB_NAME"];
for (const key of requiredEnv) {
  if (!process.env[key]) {
    console.error(`Missing required environment variable: ${key}`);
    process.exit(1);
  }
}

let pool;

const dbConfig = {
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT) || 3306,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD ?? ""
};

async function createDatabaseIfNeeded() {
  // Connect without selecting a database first. This avoids
  // "Unknown database" when FloodGuard is being set up for the first time.
  const connection = await mysql.createConnection(dbConfig);
  const dbName = String(process.env.DB_NAME).trim();

  if (!/^[A-Za-z0-9_$-]+$/.test(dbName)) {
    await connection.end();
    throw new Error("Invalid DB_NAME. Use only letters, numbers, _, $, or -.");
  }

  await connection.query(
    `CREATE DATABASE IF NOT EXISTS \`${dbName.replace(/`/g, "``")}\`
     CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`
  );

  await connection.end();
  console.log(`✓ MySQL database "${dbName}" is ready`);
}

function createPool() {
  pool = mysql.createPool({
    ...dbConfig,
    database: process.env.DB_NAME,
    waitForConnections: true,
    connectionLimit: process.env.VERCEL ? 1 : 10,
    queueLimit: 0
  });
}

app.disable("x-powered-by");
app.use(express.json({ limit: "100kb" }));

// Dependency-free equivalents of the usual Helmet + express-rate-limit
// middleware. Security headers are applied to every response. Rate limiting
// uses a bounded in-memory fixed window, suitable for this single-process
// demo deployment; use a shared store for a multi-instance production service.
app.use((req, res, next) => {
  res.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com https://cdn.jsdelivr.net; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://cdn.jsdelivr.net; img-src 'self' data: blob: https://*.tile.openstreetmap.org; font-src 'self' data: https://fonts.gstatic.com; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Permissions-Policy", "geolocation=(self), camera=(self), microphone=()");
  next();
});

// Vercel Serverless cold-start handler
let dbInitPromise = null;
app.use(async (req, res, next) => {
  if (process.env.VERCEL) {
    if (!pool) {
      if (!dbInitPromise) {
        dbInitPromise = startServer(true);
      }
      try {
        await dbInitPromise;
      } catch (err) {
        return res.status(500).json({ 
          message: "Database initialization failed during cold start.", 
          error: err.message,
          host: process.env.DB_HOST // Helpful to verify if env vars are loaded
        });
      }
    }
  }
  next();
});

const rateWindows = new Map();
function fixedWindowLimit(limit, windowMs, message) {
  return (req, res, next) => {
    if (!req.path.startsWith("/api")) return next();
    const key = `${req.ip}:${req.baseUrl || ""}:${req.path}`;
    const now = Date.now();
    let bucket = rateWindows.get(key);
    if (!bucket || now >= bucket.resetAt) bucket = { count: 0, resetAt: now + windowMs };
    bucket.count++;
    rateWindows.set(key, bucket);
    if (bucket.count > limit) {
      res.setHeader("Retry-After", Math.ceil((bucket.resetAt - now) / 1000));
      return res.status(429).json({ message });
    }
    next();
  };
}
app.use("/api", fixedWindowLimit(300, 15 * 60 * 1000, "Too many API requests. Please try again later."));
app.use("/api/auth", fixedWindowLimit(20, 15 * 60 * 1000, "Too many authentication attempts. Please try again later."));
app.use("/api/ml/predict", fixedWindowLimit(30, 15 * 60 * 1000, "Too many prediction requests. Please try again later."));

// CSRF strategy: the session cookie is SameSite=Lax and every browser
// state-changing API request is checked against its Origin header. This
// blocks cross-site form/fetch submissions while keeping the existing
// vanilla-JS API contract unchanged. Requests from non-browser tooling that
// omit Origin remain supported; this is documented in README.md.
function csrfProtection(req, res, next) {
  if (!req.path.startsWith("/api/") || ["GET", "HEAD", "OPTIONS"].includes(req.method)) return next();
  if (req.path === "/api/auth/login" || req.path === "/api/auth/signup") return next();

  const origin = req.get("origin");
  if (origin) {
    try {
      if (new URL(origin).host !== req.get("host")) {
        return res.status(403).json({ message: "Request origin is not allowed." });
      }
    } catch {
      return res.status(403).json({ message: "Request origin is not allowed." });
    }
  } else {
    const referer = req.get("referer");
    if (referer) {
      try {
        if (new URL(referer).host !== req.get("host")) {
          return res.status(403).json({ message: "Request origin is not allowed." });
        }
      } catch {
        return res.status(403).json({ message: "Request origin is not allowed." });
      }
    }
  }
  next();
}
app.use(csrfProtection);

function validEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function validPassword(password) {
  return typeof password === "string" && password.length >= 8 && /\d/.test(password) && /[^A-Za-z0-9]/.test(password);
}

function parseCookies(header = "") {
  return header.split(";").filter(Boolean).reduce((cookies, part) => {
    const index = part.indexOf("=");
    if (index === -1) return cookies;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    try { cookies[key] = decodeURIComponent(value); }
    catch { cookies[key] = value; }
    return cookies;
  }, {});
}

function hashToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function sessionExpiresAt() {
  return new Date(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000);
}

function sessionCookie(value, maxAge) {
  const parts = [
    `${SESSION_COOKIE}=${encodeURIComponent(value)}`,
    "HttpOnly",
    "Path=/",
    "SameSite=Lax",
    `Max-Age=${maxAge}`
  ];
  if (process.env.NODE_ENV === "production") parts.push("Secure");
  return parts.join("; ");
}

async function createSession(res, userId) {
  const token = crypto.randomBytes(32).toString("base64url");
  await pool.execute(
    "INSERT INTO sessions (userId, tokenHash, expiresAt) VALUES (?, ?, ?)",
    [userId, hashToken(token), sessionExpiresAt()]
  );
  res.setHeader("Set-Cookie", sessionCookie(token, SESSION_DAYS * 24 * 60 * 60));
}

async function getSessionUser(req) {
  const token = parseCookies(req.headers.cookie || "")[SESSION_COOKIE];
  if (!token) return null;

  const [rows] = await pool.execute(
    `SELECT u.id, u.fullName, u.email, u.role, u.created_At
     FROM sessions s
     INNER JOIN users u ON u.id = s.userId
     WHERE s.tokenHash = ? AND s.expiresAt > NOW()
     LIMIT 1`,
    [hashToken(token)]
  );
  return rows[0] || null;
}

async function deleteSession(req) {
  const token = parseCookies(req.headers.cookie || "")[SESSION_COOKIE];
  if (token) await pool.execute("DELETE FROM sessions WHERE tokenHash = ?", [hashToken(token)]);
}

function clearSessionCookie(res) {
  res.setHeader("Set-Cookie", sessionCookie("", 0));
}

async function ensureSessionsTable() {
  // Read the ACTUAL type of users.id. This makes the foreign-key column match
  // even if an older FloodGuard installation already created users differently.
  const [userIdInfo] = await pool.execute(
    `SELECT COLUMN_TYPE
     FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'id'
     LIMIT 1`
  );

  if (!userIdInfo.length) throw new Error("Could not determine users.id column type.");
  const userIdType = userIdInfo[0].COLUMN_TYPE;
  if (!/^(tinyint|smallint|mediumint|int|bigint)( unsigned)?$/i.test(userIdType)) {
    throw new Error(`Unsupported users.id type: ${userIdType}`);
  }

  const [sessionIdInfo] = await pool.execute(
    `SELECT COLUMN_TYPE
     FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'sessions' AND COLUMN_NAME = 'userId'
     LIMIT 1`
  );

  // Sessions are disposable. If an old incompatible sessions table exists,
  // recreate it safely so its FK always matches users.id exactly.
  if (sessionIdInfo.length && sessionIdInfo[0].COLUMN_TYPE.toLowerCase() !== userIdType.toLowerCase()) {
    console.log("! Recreating old sessions table because userId type did not match users.id");
    await pool.query("DROP TABLE IF EXISTS sessions");
  }

  await pool.query(`
    CREATE TABLE IF NOT EXISTS sessions (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      userId ${userIdType} NOT NULL,
      tokenHash CHAR(64) NOT NULL,
      created_At TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      expiresAt DATETIME NOT NULL,
      PRIMARY KEY (id),
      UNIQUE KEY unique_token_hash (tokenHash),
      KEY idx_sessions_user (userId),
      KEY idx_sessions_expiry (expiresAt),
      CONSTRAINT fk_sessions_user
        FOREIGN KEY (userId) REFERENCES users(id)
        ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
}

async function initializeDatabase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id INT UNSIGNED NOT NULL AUTO_INCREMENT,
      fullName VARCHAR(100) NOT NULL,
      email VARCHAR(255) NOT NULL,
      password VARCHAR(255) NOT NULL,
      role VARCHAR(30) NOT NULL DEFAULT 'user',
      created_At TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY unique_email (email)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  await ensureSessionsTable();
  await pool.query("DELETE FROM sessions WHERE expiresAt <= NOW()");
}

async function requireAuth(req, res, next) {
  try {
    const user = await getSessionUser(req);
    if (!user) return res.status(401).json({ message: "Authentication required." });
    req.user = user;
    next();
  } catch (error) {
    console.error("Authentication error:", error.message);
    res.status(500).json({ message: "Unable to verify your session." });
  }
}

function runM3Prediction(payload) {
  return inferenceService.predict("m3", payload);
}

async function buildM3FeaturePayload(locationId, locationInput = {}) {
  const id = Number(locationId);
  if (!Number.isInteger(id) || id <= 0) throw new Error("A valid location_id is required for M3 prediction.");

  // M3 was trained on a 22-column feature vector. The browser intentionally
  // sends only location_id/coordinates; this server-side builder assembles
  // the complete vector from the latest sensor/context rows.
  const [locationRows] = await pool.execute(
    `SELECT location_id, latitude, longitude FROM locations WHERE location_id = ? LIMIT 1`,
    [id]
  );
  const location = locationRows[0];
  if (!location) throw new Error("Unknown location_id.");

  const [terrainRows] = await pool.execute(
    `SELECT elevation_m, slope_deg FROM terrain_features WHERE location_id = ? LIMIT 1`,
    [id]
  );
  const terrain = terrainRows[0] || {};

  const [rainRows] = await pool.execute(
    `SELECT window_1h, window_3h, window_6h, window_12h, window_24h
     FROM rainfall_readings WHERE location_id = ?
     ORDER BY \`timestamp\` DESC LIMIT 1`,
    [id]
  );
  const rain = rainRows[0] || {};

  const [waterRows] = await pool.execute(
    `SELECT level_m, change_1h, change_3h, rise_rate_m_per_hr, \`timestamp\`
     FROM water_level_readings WHERE location_id = ?
     ORDER BY \`timestamp\` DESC LIMIT 7`,
    [id]
  );
  const water = waterRows[0] || {};

  // Use the latest available reading at/around each requested lag. If the
  // demo database has fewer than 6 hours of history, current level is used
  // as the neutral lag fallback rather than making the prediction fail.
  const currentLevel = Number.isFinite(Number(water.level_m)) ? Number(water.level_m) : 0.6;
  const lag = (hours) => {
    if (!waterRows.length) return currentLevel;
    const target = Date.now() - hours * 3600000;
    let best = waterRows[waterRows.length - 1];
    let bestDiff = Infinity;
    for (const row of waterRows) {
      const ts = new Date(row.timestamp).getTime();
      const diff = Math.abs(ts - target);
      if (Number.isFinite(ts) && diff < bestDiff) { best = row; bestDiff = diff; }
    }
    return Number.isFinite(Number(best.level_m)) ? Number(best.level_m) : currentLevel;
  };

  const [soilRows] = await pool.execute(
    `SELECT moisture_pct, \`timestamp\` FROM soil_moisture_readings
     WHERE location_id = ? ORDER BY \`timestamp\` DESC LIMIT 7`,
    [id]
  );
  const soil = soilRows[0] || {};
  const soilCurrent = Number.isFinite(Number(soil.moisture_pct)) ? Number(soil.moisture_pct) : 35;
  let soil3h = soilCurrent;
  if (soilRows.length > 1) {
    const target = Date.now() - 3 * 3600000;
    let best = soilRows[soilRows.length - 1], bestDiff = Infinity;
    for (const row of soilRows) {
      const ts = new Date(row.timestamp).getTime();
      const diff = Math.abs(ts - target);
      if (Number.isFinite(ts) && diff < bestDiff) { best = row; bestDiff = diff; }
    }
    if (Number.isFinite(Number(best.moisture_pct))) soil3h = Number(best.moisture_pct);
  }

  const [eventRows] = await pool.execute(
    `SELECT COUNT(*) AS cnt FROM historical_events
     WHERE location_id = ? AND event_date >= DATE_SUB(CURDATE(), INTERVAL 30 DAY)`,
    [id]
  );
  const [cctvRows] = await pool.execute(
    `SELECT COUNT(*) AS cnt FROM cctv_events
     WHERE location_id = ? AND detected_at >= DATE_SUB(NOW(), INTERVAL 24 HOUR)`,
    [id]
  );

  // historical_events has no event coordinates, so the model's contextual
  // distance feature cannot be reconstructed exactly for a newly selected
  // location. 15 km is the neutral synthetic-training fallback; it is
  // deliberately not presented as measured geography.
  const eventCount = Number(eventRows[0]?.cnt || 0) + Number(cctvRows[0]?.cnt || 0);
  const eventProximityKm = 15.0;

  const numeric = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
  const rainfall1h = numeric(rain.window_1h, 0);
  const rainfall3h = numeric(rain.window_3h, rainfall1h);
  const rainfall6h = numeric(rain.window_6h, rainfall3h);
  const rainfall12h = numeric(rain.window_12h, rainfall6h);
  const rainfall24h = numeric(rain.window_24h, rainfall12h);
  const waterLag1h = lag(1);
  const waterLag3h = lag(3);
  const waterLag6h = lag(6);
  const change1h = numeric(water.change_1h, currentLevel - waterLag1h);
  const change3h = numeric(water.change_3h, currentLevel - waterLag3h);
  const riseRate = numeric(water.rise_rate_m_per_hr, change1h);

  return {
    station_id: id,
    latitude: numeric(location.latitude, numeric(locationInput.latitude, 0)),
    longitude: numeric(location.longitude, numeric(locationInput.longitude, 0)),
    elevation_m: numeric(terrain.elevation_m, 100),
    slope_deg: numeric(terrain.slope_deg, 5),
    rainfall_1h: rainfall1h,
    rainfall_3h: rainfall3h,
    rainfall_6h: rainfall6h,
    rainfall_12h: rainfall12h,
    rainfall_24h: rainfall24h,
    soil_moisture: soilCurrent,
    moisture_change_3h: soilCurrent - soil3h,
    water_level_m: currentLevel,
    water_level_lag1h: waterLag1h,
    water_level_lag3h: waterLag3h,
    water_level_lag6h: waterLag6h,
    water_level_change_1h: change1h,
    water_level_change_3h: change3h,
    rise_rate_m_per_hour: riseRate,
    recent_event_count: eventCount,
    event_proximity_km: eventProximityKm
  };
}


app.get("/api/system/versions", requireAuth, async (req, res) => {
  try {
    res.json({ service: "FloodGuard", generated_at: new Date().toISOString(), models: await inferenceService.getVersions() });
  } catch (error) {
    console.error("System versions error:", error);
    res.status(503).json({ message: "Model version information is unavailable." });
  }
});

app.get("/api/ml/health", requireAuth, async (req, res) => {
  try {
    const metadata = require("./ml/artifacts/model_metadata.json");
    res.json({ status: "ok", model_version: metadata.model_version, model_type: metadata.model_type, data_is_synthetic: metadata.data_is_synthetic });
  } catch (error) {
    res.status(503).json({ status: "error", message: "M3 model artifact is unavailable." });
  }
});

// Freshness gate for the M3 card — reads whatever's currently in
// rainfall_readings / water_level_readings / soil_moisture_readings for a
// location and classifies each against config/freshnessPolicy.json (see
// utils/freshness.js). This is read-only and purely additive: it never
// touches the feature payload runM3Prediction() receives, so it cannot
// change the flood_probability that comes back — it only decides whether
// the response also carries degraded_confidence: true, the same field
// shape services/zoneEngine.js already uses for its own (untouched)
// water-level gate.
async function fetchLatestTimestamp(table, locationId) {
  // `table` is always one of the three fixed literals passed below, never
  // request input — same "inlined but validated at the call site" pattern
  // routes/m2.js already uses for its LIMIT clause.
  const [rows] = await pool.execute(
    `SELECT \`timestamp\` FROM ${table} WHERE location_id = ? ORDER BY \`timestamp\` DESC LIMIT 1`,
    [locationId]
  );
  return rows[0] ? rows[0].timestamp : null;
}

async function buildM3FreshnessGate(locationId) {
  const [rainfallTs, waterTs, soilTs] = await Promise.all([
    fetchLatestTimestamp("rainfall_readings", locationId),
    fetchLatestTimestamp("water_level_readings", locationId),
    fetchLatestTimestamp("soil_moisture_readings", locationId)
  ]);

  const gate = evaluateFreshnessGate([
    { key: "rainfall", dataType: "rainfall_readings", timestamp: rainfallTs, critical: true },
    { key: "water_level", dataType: "water_level_readings", timestamp: waterTs, critical: true },
    { key: "soil_moisture", dataType: "soil_moisture_readings", timestamp: soilTs, critical: true }
  ]);

  return {
    data_freshness: gate.freshness,
    degraded_confidence: gate.degraded_confidence,
    degraded_confidence_reason: gate.degraded_confidence_reason
  };
}

app.get("/api/ml/demo", requireAuth, async (req, res) => {
  try {
    const demo = require("./ml/demo_input.json");
    const result = await runM3Prediction(demo);
    // The demo payload is static fixture data, not a read from the reading
    // tables, so a freshness badge doesn't apply — report it explicitly as
    // not-applicable rather than omitting the field, so the frontend
    // badge helper doesn't have to guess why it's missing.
    res.json({ ...result, demo: true, data_freshness: null, degraded_confidence: false, degraded_confidence_reason: null });
  } catch (error) {
    console.error("M3 demo prediction error:", error.message);
    res.status(500).json({ message: "Unable to run M3 prediction." });
  }
});

app.post("/api/ml/predict", requireAuth, async (req, res) => {
  try {
    const body = req.body || {};
    const locationId = Number(body.location_id);
    const features = await buildM3FeaturePayload(locationId, body);
    const result = await runM3Prediction(features);

    const freshnessInfo = Number.isFinite(locationId)
      ? await buildM3FreshnessGate(locationId)
      : { data_freshness: null, degraded_confidence: false, degraded_confidence_reason: null };

    res.json({ ...result, ...freshnessInfo });
  } catch (error) {
    console.error("M3 prediction error:", error.message);
    res.status(400).json({ message: "Invalid M3 input or prediction failed." });
  }
});

// Location & Model Coverage Engine — resolve a location and check whether
// the M3 model has validated coverage for it. Requires auth like the other
// authenticated API routes; the pool is looked up lazily via the getter so
// the router can be mounted before startServer() creates the pool.
app.use("/api/location", requireAuth, locationRoutes(() => pool));

// Zone Engine — turns an M3 prediction (risk_level/probability) plus the
// location's latest water-level reading into Red/Yellow/Green risk-ring
// radii. See routes/zones.js and services/zoneEngine.js.
app.use("/api/zones", requireAuth, zoneRoutes(() => pool));

// Geofence + Alert Engine — resolves a user's live position against a
// location's zone radii, persists per-user zone state, and fires SMS/email
// alerts on a Red/Yellow transition. See routes/geofence.js,
// services/alertEngine.js, and lib/notifyProvider.js.
app.use("/api/geofence", requireAuth, geofenceRoutes(() => pool));
app.use("/api/user", requireAuth, userRoutes(() => pool));
app.use("/api/alerts", requireAuth, alertsRoutes(() => pool));

// M1 Water-Level Vision Module — a supporting module only. Its readings
// never reach runM3Prediction() or /api/ml/predict above, and are written
// with quality_status = 'estimated' so the Zone Engine (services/zoneEngine.js)
// structurally cannot use them either. See ml/m1/README.md.
app.use("/api/m1", requireAuth, m1Routes(() => pool));

// M2 Anomaly/Event Detector — supporting/operational module, like M1/M5.
// Produces authority-facing operational alerts (cctv_events) from a
// rule-based check on the same mock rainfall/water-level data, standing
// in for real video-based event classification (see services/m2Detect.js).
// Never read by runM3Prediction(), the Zone Engine, or the user-facing
// geofence Alert Engine (services/alertEngine.js) — kept structurally
// separate from M3 and from per-user alerts.
app.use("/api/m2", requireAuth, m2Routes(() => pool));

// M4 Landslide Hazard Estimate — an independent supporting hazard module,
// like M1/M2/M5. Produces a separate landslide_probability/risk_level from
// terrain, rainfall, and soil-moisture data; never reads or modifies M3's
// flash-flood probability and is never read by runM3Prediction(), the Zone
// Engine, or the Alert Engine. See ml/m4/README.md.
app.use("/api/m4", requireAuth, m4Routes(() => pool));

// M5 Water-Level Forecasting Module — a supporting module only, like M1.
// It never calls runM3Prediction() and its +1h/+3h/+6h forecast is not
// read by the Zone Engine or the Alert Engine. See ml/m5/README.md.
app.use("/api/m5", requireAuth, m5Routes(() => pool));

// Dev/demo-only mock sensor feed — see services/mockSensorFeed.js and
// routes/devSensorFeed.js. Inserts synthetic rows into the reading tables
// so the realtime polling loop on the dashboard has something to show
// during a demo. Never a real IoT ingestion path; every row it writes is
// tagged source = 'dev_mock_sensor_feed' so it can never be mistaken for
// one, same as the M1/M2 mock triggers above.
app.use("/api/dev/mock-sensor-feed", requireAuth, devSensorFeedRoutes(() => pool));

app.get("/api/health", async (req, res) => {
  try {
    await pool.query("SELECT 1");
    res.json({ status: "ok", database: "connected" });
  } catch {
    res.status(503).json({ status: "error", database: "disconnected", message: "MySQL is unavailable." });
  }
});

app.post("/api/auth/signup", async (req, res) => {
  try {
    const { fullName, email, password } = req.body || {};
    const cleanName = String(fullName || "").trim();
    const normalizedEmail = String(email || "").trim().toLowerCase();

    if (!cleanName || !normalizedEmail || !password) return res.status(400).json({ message: "All fields are required." });
    if (cleanName.length < 2 || cleanName.length > 100) return res.status(400).json({ message: "Please enter a valid full name." });
    if (!validEmail(normalizedEmail)) return res.status(400).json({ message: "Please enter a valid email address." });
    if (!validPassword(password)) return res.status(400).json({ message: "Password must contain at least 8 characters, a number and a special character." });

    const [existing] = await pool.execute("SELECT id FROM users WHERE email = ? LIMIT 1", [normalizedEmail]);
    if (existing.length) return res.status(409).json({ message: "An account with this email already exists." });

    const hashedPassword = await bcrypt.hash(password, 12);
    const [result] = await pool.execute(
      "INSERT INTO users (fullName, email, password, role) VALUES (?, ?, ?, ?)",
      [cleanName, normalizedEmail, hashedPassword, "user"]
    );

    await createSession(res, result.insertId);
    res.status(201).json({ success: true, message: "Account created successfully.", user: { id: result.insertId, fullName: cleanName, email: normalizedEmail, role: "user" } });
  } catch (error) {
    console.error("Signup error:", error);
    if (error?.code === "ER_DUP_ENTRY") return res.status(409).json({ message: "An account with this email already exists." });
    res.status(500).json({ message: "Unable to create account. Please try again." });
  }
});

app.post("/api/auth/login", async (req, res) => {
  try {
    const { email, password } = req.body || {};
    const normalizedEmail = String(email || "").trim().toLowerCase();
    if (!normalizedEmail || !password) return res.status(400).json({ message: "Email and password are required." });
    if (!validEmail(normalizedEmail)) return res.status(400).json({ message: "Please enter a valid email address." });

    const [rows] = await pool.execute(
      "SELECT id, fullName, email, password, role, created_At FROM users WHERE email = ? LIMIT 1",
      [normalizedEmail]
    );
    const user = rows[0];
    if (!user || !(await bcrypt.compare(password, user.password))) return res.status(401).json({ message: "Invalid email or password." });

    await pool.execute("DELETE FROM sessions WHERE userId = ? AND expiresAt <= NOW()", [user.id]);
    await createSession(res, user.id);
    res.json({ success: true, message: "Login successful.", user: { id: user.id, fullName: user.fullName, email: user.email, role: user.role, created_At: user.created_At } });
  } catch (error) {
    console.error("Login error:", error);
    res.status(500).json({ message: "Unable to log in. Please try again." });
  }
});

app.get("/api/auth/me", requireAuth, (req, res) => res.json({ user: req.user }));

app.post("/api/auth/logout", async (req, res) => {
  try {
    await deleteSession(req);
    clearSessionCookie(res);
    res.json({ success: true, message: "Logged out successfully." });
  } catch (error) {
    console.error("Logout error:", error);
    clearSessionCookie(res);
    res.status(500).json({ message: "Unable to log out completely." });
  }
});

app.get("/", (req, res) => res.sendFile(path.join(__dirname, "login.html")));
app.get("/login", (req, res) => res.sendFile(path.join(__dirname, "login.html")));
app.get("/signup", (req, res) => res.sendFile(path.join(__dirname, "signup.html")));
app.get("/overview", (req, res) => res.sendFile(path.join(__dirname, "overview.html")));

app.use(express.static(__dirname));
app.use((err, req, res, next) => {
  console.error("Unhandled request error:", err);
  if (res.headersSent) return next(err);
  res.status(500).json({ message: "An unexpected server error occurred." });
});
app.use((req, res) => res.status(404).json({ message: "Route not found." }));

async function startServer(isServerless = false) {
  try {
    if (!process.env.VERCEL) {
      await createDatabaseIfNeeded();
    }
    
    createPool();

    const connection = await pool.getConnection();
    connection.release();

    if (!process.env.VERCEL) {
      await initializeDatabase();
    }
    
    await inferenceService.start();
    // Startup diagnostic only: this does not send an email. It makes SMTP
    // configuration failures visible before a demo alert is triggered.
    await notifyProvider.verifyEmailTransport();
    console.log("✓ MySQL connected");
    console.log("✓ Users and sessions tables are ready");
    
    if (!isServerless && (process.env.NODE_ENV !== 'production' || !process.env.VERCEL)) {
      app.listen(PORT, () => console.log(`✓ FloodGuard running at http://localhost:${PORT}`));
    }
  } catch (error) {
    console.error("✗ MySQL startup failed:", error.message);
    console.error("Check that MySQL is running and that DB_HOST, DB_PORT, DB_USER, DB_PASSWORD and DB_NAME in .env are correct.");
    if (!process.env.VERCEL) {
      process.exit(1);
    }
    throw error;
  }
}

process.on("SIGINT", async () => { try { await inferenceService.stop(); } finally { process.exit(0); } });
process.on("SIGTERM", async () => { try { await inferenceService.stop(); } finally { process.exit(0); } });

// For local development
if (!process.env.VERCEL) {
  startServer();
}

module.exports = app;
