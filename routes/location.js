// routes/location.js
//
// Location & Model Coverage Engine — the first step of the FloodGuard user
// flow. Two endpoints:
//
//   POST /api/location/resolve
//     Accepts either { latitude, longitude } or { query }.
//     Resolves to one canonical location object, reusing an existing
//     `locations` row when the point is close to one already on file,
//     reverse/forward-geocoding when possible, and inserting a new row
//     only when nothing close enough already exists.
//
//   GET /api/location/coverage?location_id=...
//     Checks the resolved location against the hard-coded MVP allow-list
//     in config/coverage.json and reports whether the M3 model has been
//     validated for that region.
//
// SAFETY CONTRACT: coverage_status is the single source of truth the
// frontend must consult before ever calling /api/ml/predict for a given
// location. 'unsupported' must never be dressed up as a low/no-risk
// result — it means "no prediction available", full stop.

const express = require("express");
const coverageConfig = require("../config/coverage.json");

const NEAREST_LOCATION_THRESHOLD_KM = 10;
const GEOCODE_TIMEOUT_MS = 6000;

function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function toNumberOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function validLat(lat) {
  return isFiniteNumber(lat) && lat >= -90 && lat <= 90;
}

function validLon(lon) {
  return isFiniteNumber(lon) && lon >= -180 && lon <= 180;
}

