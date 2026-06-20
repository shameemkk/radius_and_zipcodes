'use strict';

/**
 * index.js — Zip Code Proximity Search API (Express + SQLite/SpatiaLite).
 *
 *   GET /api/v1/proximity-search?country=UK&zip_code=SW1A%201AA&radius=10
 *   GET /health
 *
 * All distance math runs in SQL via SpatiaLite's ST_Distance (geodesic metres).
 * The R-Tree spatial index is used as a bounding-box prefilter; JS only computes
 * that bounding box, never the distance itself.
 */

require('dotenv').config();

const express = require('express');
const { openDb } = require('./db');
const { boundingBox, validateParams, aggregateSgDistricts } = require('./lib');

const PORT = Number(process.env.PORT) || 3000;

// ---------------------------------------------------------------------------
// Database + prepared statements (compiled once at startup).
// ---------------------------------------------------------------------------
let db;
let originStmt;
let searchStmt;
let citySearchStmt;
let sgCitySearchStmt;
let healthStmt;

try {
  db = openDb({ readonly: true });

  healthStmt = db.prepare('SELECT spatialite_version() AS version');

  // AVG of the matching points collapses a multi-locality postal code to a
  // single representative origin. Returns one row; lon/lat are NULL if no match.
  originStmt = db.prepare(
    `SELECT AVG(ST_X(geom)) AS lon, AVG(ST_Y(geom)) AS lat
       FROM zip_codes
      WHERE country = @country AND zip_code = @zip`
  );

  // R-Tree prefilter (SpatialIndex virtual table) + exact geodesic refine.
  // ST_Distance(..., 1) -> metres on the ellipsoid for SRID 4326.
  searchStmt = db.prepare(
    `SELECT z.zip_code, z.city, z.state, z.country
       FROM zip_codes z
      WHERE z.country = @country
        AND z.ROWID IN (
              SELECT ROWID FROM SpatialIndex
               WHERE f_table_name = 'zip_codes'
                 AND search_frame = BuildMbr(@xmin, @ymin, @xmax, @ymax, 4326)
            )
        AND ST_Distance(z.geom, MakePoint(@olon, @olat, 4326), 1) <= @radius_m
      ORDER BY ST_Distance(z.geom, MakePoint(@olon, @olat, 4326), 1) ASC`
  );

  // City-search for non-SG countries: distinct (city, state) pairs with count.
  citySearchStmt = db.prepare(
    `SELECT z.city, z.state, z.country, COUNT(*) AS zip_count
       FROM zip_codes z
      WHERE z.country = @country
        AND z.ROWID IN (
              SELECT ROWID FROM SpatialIndex
               WHERE f_table_name = 'zip_codes'
                 AND search_frame = BuildMbr(@xmin, @ymin, @xmax, @ymax, 4326)
            )
        AND ST_Distance(z.geom, MakePoint(@olon, @olat, 4326), 1) <= @radius_m
      GROUP BY z.city, z.state, z.country
      ORDER BY z.city ASC`
  );

  // City-search for SG: group by postal sector (first 2 digits) instead of
  // street-level city, then JS maps sectors to named districts.
  sgCitySearchStmt = db.prepare(
    `SELECT SUBSTR(z.zip_code, 1, 2) AS sector, z.country, COUNT(*) AS zip_count
       FROM zip_codes z
      WHERE z.country = 'SG'
        AND z.ROWID IN (
              SELECT ROWID FROM SpatialIndex
               WHERE f_table_name = 'zip_codes'
                 AND search_frame = BuildMbr(@xmin, @ymin, @xmax, @ymax, 4326)
            )
        AND ST_Distance(z.geom, MakePoint(@olon, @olat, 4326), 1) <= @radius_m
      GROUP BY SUBSTR(z.zip_code, 1, 2), z.country
      ORDER BY sector ASC`
  );
} catch (err) {
  console.error('Failed to initialise database:', err.message);
  console.error(
    'Did you run `npm run setup` and load data with `npm run import`? ' +
      'Also ensure mod_spatialite is installed/loadable.'
  );
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Express app
// ---------------------------------------------------------------------------
const app = express();
app.disable('x-powered-by');

app.get('/health', (req, res) => {
  try {
    const { version } = healthStmt.get();
    res.json({ status: 'ok', spatialite: version });
  } catch (err) {
    res.status(503).json({ status: 'degraded', error: 'db_unavailable' });
  }
});

app.get('/api/v1/proximity-search', (req, res, next) => {
  const { errors, country, zip, radius } = validateParams(req.query);
  if (errors.length) {
    return res.status(400).json({ error: 'invalid_request', details: errors });
  }

  try {
    // 1) Resolve the origin point. A separate query lets us distinguish
    //    "origin not found" (404) from "found, but no neighbours" (200 []).
    const origin = originStmt.get({ country, zip });
    if (!origin || origin.lon === null || origin.lat === null) {
      return res.status(404).json({
        error: 'origin_not_found',
        message: `zip_code '${zip}' was not found for country '${country}'`,
      });
    }

    // 2) Bounding box for the R-Tree prefilter, then the exact radius search.
    const box = boundingBox(origin.lon, origin.lat, radius);
    const rows = searchStmt.all({
      country,
      xmin: box.xmin,
      ymin: box.ymin,
      xmax: box.xmax,
      ymax: box.ymax,
      olon: origin.lon,
      olat: origin.lat,
      radius_m: radius * 1000, // km -> metres (ST_Distance returns metres)
    });

    // Already in the exact required shape: { zip_code, city, state, country }.
    return res.json(rows);
  } catch (err) {
    return next(err);
  }
});

app.get('/api/v1/city-search', (req, res, next) => {
  const { errors, country, zip, radius } = validateParams(req.query);
  if (errors.length) {
    return res.status(400).json({ error: 'invalid_request', details: errors });
  }

  try {
    const origin = originStmt.get({ country, zip });
    if (!origin || origin.lon === null || origin.lat === null) {
      return res.status(404).json({
        error: 'origin_not_found',
        message: `zip_code '${zip}' was not found for country '${country}'`,
      });
    }

    const box = boundingBox(origin.lon, origin.lat, radius);
    const params = {
      country,
      xmin: box.xmin,
      ymin: box.ymin,
      xmax: box.xmax,
      ymax: box.ymax,
      olon: origin.lon,
      olat: origin.lat,
      radius_m: radius * 1000,
    };

    if (country === 'SG') {
      const rows = sgCitySearchStmt.all(params);
      return res.json(aggregateSgDistricts(rows));
    }

    return res.json(citySearchStmt.all(params));
  } catch (err) {
    return next(err);
  }
});

// Unknown routes.
app.use((req, res) => res.status(404).json({ error: 'not_found' }));

// Centralised error handler.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'internal_error' });
});

// ---------------------------------------------------------------------------
// Start + graceful shutdown
// ---------------------------------------------------------------------------
const server = app.listen(PORT, () => {
  console.log(`Zip proximity API listening on port ${PORT}`);
});

function shutdown(signal) {
  console.log(`\n${signal} received, shutting down...`);
  server.close(() => {
    try {
      db.close();
    } catch (_err) {
      /* ignore */
    }
    process.exit(0);
  });
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

module.exports = app; // exported for testing
