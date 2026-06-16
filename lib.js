'use strict';

/**
 * lib.js — pure, side-effect-free helpers (validation + geometry math).
 *
 * Kept separate from index.js so they can be unit-tested without opening a
 * database connection.
 */

const VALID_COUNTRIES = new Set(['UK', 'AU', 'MX', 'US']);

// Pre-formatted for the 400 error message; derived from the set so adding a
// country in one place keeps the message in sync.
const COUNTRY_LIST = [...VALID_COUNTRIES].map((c) => `'${c}'`).join(', ');

// Half of Earth's circumference (~20015 km) is the max possible separation.
// Cap a little above that purely as an abuse guard.
const MAX_RADIUS_KM = 20000;

// Approximate kilometres per degree (good enough for an R-Tree prefilter box;
// the exact filtering is done by ST_Distance in SQL).
const KM_PER_DEG_LAT = 110.574;
const KM_PER_DEG_LON_EQUATOR = 111.32;

/** Normalise a query param (which may be string | string[] | undefined) to a string. */
function asString(value) {
  if (Array.isArray(value)) value = value[0];
  if (value == null) return '';
  return String(value);
}

/**
 * Compute a lon/lat bounding box that fully contains the radius circle. Used
 * only to drive the R-Tree prefilter — it is intentionally a generous superset;
 * ST_Distance does the precise cut.
 */
function boundingBox(lon, lat, radiusKm) {
  const latRad = (lat * Math.PI) / 180;
  // Clamp cos(lat) so we never divide by ~0 near the poles.
  const cosLat = Math.max(Math.cos(latRad), 0.01);
  const dLat = radiusKm / KM_PER_DEG_LAT;
  const dLon = radiusKm / (KM_PER_DEG_LON_EQUATOR * cosLat);
  return {
    xmin: lon - dLon,
    xmax: lon + dLon,
    ymin: lat - dLat,
    ymax: lat + dLat,
  };
}

/**
 * Strictly validate + normalise the three query params.
 * @returns {{ errors: string[], country: string, zip: string, radius: number }}
 */
function validateParams(query) {
  const errors = [];

  const country = asString(query.country).trim().toUpperCase();
  const zip = asString(query.zip_code).trim();
  const radiusRaw = asString(query.radius).trim();

  if (!VALID_COUNTRIES.has(country)) {
    errors.push(`country must be one of ${COUNTRY_LIST}`);
  }

  if (!zip) {
    errors.push('zip_code is required');
  }

  // Number('') === 0, so guard the empty string explicitly before coercing.
  const radius = radiusRaw === '' ? NaN : Number(radiusRaw);
  if (!Number.isFinite(radius) || radius <= 0) {
    errors.push('radius must be a positive number (kilometres)');
  } else if (radius > MAX_RADIUS_KM) {
    errors.push(`radius must be <= ${MAX_RADIUS_KM} km`);
  }

  return { errors, country, zip, radius };
}

module.exports = {
  VALID_COUNTRIES,
  MAX_RADIUS_KM,
  asString,
  boundingBox,
  validateParams,
};