// Node 18+ ships a global fetch. Guard for older runtimes so geocoding
// failures degrade gracefully instead of crashing the process.
async function fetchWithTimeout(url, options = {}) {
  if (typeof fetch !== "function") {
    throw new Error("Geocoding is unavailable: no fetch implementation in this Node runtime.");
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GEOCODE_TIMEOUT_MS);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function reverseGeocode(lat, lon) {
  try {
    const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${encodeURIComponent(lat)}&lon=${encodeURIComponent(lon)}`;
    const res = await fetchWithTimeout(url, { headers: { "Accept-Language": "en", "User-Agent": "FloodGuard-MVP/1.0" } });
    if (!res.ok) return null;
    const data = await res.json();
    const addr = data.address || {};
    const place_name =
      addr.village || addr.town || addr.city || addr.suburb || addr.county || data.name || data.display_name || null;
    const region = [addr.state, addr.country].filter(Boolean).join(", ") || null;
    return place_name ? { place_name, region } : null;
  } catch (error) {
    console.error("Reverse geocode failed:", error.message);
    return null;
  }
}

async function forwardGeocode(query) {
  try {
    const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&addressdetails=1&q=${encodeURIComponent(query)}`;
    const res = await fetchWithTimeout(url, { headers: { "Accept-Language": "en", "User-Agent": "FloodGuard-MVP/1.0" } });
    if (!res.ok) return null;
    const data = await res.json();
    const top = data[0];
    if (!top) return null;
    const addr = top.address || {};
    const place_name = top.name || addr.village || addr.town || addr.city || String(top.display_name || "").split(",")[0];
    const region = [addr.state, addr.country].filter(Boolean).join(", ") || null;
    const latitude = toNumberOrNull(top.lat);
    const longitude = toNumberOrNull(top.lon);
    if (!validLat(latitude) || !validLon(longitude)) return null;
    return { place_name, region, latitude, longitude };
  } catch (error) {
    console.error("Forward geocode failed:", error.message);
    return null;
  }
}

function rowToLocation(row, overrides = {}) {
  return {
    location_id: row.location_id,
    latitude: overrides.latitude ?? Number(row.latitude),
    longitude: overrides.longitude ?? Number(row.longitude),
    place_name: row.place_name,
    region: row.region,
    timestamp: new Date().toISOString()
  };
}

function locationRoutes(getPool) {
  const router = express.Router();

  // Finds the closest row in `locations` to (lat, lon) using the
  // Haversine formula in SQL. Returns null if the table is empty.
  async function findNearestLocation(lat, lon) {
    const pool = getPool();
    const [rows] = await pool.execute(
      `SELECT location_id, latitude, longitude, place_name, region,
              (6371 * ACOS(
                LEAST(1, GREATEST(-1,
                  COS(RADIANS(?)) * COS(RADIANS(latitude)) * COS(RADIANS(longitude) - RADIANS(?))
                  + SIN(RADIANS(?)) * SIN(RADIANS(latitude))
                ))
              )) AS distance_km
       FROM locations
       ORDER BY distance_km ASC
       LIMIT 1`,
      [lat, lon, lat]
    );
    return rows[0] || null;
  }

  async function findLocationByText(query) {
    const pool = getPool();
    const like = `%${query}%`;
    const [rows] = await pool.execute(
      `SELECT location_id, latitude, longitude, place_name, region
       FROM locations
       WHERE place_name LIKE ? OR region LIKE ?
       ORDER BY
         CASE WHEN place_name LIKE ? THEN 0 ELSE 1 END,
         place_name ASC
       LIMIT 1`,
      [like, like, query]
    );
    return rows[0] || null;
  }

  async function insertLocation({ latitude, longitude, place_name, region }) {
    const pool = getPool();
    const [result] = await pool.execute(
      `INSERT INTO locations (latitude, longitude, place_name, region) VALUES (?, ?, ?, ?)`,
      [latitude, longitude, place_name, region ?? null]
    );
    return {
      location_id: result.insertId,
      latitude,
      longitude,
      place_name,
      region: region ?? null
    };
  }

  // Resolve a location from either coordinates or a free-text search string.
  router.post("/resolve", async (req, res) => {
    try {
      const body = req.body || {};
      const hasCoords = body.latitude !== undefined && body.longitude !== undefined;
      const hasQuery = typeof body.query === "string" && body.query.trim().length > 0;

      if (!hasCoords && !hasQuery) {
        return res.status(400).json({ message: "Provide either { latitude, longitude } or { query }." });
      }

      // ---- Path 1: coordinates (current location / pick on map) ----
      if (hasCoords) {
        const lat = toNumberOrNull(body.latitude);
        const lon = toNumberOrNull(body.longitude);
        if (!validLat(lat) || !validLon(lon)) {
          return res.status(400).json({ message: "latitude/longitude are out of range." });
        }

        const nearest = await findNearestLocation(lat, lon);
        if (nearest && nearest.distance_km <= NEAREST_LOCATION_THRESHOLD_KM) {
          return res.json({ ...rowToLocation(nearest, { latitude: lat, longitude: lon }), source: "existing" });
        }

        const geocoded = await reverseGeocode(lat, lon);
        const place_name = geocoded?.place_name || `Unnamed location (${lat.toFixed(4)}, ${lon.toFixed(4)})`;
        const region = geocoded?.region || null;

        const inserted = await insertLocation({ latitude: lat, longitude: lon, place_name, region });
        return res.json({ ...rowToLocation(inserted), source: geocoded ? "geocoded" : "new" });
      }

      // ---- Path 2: free-text search ----
      const query = body.query.trim();

      const localMatch = await findLocationByText(query);
      if (localMatch) {
        return res.json({ ...rowToLocation(localMatch), source: "existing" });
      }

      const geocoded = await forwardGeocode(query);
      if (!geocoded) {
        return res.status(502).json({
          message: "Could not find that location. Try a more specific search, or use current location / pick on map instead."
        });
      }

      const nearest = await findNearestLocation(geocoded.latitude, geocoded.longitude);
      if (nearest && nearest.distance_km <= NEAREST_LOCATION_THRESHOLD_KM) {
        return res.json({ ...rowToLocation(nearest, { latitude: geocoded.latitude, longitude: geocoded.longitude }), source: "existing" });
      }

      const inserted = await insertLocation(geocoded);
      return res.json({ ...rowToLocation(inserted), source: "geocoded" });
    } catch (error) {
      console.error("Location resolve error:", error);
      res.status(500).json({ message: "Unable to resolve location." });
    }
  });

  // Check whether a resolved location falls inside the M3 model's
  // validated coverage area.
  router.get("/coverage", async (req, res) => {
    try {
      const locationId = toNumberOrNull(req.query.location_id);
      if (!locationId) {
        return res.status(400).json({ message: "location_id query parameter is required." });
      }

      const pool = getPool();
      const [rows] = await pool.execute(
        `SELECT location_id, latitude, longitude, place_name, region FROM locations WHERE location_id = ? LIMIT 1`,
        [locationId]
      );
      const location = rows[0];
      if (!location) {
        return res.status(404).json({ message: "Unknown location_id." });
      }

      const match = findCoverageMatch(location);
      if (match) {
        return res.json({
          location_id: location.location_id,
          coverage_status: "covered",
          model_region: match.model_region,
          model_version: match.model_version
        });
      }

      return res.json({
        location_id: location.location_id,
        coverage_status: "unsupported",
        model_region: null,
        model_version: null
      });
    } catch (error) {
      console.error("Coverage check error:", error);
      res.status(500).json({ message: "Unable to check model coverage." });
    }
  });

  return router;
}

function textIncludesAny(haystack, needles) {
  if (!haystack) return false;
  const lower = String(haystack).toLowerCase();
  return (needles || []).some((needle) => lower.includes(String(needle).toLowerCase()));
}

function insideBbox(lat, lon, bbox) {
  if (!bbox) return false;
  return lat >= bbox.lat_min && lat <= bbox.lat_max && lon >= bbox.lon_min && lon <= bbox.lon_max;
}

function findCoverageMatch(location) {
  const lat = Number(location.latitude);
  const lon = Number(location.longitude);

  for (const entry of coverageConfig.supported_regions || []) {
    const m = entry.match || {};
    const nameHit = textIncludesAny(location.place_name, m.place_name_contains);
    const regionHit = textIncludesAny(location.region, m.region_contains);
    const bboxHit = insideBbox(lat, lon, m.bbox);
    if (nameHit || regionHit || bboxHit) {
      return entry;
    }
  }
  return null;
}

module.exports = locationRoutes;
