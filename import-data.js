'use strict';

/**
 * import-data.js — bulk-load GeoNames postal data into the zip_codes table.
 *
 * Data source: https://download.geonames.org/export/zip/  (free, CC-BY)
 *   Download the per-country archives and unzip the .txt files:
 *     GB.zip -> GB.txt   (United Kingdom — GeoNames uses ISO 'GB'; we remap -> 'UK')
 *     AU.zip -> AU.txt   (Australia)
 *     MX.zip -> MX.txt   (Mexico)
 *
 * GeoNames postal files are TAB-separated with these columns:
 *   0 country_code   1 postal_code   2 place_name   3 admin_name1 (state/region)
 *   4 admin_code1    5 admin_name2   6 admin_code2  7 admin_name3
 *   8 admin_code3    9 latitude     10 longitude   11 accuracy
 *
 * Usage:
 *   npm run import                         # auto-discovers ./data/{GB,AU,MX}.txt
 *   npm run import -- ./data/GB.txt ./AU.txt
 *   npm run import -- --truncate ./data/GB.txt   # clear table first, then load
 */

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { openDb, DEFAULT_DB_PATH } = require('./db');
const { VALID_COUNTRIES } = require('./lib');

const BATCH_SIZE = 5000;
// GeoNames -> API country token remapping. Anything not in VALID_COUNTRIES after
// remapping is skipped (so even an allCountries.txt would be filtered correctly).
// VALID_COUNTRIES is the single source of truth, shared with the API (lib.js).
const COUNTRY_REMAP = { GB: 'UK' };

// GeoNames per-country filenames to auto-discover (note: GeoNames uses 'GB', not
// 'UK', and 'US' for the United States).
const DEFAULT_FILES = ['GB.txt', 'AU.txt', 'MX.txt', 'US.txt'];

function parseArgs(argv) {
  const files = [];
  let truncate = false;
  for (const arg of argv) {
    if (arg === '--truncate') truncate = true;
    else files.push(arg);
  }
  return { files, truncate };
}

function discoverDefaultFiles() {
  // Input .txt files may live somewhere other than the DB directory (e.g. the DB
  // is in a Docker volume while inputs are bind-mounted at INPUT_DIR).
  const dir =
    process.env.INPUT_DIR || path.dirname(process.env.DB_PATH || DEFAULT_DB_PATH);
  return DEFAULT_FILES
    .map((f) => path.join(dir, f))
    .filter((p) => fs.existsSync(p));
}

/** Parse one GeoNames TSV line into a record, or null if it should be skipped. */
function parseLine(line) {
  if (!line || !line.trim()) return null;
  const c = line.split('\t');
  if (c.length < 11) return null;

  const rawCountry = (c[0] || '').trim().toUpperCase();
  const country = COUNTRY_REMAP[rawCountry] || rawCountry;
  if (!VALID_COUNTRIES.has(country)) return null;

  const zip = (c[1] || '').trim();
  if (!zip) return null;

  const lat = parseFloat(c[9]);
  const lon = parseFloat(c[10]);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;

  const city = (c[2] || '').trim();
  // Prefer admin_name1 (state/region); fall back to admin_name2 (county).
  const state = ((c[3] || '').trim() || (c[5] || '').trim());

  return { country, zip, city, state, lon, lat };
}

async function importFile(db, insertBatch, filePath) {
  const rl = readline.createInterface({
    input: fs.createReadStream(filePath),
    crlfDelay: Infinity,
  });

  let inserted = 0;
  let skipped = 0;
  let batch = [];

  for await (const line of rl) {
    const rec = parseLine(line);
    if (!rec) {
      if (line && line.trim()) skipped += 1;
      continue;
    }
    batch.push(rec);
    if (batch.length >= BATCH_SIZE) {
      insertBatch(batch);
      inserted += batch.length;
      batch = [];
    }
  }
  if (batch.length) {
    insertBatch(batch);
    inserted += batch.length;
  }

  return { inserted, skipped };
}

async function main() {
  const { files: argFiles, truncate } = parseArgs(process.argv.slice(2));
  const files = argFiles.length ? argFiles : discoverDefaultFiles();

  if (!files.length) {
    console.error(
      'No input files given and none found in the data directory.\n\n' +
        'Download postal archives from https://download.geonames.org/export/zip/\n' +
        '(GB.zip, AU.zip, MX.zip), unzip the .txt files into ./data/, then re-run\n' +
        '`npm run import`, or pass explicit paths: `npm run import -- ./data/GB.txt`.'
    );
    process.exit(1);
  }

  for (const f of files) {
    if (!fs.existsSync(f)) {
      console.error(`Input file not found: ${f}`);
      process.exit(1);
    }
  }

  const db = openDb({ readonly: false });

  // Fail early with a clear message if the schema isn't set up yet.
  const insert = (() => {
    try {
      return db.prepare(
        `INSERT INTO zip_codes (country, zip_code, city, state, geom)
         VALUES (@country, @zip, @city, @state, MakePoint(@lon, @lat, 4326))`
      );
    } catch (err) {
      console.error('Could not prepare INSERT — has the schema been created?');
      console.error('Run `npm run setup` first. Underlying error:', err.message);
      process.exit(1);
    }
  })();

  const insertBatch = db.transaction((rows) => {
    for (const r of rows) insert.run(r);
  });

  try {
    if (truncate) {
      const { c } = db.prepare('SELECT COUNT(*) AS c FROM zip_codes').get();
      db.exec('DELETE FROM zip_codes');
      console.log(`Truncated zip_codes (${c} rows removed).`);
    }

    let totalInserted = 0;
    let totalSkipped = 0;
    for (const file of files) {
      process.stdout.write(`Importing ${file} ... `);
      const { inserted, skipped } = await importFile(db, insertBatch, file);
      console.log(`inserted ${inserted}, skipped ${skipped}`);
      totalInserted += inserted;
      totalSkipped += skipped;
    }

    // Refresh planner statistics for the R-Tree + btree indexes.
    db.exec('ANALYZE');

    const summary = db
      .prepare(
        `SELECT country, COUNT(*) AS n FROM zip_codes GROUP BY country ORDER BY country`
      )
      .all();

    console.log('\nImport complete.');
    console.log(`  total inserted: ${totalInserted}`);
    console.log(`  total skipped:  ${totalSkipped}`);
    console.log('  rows per country:');
    for (const row of summary) console.log(`    ${row.country}: ${row.n}`);
  } finally {
    db.close();
  }
}

main().catch((err) => {
  console.error('\nImport failed:', err.message);
  process.exit(1);
});
