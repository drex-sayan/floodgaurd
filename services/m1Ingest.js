// services/m1Ingest.js
//
// M1 Water-Level Vision Module — the Node-side half of the pipeline
// described in ml/m1/README.md. Python (ml/m1/estimate_level.py) turns one
// camera frame + a calibration file into { level_m, vision_confidence };
// this file turns that into a full water_level_readings row by comparing
// against the location/camera's prior readings, then inserts it.
//
// SAFETY CONTRACT (mirrors ml/m1/README.md): every row this module inserts
// hardcodes quality_status = 'estimated'. config/zonePolicy.json's
// water_level_rise_adjustment only trusts quality_status === 'good', so
// M1's output can never widen/shrink a Zone Engine radius or otherwise
// touch the M3 probability — it only ever surfaces via the M1 dashboard
// card and GET /api/m1/latest. Do not change this to 'good' without a
// deliberate, separate review (see the README section on this).

const path = require("path");
const fs = require("fs");
const { execFile } = require("child_process");

const M1_DIR = path.join(__dirname, "..", "ml", "m1");
const CALIBRATION_DIR = path.join(M1_DIR, "calibration");
const MOCK_IMAGES_DIR = path.join(M1_DIR, "mock_images");
const SCRIPT_PATH = path.join(M1_DIR, "estimate_level.py");

// Change windows the task asks for. rise_rate_m_per_hr is derived from
// whichever of these actually finds a usable prior reading, preferring the
// longest (most stable) window available.
const CHANGE_WINDOWS_MIN = [10, 30, 60];
// A candidate prior reading is only used for a given window if its actual
// age is within this tolerance of that window — otherwise real camera gaps
// (an outage, a slow demo click) would get silently compared as if they
// were exactly 10/30/60 minutes apart.
const WINDOW_TOLERANCE_FRACTION = 0.5;

class M1IngestError extends Error {}

// --- Calibration lookup ---------------------------------------------------

// Loads every calibration/*.json file. Cheap enough to do per-request for
// an MVP with a handful of cameras; if the camera count grows this should
// move to a startup-time cache with file-watch invalidation.
function loadAllCalibrations() {
  if (!fs.existsSync(CALIBRATION_DIR)) return [];
  const files = fs.readdirSync(CALIBRATION_DIR).filter((f) => f.endsWith(".json"));
  const configs = [];
  for (const file of files) {
    try {
      const raw = fs.readFileSync(path.join(CALIBRATION_DIR, file), "utf8");
      configs.push({ file, config: JSON.parse(raw) });
    } catch (error) {
      console.error(`M1: skipping unreadable calibration file ${file}:`, error.message);
    }
  }
  return configs;
}

// MVP limitation (documented in ml/m1/README.md): one camera per location.
// Returns the first calibration whose location_id matches, or null.
function findCalibrationForLocation(locationId) {
  const all = loadAllCalibrations();
  const match = all.find((entry) => Number(entry.config.location_id) === Number(locationId));
  return match ? { path: path.join(CALIBRATION_DIR, match.file), config: match.config } : null;
}

// --- Mock frame selection --------------------------------------------------

// No real CCTV feed exists yet, so each ingest call cycles through the
// static mock stills in ml/m1/mock_images/ (see ml/m1/make_mock_images.py)
// to simulate a new frame arriving. Sorted filenames give a stable,
// repeatable low -> mid -> high -> (wraps) sequence.
function pickMockImage(callIndex) {
  if (!fs.existsSync(MOCK_IMAGES_DIR)) {
    throw new M1IngestError("No mock_images directory found. Run: python ml/m1/make_mock_images.py");
  }
  const files = fs.readdirSync(MOCK_IMAGES_DIR).filter((f) => f.endsWith(".png")).sort();
  if (!files.length) {
    throw new M1IngestError("No mock images found. Run: python ml/m1/make_mock_images.py");
  }
  const chosen = files[callIndex % files.length];
  return path.join(MOCK_IMAGES_DIR, chosen);
}

// --- Python invocation ------------------------------------------------------

function runEstimateLevel(imagePath, calibrationPath) {
  return new Promise((resolve, reject) => {
    const python = process.env.M1_PYTHON || process.env.M3_PYTHON || "python";
    const child = execFile(
      python,
      [SCRIPT_PATH],
      { cwd: M1_DIR, timeout: 15000, maxBuffer: 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) return reject(new M1IngestError(stderr || error.message));
        try {
          resolve(JSON.parse(stdout));
        } catch {
          reject(new M1IngestError("estimate_level.py returned invalid JSON."));
        }
      }
    );
    child.stdin.write(JSON.stringify({ image_path: imagePath, calibration_path: calibrationPath }));
    child.stdin.end();
  });
}

// --- Change/rise-rate computation ------------------------------------------

