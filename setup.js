'use strict';

/**
 * setup.js — initialise the SpatiaLite database from db_setup.sql.
 *
 * A plain `.sql` file cannot load a native extension by itself, so we load
 * mod_spatialite here (via db.js) and then execute the schema script. Safe to
 * re-run: if the spatial table is already registered we skip and exit cleanly.
 *
 * Usage: npm run setup
 */

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const { openDb, DEFAULT_DB_PATH } = require('./db');

const dbPath = process.env.DB_PATH || DEFAULT_DB_PATH;
const schemaPath = path.join(__dirname, 'db_setup.sql');

// Ensure the parent directory for the DB file exists before opening it.
fs.mkdirSync(path.dirname(dbPath), { recursive: true });

function isAlreadyInitialised(db) {
  try {
    const row = db
      .prepare(
        `SELECT 1 FROM geometry_columns
         WHERE lower(f_table_name) = 'zip_codes' AND lower(f_geometry_column) = 'geom'`
      )
      .get();
    return Boolean(row);
  } catch (_err) {
    // geometry_columns doesn't exist yet -> SpatiaLite metadata not initialised.
    return false;
  }
}

function main() {
  const db = openDb({ readonly: false, dbPath });

  try {
    console.log(`Using SpatiaLite extension: ${db.loadSpatialiteName}`);
    console.log(`Database file:              ${dbPath}`);

    if (isAlreadyInitialised(db)) {
      console.log('\nDatabase already initialised (zip_codes/geom registered). Nothing to do.');
      return;
    }

    const schema = fs.readFileSync(schemaPath, 'utf8');
    console.log(`\nApplying schema from ${schemaPath} ...`);
    db.exec(schema);

    // Confirm the spatial wiring is in place.
    const geomCol = db
      .prepare(
        `SELECT srid, geometry_type, spatial_index_enabled
         FROM geometry_columns
         WHERE lower(f_table_name) = 'zip_codes' AND lower(f_geometry_column) = 'geom'`
      )
      .get();

    if (!geomCol) {
      throw new Error('Schema applied but geometry column was not registered.');
    }

    console.log('\nSetup complete.');
    console.log(
      `  geom: srid=${geomCol.srid}, type=${geomCol.geometry_type}, ` +
        `spatial_index_enabled=${geomCol.spatial_index_enabled}`
    );
    console.log('\nNext: load data with `npm run import` (see README for GeoNames sourcing).');
  } finally {
    db.close();
  }
}

try {
  main();
} catch (err) {
  console.error('\nSetup failed:', err.message);
  process.exit(1);
}
