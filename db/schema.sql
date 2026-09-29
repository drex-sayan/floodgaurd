-- =============================================================================
-- FloodGuard — Core data-layer schema (Phase M3 support)
-- =============================================================================
-- Run this against the `floodguard` database that server.js already creates.
-- Safe to re-run: every statement uses CREATE TABLE IF NOT EXISTS.
-- Does NOT touch `users` or `sessions` (owned by auth.js / server.js).
--
-- Usage:
--   mysql -u <user> -p floodguard < db/schema.sql
-- (or use `npm run db:migrate`, which runs the equivalent Node script)
-- =============================================================================

-- -----------------------------------------------------------------------------
-- locations: every place FloodGuard monitors or could monitor
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS locations (
  location_id   INT UNSIGNED NOT NULL AUTO_INCREMENT,
  latitude      DECIMAL(9,6) NOT NULL,
  longitude     DECIMAL(9,6) NOT NULL,
  place_name    VARCHAR(150) NOT NULL,
  region        VARCHAR(100) NULL,
  created_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (location_id),
  KEY idx_locations_region (region)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- -----------------------------------------------------------------------------
-- rainfall_readings
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS rainfall_readings (
  id                BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  location_id       INT UNSIGNED NOT NULL,
  `timestamp`       DATETIME NOT NULL,
  window_15m        DECIMAL(7,2) NULL,
  window_30m        DECIMAL(7,2) NULL,
  window_1h         DECIMAL(7,2) NULL,
  window_3h         DECIMAL(7,2) NULL,
  window_6h         DECIMAL(7,2) NULL,
  window_12h        DECIMAL(7,2) NULL,
  window_24h        DECIMAL(7,2) NULL,
  intensity         DECIMAL(7,2) NULL,
  forecast_flag     TINYINT(1) NOT NULL DEFAULT 0,
  source            VARCHAR(100) NOT NULL,
  units             VARCHAR(20) NOT NULL DEFAULT 'mm',
  -- Hard requirement: never defaulted, callers must state data quality explicitly
  -- so downstream risk logic never silently treats missing data as "good".
  quality_status    ENUM('good','stale','missing','estimated') NOT NULL,
  PRIMARY KEY (id),
  KEY idx_rainfall_location_time (location_id, `timestamp`),
  CONSTRAINT fk_rainfall_location
    FOREIGN KEY (location_id) REFERENCES locations(location_id)
    ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- -----------------------------------------------------------------------------
-- soil_moisture_readings
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS soil_moisture_readings (
  id                BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  location_id       INT UNSIGNED NOT NULL,
  `timestamp`       DATETIME NOT NULL,
  moisture_pct      DECIMAL(5,2) NULL,
  trend             ENUM('rising','falling','stable') NULL,
  saturation_flag   TINYINT(1) NOT NULL DEFAULT 0,
  source            VARCHAR(100) NOT NULL,
  units             VARCHAR(20) NOT NULL DEFAULT '%',
  quality_status    ENUM('good','stale','missing','estimated') NOT NULL,
  PRIMARY KEY (id),
  KEY idx_soil_location_time (location_id, `timestamp`),
  CONSTRAINT fk_soil_location
    FOREIGN KEY (location_id) REFERENCES locations(location_id)
    ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- -----------------------------------------------------------------------------
-- water_level_readings
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS water_level_readings (
  id                  BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  location_id         INT UNSIGNED NOT NULL,
  `timestamp`         DATETIME NOT NULL,
  level_m             DECIMAL(7,3) NULL,
  change_10m          DECIMAL(7,3) NULL,
  change_30m          DECIMAL(7,3) NULL,
  change_1h           DECIMAL(7,3) NULL,
  change_3h           DECIMAL(7,3) NULL,
  rise_rate_m_per_hr  DECIMAL(7,3) NULL,
  source              VARCHAR(100) NOT NULL,
  -- Which camera produced this row. NULL for non-vision sources (manual
  -- gauge entry, a future telemetry feed, etc). Added for Phase M1.
  camera_id           VARCHAR(50) NULL,
  -- Computer-vision self-reported confidence in [0,1] for M1 CV-derived
  -- rows. NULL for any non-vision source. Added for Phase M1.
  vision_confidence   DECIMAL(4,3) NULL,
  units               VARCHAR(20) NOT NULL DEFAULT 'm',
  quality_status      ENUM('good','stale','missing','estimated') NOT NULL,
  PRIMARY KEY (id),
  KEY idx_water_location_time (location_id, `timestamp`),
  CONSTRAINT fk_water_location
    FOREIGN KEY (location_id) REFERENCES locations(location_id)
    ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- -----------------------------------------------------------------------------
-- terrain_features: one static row per location
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS terrain_features (
  location_id     INT UNSIGNED NOT NULL,
  elevation_m     DECIMAL(8,2) NULL,
  slope_deg       DECIMAL(5,2) NULL,
  aspect          VARCHAR(20) NULL,
  drainage_class  VARCHAR(50) NULL,
  land_cover      VARCHAR(100) NULL,
  geology         VARCHAR(100) NULL,
  PRIMARY KEY (location_id),
  CONSTRAINT fk_terrain_location
    FOREIGN KEY (location_id) REFERENCES locations(location_id)
    ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- -----------------------------------------------------------------------------
-- historical_events: past floods / landslides used for context & validation
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS historical_events (
  id            INT UNSIGNED NOT NULL AUTO_INCREMENT,
  location_id   INT UNSIGNED NOT NULL,
  event_type    ENUM('flood','landslide') NOT NULL,
  event_date    DATE NOT NULL,
  severity      VARCHAR(50) NULL,
  notes         TEXT NULL,
  PRIMARY KEY (id),
  KEY idx_events_location_date (location_id, event_date),
  CONSTRAINT fk_events_location
    FOREIGN KEY (location_id) REFERENCES locations(location_id)
    ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- -----------------------------------------------------------------------------
-- cctv_events: M2 Anomaly/Event Detector output (Phase M2)
-- -----------------------------------------------------------------------------
-- NOTE: despite the table name, rows here are NOT produced by real CCTV
-- video analysis yet. See services/m2Detect.js — this is a rule-based
-- stand-in (rise_rate / rainfall_1h threshold check) run against the same
-- mock rainfall/water-level data the rest of the app uses, the same
-- "prototype, not the real sensor path" pattern as M1
-- (ml/m1/README.md). `source` records which detector produced the row so
-- a future real video-classifier source is never conflated with this one.
CREATE TABLE IF NOT EXISTS cctv_events (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  location_id   INT UNSIGNED NOT NULL,
  event_type    VARCHAR(50) NOT NULL,
  confidence    DECIMAL(4,3) NOT NULL,
  anomaly_score DECIMAL(4,3) NOT NULL,
  detected_at   DATETIME NOT NULL,
  source        VARCHAR(100) NOT NULL,
  PRIMARY KEY (id),
  KEY idx_cctv_events_location_time (location_id, detected_at),
  CONSTRAINT fk_cctv_events_location
    FOREIGN KEY (location_id) REFERENCES locations(location_id)
    ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- -----------------------------------------------------------------------------
-- model_versions: registry of trained M-series models (M3 etc.)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS model_versions (
  model_version       VARCHAR(50) NOT NULL,
  model_name          VARCHAR(100) NOT NULL,
  trained_at          DATETIME NULL,
  target              VARCHAR(100) NULL,
  metrics_json        JSON NULL,
  data_is_synthetic   TINYINT(1) NOT NULL DEFAULT 0,
  PRIMARY KEY (model_version)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- =============================================================================
-- Alert Engine (Phase M3.1) — geofencing state + notification tables
-- =============================================================================
-- NOTE: unlike the tables above, these three reference `users(id)`. The
-- `users` table is created by server.js/auth.js on startup, not by this
-- file. If you run `npm run db:migrate` (or this file) directly against a
-- brand-new database, start the app once first (`npm start`, then Ctrl+C)
-- so `users` exists before these FOREIGN KEY constraints are created.

-- -----------------------------------------------------------------------------
-- user_zone_state: the last known Red/Yellow/Green/outside zone a user was
-- resolved into for a given location. This is what /api/geofence/check reads
-- and updates on every ping, and it's the source of truth transition
-- detection (transitioned = current_zone !== previous stored zone) is
-- computed from.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS user_zone_state (
  user_id       INT UNSIGNED NOT NULL,
  location_id   INT UNSIGNED NOT NULL,
  current_zone  ENUM('outside','green','yellow','red') NOT NULL DEFAULT 'outside',
  updated_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id, location_id),
  CONSTRAINT fk_zone_state_user
    FOREIGN KEY (user_id) REFERENCES users(id)
    ON DELETE CASCADE,
  CONSTRAINT fk_zone_state_location
    FOREIGN KEY (location_id) REFERENCES locations(location_id)
    ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- -----------------------------------------------------------------------------
-- user_notification_prefs: one row per user, how they want to be alerted.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS user_notification_prefs (
  user_id        INT UNSIGNED NOT NULL,
  sms_enabled    TINYINT(1) NOT NULL DEFAULT 0,
  email_enabled  TINYINT(1) NOT NULL DEFAULT 1,
  phone_number   VARCHAR(20) NULL,
  email_address  VARCHAR(255) NULL,
  updated_at     TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id),
  CONSTRAINT fk_notif_prefs_user
    FOREIGN KEY (user_id) REFERENCES users(id)
    ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- -----------------------------------------------------------------------------
-- alerts: delivery log for every alert ATTEMPT — sent, failed, or suppressed
-- by cooldown. Every call into the alert engine writes exactly one row here,
-- including skipped ones, so alert history and dedup audits are complete.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS alerts (
  alert_id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id           INT UNSIGNED NOT NULL,
  location_id       INT UNSIGNED NOT NULL,
  zone              ENUM('yellow','red') NOT NULL,
  channel           ENUM('sms','email','both') NOT NULL,
  model_version     VARCHAR(50) NULL,
  evidence_summary  JSON NULL,
  issued_at         TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  delivery_status   ENUM('sent','failed','skipped_cooldown') NOT NULL,
  cooldown_until    DATETIME NULL,
  PRIMARY KEY (alert_id),
  KEY idx_alerts_user_location_zone_time (user_id, location_id, zone, issued_at),
  CONSTRAINT fk_alerts_user
    FOREIGN KEY (user_id) REFERENCES users(id)
    ON DELETE CASCADE,
  CONSTRAINT fk_alerts_location
    FOREIGN KEY (location_id) REFERENCES locations(location_id)
    ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