function round3(value) {
  return Math.round(Number(value) * 1000) / 1000;
}

// Among candidate prior rows (already sorted newest-first), find the one
// closest to `targetAgeMinutes` before `nowMs`, accepting it only if its
// actual age is within WINDOW_TOLERANCE_FRACTION of the target window.
function findClosestPrior(rows, nowMs, targetAgeMinutes) {
  const targetMs = nowMs - targetAgeMinutes * 60 * 1000;
  const toleranceMs = targetAgeMinutes * 60 * 1000 * WINDOW_TOLERANCE_FRACTION;

  let best = null;
  let bestDiff = Infinity;
  for (const row of rows) {
    const rowMs = new Date(row.timestamp).getTime();
    if (!Number.isFinite(rowMs) || rowMs > nowMs) continue;
    const diff = Math.abs(rowMs - targetMs);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = row;
    }
  }
  if (best && bestDiff <= toleranceMs) return best;
  return null;
}

// Computes change_10m/30m/60m and rise_rate_m_per_hr against prior rows
// for the same location + camera. Any window with no sufficiently close
// prior reading is left null rather than guessed.
function computeChanges({ priorRows, newLevelM, nowMs }) {
  const changes = {};
  let riseRateSource = null;

  for (const windowMin of CHANGE_WINDOWS_MIN) {
    const prior = findClosestPrior(priorRows, nowMs, windowMin);
    const key = windowMin === 60 ? "change_1h" : `change_${windowMin}m`;
    if (!prior || prior.level_m === null || prior.level_m === undefined) {
      changes[key] = null;
      continue;
    }
    const change = round3(newLevelM - Number(prior.level_m));
    changes[key] = change;
    // Prefer the longest available window for rise-rate (more stable),
    // so check windows in ascending order and let later ones overwrite.
    const actualElapsedHours = (nowMs - new Date(prior.timestamp).getTime()) / (1000 * 60 * 60);
    if (actualElapsedHours > 0) {
      riseRateSource = { change, elapsedHours: actualElapsedHours };
    }
  }

  const riseRate = riseRateSource ? round3(riseRateSource.change / riseRateSource.elapsedHours) : null;
  return { ...changes, rise_rate_m_per_hr: riseRate };
}

// --- Public entry point -----------------------------------------------------

// Runs one full M1 ingest cycle for a location: picks a mock frame, runs
// the CV script, computes change/rise-rate against DB history, inserts a
// new water_level_readings row, and returns it in the same shape
// GET /api/m1/latest uses.
async function ingestForLocation(pool, locationId) {
  const calibration = findCalibrationForLocation(locationId);
  if (!calibration) {
    throw new M1IngestError(`No M1 calibration found for location_id ${locationId}.`);
  }
  const cameraId = calibration.config.camera_id;

  const [priorRows] = await pool.execute(
    `SELECT level_m, \`timestamp\`
     FROM water_level_readings
     WHERE location_id = ? AND camera_id = ? AND source = 'm1_cv_prototype'
     ORDER BY \`timestamp\` DESC
     LIMIT 20`,
    [locationId, cameraId]
  );

  const imagePath = pickMockImage(priorRows.length);
  const vision = await runEstimateLevel(imagePath, calibration.path);

  const now = new Date();
  const derived = computeChanges({ priorRows, newLevelM: vision.level_m, nowMs: now.getTime() });

  await pool.execute(
    `INSERT INTO water_level_readings
       (location_id, \`timestamp\`, level_m, change_10m, change_30m, change_1h, change_3h,
        rise_rate_m_per_hr, source, camera_id, vision_confidence, units, quality_status)
     VALUES (?, ?, ?, ?, ?, ?, NULL, ?, 'm1_cv_prototype', ?, ?, ?, 'estimated')`,
    [
      locationId,
      now,
      vision.level_m,
      derived.change_10m,
      derived.change_30m,
      derived.change_1h,
      derived.rise_rate_m_per_hr,
      cameraId,
      vision.vision_confidence,
      vision.units || "m"
    ]
  );

  return {
    location_id: Number(locationId),
    camera_id: cameraId,
    calibration_id: vision.calibration_id,
    timestamp: now.toISOString(),
    level_m: vision.level_m,
    change_10m: derived.change_10m,
    change_30m: derived.change_30m,
    change_1h: derived.change_1h,
    rise_rate_m_per_hr: derived.rise_rate_m_per_hr,
    vision_confidence: vision.vision_confidence,
    units: vision.units || "m",
    quality_status: "estimated",
    source: "m1_cv_prototype",
    prototype: true,
    disclaimer: vision.disclaimer || "Calibration-based prototype estimate — not a validated computer-vision gauge."
  };
}

module.exports = {
  M1IngestError,
  ingestForLocation,
  findCalibrationForLocation
};
