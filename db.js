'use strict';

/**
 * db.js — shared SQLite + SpatiaLite connection helper.
 *
 * Every entry point (the API server, the setup script, the import script) opens
 * the database through here so the SpatiaLite extension is loaded consistently.
 */

const path = require('path');
const Database = require('better-sqlite3');

const DEFAULT_DB_PATH = path.join(__dirname, 'data', 'zipcodes.db');

/**
 * Candidate names/paths for the mod_spatialite shared library. better-sqlite3's
 * loadExtension() hands the string to the OS dynamic loader, so a bare name
 * resolves via the system library path (the common case on Linux/Docker, where
 * `apt-get install libsqlite3-mod-spatialite` puts it on the loader path).
 *
 * On native Windows you typically need the SpatiaLite DLLs on PATH and may have
 * to set SPATIALITE_PATH to the full path of `mod_spatialite.dll`.
 */
function spatialiteCandidates() {
  const fromEnv = process.env.SPATIALITE_PATH;
  return [
    fromEnv,
    'mod_spatialite',
    'mod_spatialite.so',
    'libspatialite.so',
    'mod_spatialite.dll',
  ].filter(Boolean);
}

function loadSpatialite(db) {
  const tried = [];
  for (const candidate of spatialiteCandidates()) {
    try {
      db.loadExtension(candidate);
      return candidate;
    } catch (err) {
      tried.push(`${candidate} (${err.message})`);
    }
  }
  throw new Error(
    'Failed to load the SpatiaLite extension. Tried:\n  ' +
      tried.join('\n  ') +
      '\n\nInstall it (Linux/Docker: `apt-get install libsqlite3-mod-spatialite`) ' +
      'or set SPATIALITE_PATH to the full path of the mod_spatialite library.'
  );
}

/**
 * Open a SpatiaLite-enabled database connection.
 *
 * @param {object} [opts]
 * @param {boolean} [opts.readonly=false] Open read-only (used by the API server
 *   for safe concurrency; setup/import open read-write).
 * @param {string}  [opts.dbPath]         Override the DB file path.
 * @returns {import('better-sqlite3').Database}
 */
function openDb({ readonly = false, dbPath = process.env.DB_PATH || DEFAULT_DB_PATH } = {}) {
  const db = new Database(dbPath, { readonly, fileMustExist: readonly });

  // loadExtension requires extension loading to be enabled on the connection.
  db.loadSpatialiteName = loadSpatialite(db);

  // busy_timeout is safe on any connection.
  db.pragma('busy_timeout = 5000');

  // NOTE: we deliberately do NOT use WAL. This database is built once (offline)
  // and served read-only, often from a Docker bind-mount / read-only volume —
  // environments where WAL's shared-memory (-shm) coordination is unreliable
  // ("disk I/O error") or impossible (read-only filesystem). The default
  // rollback journal (set to DELETE in db_setup.sql) works everywhere. See README.

  return db;
}

module.exports = { openDb, DEFAULT_DB_PATH };
