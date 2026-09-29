# FloodGuard — Data Layer (M3 support tables)

This adds the MySQL tables the rest of the app (rainfall/soil/water ingestion,
the overview dashboard, and the M3 model) reads and writes. It does **not**
touch `users` or `sessions` — those are still created by `server.js`/`auth.js`
on startup.

## Tables created

| Table | Purpose |
|---|---|
| `locations` | Every place FloodGuard monitors or could monitor |
| `rainfall_readings` | Rainfall accumulation windows (15m → 24h), intensity, forecast flag |
| `soil_moisture_readings` | Soil moisture %, trend, saturation flag |
| `water_level_readings` | River/stream level, 1h/3h change, rise rate |
| `terrain_features` | Static terrain data per location (elevation, slope, drainage, etc.) |
| `historical_events` | Past floods/landslides at a location, for context and validation |
| `model_versions` | Registry of trained models (e.g. `M3-v1.0`) and their metrics |
| `user_zone_state` | Last known Red/Yellow/Green/outside zone per user+location (drives alert transitions) |
| `user_notification_prefs` | Per-user SMS/email opt-in and contact details |
| `alerts` | Delivery log for every alert attempt — sent, failed, or skipped by cooldown |

`user_zone_state`, `user_notification_prefs` and `alerts` have foreign keys
into `users(id)`. Start the app once (`npm start`, then Ctrl+C) so `users`
exists before running `npm run db:migrate` against a brand-new database.

## Phase M1 (Water-Level Vision Module)

`water_level_readings` has four extra columns for M1's calibration-based
CV prototype: `change_10m`, `change_30m` (alongside the pre-existing
`change_1h`/`change_3h`), `camera_id`, and `vision_confidence`. A brand-new
database gets these automatically from `db/schema.sql`. An existing database
created before M1 needs one extra step:

```bash
npm run db:migrate:m1
```

This is a plain `ALTER TABLE ... ADD COLUMN`, guarded by an
`information_schema` check so it's safe to run more than once. See
`ml/m1/README.md` for what writes to these columns and why every M1 row
uses `quality_status = 'estimated'`, never `'good'`.

**Every reading table** (`rainfall_readings`, `soil_moisture_readings`,
`water_level_readings`) has a required `quality_status` column —
`'good' | 'stale' | 'missing' | 'estimated'` — with **no default value**.
Any insert must explicitly state data quality. This is intentional: it
forces every ingestion path to be honest about data quality instead of a
`NULL`/default silently being read downstream as "safe."

## Prerequisites

- MySQL is running and the `floodguard` database already exists (created
  automatically the first time you run `npm run dev` / `npm start`, or
  manually via `CREATE DATABASE IF NOT EXISTS floodguard;`).
- Your `.env` has `DB_HOST`, `DB_USER`, `DB_PASSWORD`, `DB_NAME` set (same
  file the main app already uses).

## Run it

From the project root:

```bash
npm install          # only needed once, mysql2/dotenv are already deps
npm run db:migrate    # creates the 7 tables above (safe to re-run)
npm run db:seed       # inserts 3 example locations (safe to re-run)
```

Or without npm scripts:

```bash
node db/migrate.js
node db/seed.js
```

### If you'd rather run raw SQL

`db/schema.sql` contains the same `CREATE TABLE IF NOT EXISTS` statements and
can be run directly:

```bash
mysql -u <user> -p floodguard < db/schema.sql
```

(In that case you'd still want to run `node db/seed.js` afterward, or copy
the `INSERT` logic from it, to get example data.)

## What gets seeded

`db/seed.js` inserts three example locations so later phases have real
`location_id`s to query against:

- **Chamoli, Uttarakhand** — a supported, flash-flood-prone hill region
- **Kolkata, West Bengal** — an unsupported, low-lying urban example
- **Guwahati, Assam** — a second supported flood-prone region

It checks existing `place_name`s first, so running it more than once won't
create duplicates.

## Notes for later phases

- `terrain_features` and `historical_events` are created empty — no seed
  data — since realistic values depend on the actual monitored sites you
  choose. Insert rows for `location_id` 1–3 (Chamoli/Kolkata/Guwahati) as
  that data becomes available.
- `model_versions` is also created empty. When M3 is (re)trained, insert a
  row here (e.g. `model_version = 'M3-v1.0'`, pulling `target` and
  `metrics_json` straight from `ml/artifacts/model_metadata.json`) so the
  app can track which model produced which prediction.
