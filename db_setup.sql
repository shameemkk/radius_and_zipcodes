-- =============================================================================
-- db_setup.sql  —  SQLite + SpatiaLite schema for the Zip Proximity Search API
-- =============================================================================
--
-- IMPORTANT: This script uses SpatiaLite functions (InitSpatialMetaData,
-- AddGeometryColumn, CreateSpatialIndex). It MUST be executed on a connection
-- that has the `mod_spatialite` extension loaded. A plain `sqlite3 file.db <
-- db_setup.sql` will NOT work because the CLI has not loaded the extension.
--
-- Apply it with either of:
--   1) npm run setup           (recommended — see setup.js; loads the extension)
--   2) spatialite zipcodes.db < db_setup.sql   (the `spatialite` CLI auto-loads it)
--
-- Re-running is safe: InitSpatialMetaData/AddGeometryColumn/CreateSpatialIndex
-- detect existing metadata and no-op (setup.js also guards each step).
-- =============================================================================

-- Use the standard rollback journal (NOT WAL). This DB is built once and served
-- read-only, frequently from a Docker bind-mount / read-only volume where WAL's
-- shared-memory wal-index can't be created (causing "disk I/O error" or open
-- failures). DELETE mode needs no -shm/-wal sidecars and works everywhere.
PRAGMA journal_mode = DELETE;

-- ---------------------------------------------------------------------------
-- 1. Initialise SpatiaLite metadata (creates spatial_ref_sys, geometry_columns,
--    etc.). The argument 1 = "transactional/fast" init. Runs once per DB file.
-- ---------------------------------------------------------------------------
SELECT InitSpatialMetaData(1);

-- ---------------------------------------------------------------------------
-- 2. Core table.
--    Surrogate `id` PK on purpose: (country, zip_code) is the NATURAL key but is
--    NOT unique — a single postal code can map to multiple localities/centroids.
--    A composite PK would wrongly reject those legitimate rows.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS zip_codes (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    country  TEXT NOT NULL,   -- API tokens: 'UK' / 'AU' / 'MX' / 'US' (note: 'UK', not ISO 'GB')
    zip_code TEXT NOT NULL,   -- alphanumeric (UK postcodes have letters + a space) -> keep as TEXT
    city     TEXT NOT NULL,
    state    TEXT NOT NULL    -- county / state / region
);

-- ---------------------------------------------------------------------------
-- 3. Geometry column (lon/lat point in WGS84 / SRID 4326).
--    Added via AddGeometryColumn so SpatiaLite registers it in geometry_columns
--    and installs the integrity triggers. Final arg 1 = NOT NULL.
-- ---------------------------------------------------------------------------
SELECT AddGeometryColumn('zip_codes', 'geom', 4326, 'POINT', 'XY', 1);

-- ---------------------------------------------------------------------------
-- 4. Plain btree index for the origin lookup by (country, zip_code).
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_zip_codes_country_zip
    ON zip_codes (country, zip_code);

-- ---------------------------------------------------------------------------
-- 5. Spatial (R-Tree) index on the geometry column. This is what makes
--    ST_Distance radius queries fast: the query uses the R-Tree as a
--    bounding-box prefilter (via the SpatialIndex virtual table), then refines
--    with the exact geodesic ST_Distance check.
--    CreateSpatialIndex also installs triggers that keep the R-Tree in sync on
--    INSERT/UPDATE/DELETE.
-- ---------------------------------------------------------------------------
SELECT CreateSpatialIndex('zip_codes', 'geom');
