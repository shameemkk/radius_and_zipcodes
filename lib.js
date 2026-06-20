'use strict';

/**
 * lib.js — pure, side-effect-free helpers (validation + geometry math).
 *
 * Kept separate from index.js so they can be unit-tested without opening a
 * database connection.
 */

const VALID_COUNTRIES = new Set(['UK', 'AU', 'MX', 'US', 'SG']);

// Maps the first 2 digits of a Singapore 6-digit postal code (postal sector)
// to the standard 28-district grouping used by SLA / URA.
// Sectors not in the official 28 districts are assigned to the nearest area.
const SG_SECTOR_TO_DISTRICT = {
  '01': { area: 'Raffles Place / Marina / Cecil',     district: 'D01' },
  '02': { area: 'Raffles Place / Marina / Cecil',     district: 'D01' },
  '03': { area: 'Raffles Place / Marina / Cecil',     district: 'D01' },
  '04': { area: 'Raffles Place / Marina / Cecil',     district: 'D01' },
  '05': { area: 'Raffles Place / Marina / Cecil',     district: 'D01' },
  '06': { area: 'Raffles Place / Marina / Cecil',     district: 'D01' },
  '07': { area: 'Tanjong Pagar / Anson',              district: 'D02' },
  '08': { area: 'Tanjong Pagar / Anson',              district: 'D02' },
  '09': { area: 'Queenstown / Tiong Bahru',           district: 'D03' },
  '10': { area: 'Queenstown / Tiong Bahru',           district: 'D03' },
  '11': { area: 'Queenstown / Tiong Bahru',           district: 'D03' },
  '12': { area: 'Queenstown / Tiong Bahru',           district: 'D03' },
  '13': { area: 'Queenstown / Tiong Bahru',           district: 'D03' },
  '14': { area: 'Queenstown / Tiong Bahru',           district: 'D03' },
  '15': { area: 'Queenstown / Tiong Bahru',           district: 'D03' },
  '16': { area: 'Queenstown / Tiong Bahru',           district: 'D03' },
  '17': { area: 'Telok Blangah / Harbourfront',       district: 'D04' },
  '18': { area: 'Clementi / Pasir Panjang',           district: 'D05' },
  '19': { area: 'Clementi / Pasir Panjang',           district: 'D05' },
  '20': { area: 'Clementi / Pasir Panjang',           district: 'D05' },
  '21': { area: 'Clementi / Pasir Panjang',           district: 'D05' },
  '22': { area: 'City Hall / Beach Road',             district: 'D06' },
  '23': { area: 'City Hall / Beach Road',             district: 'D06' },
  '24': { area: 'Middle Road / Golden Mile',          district: 'D07' },
  '25': { area: 'Middle Road / Golden Mile',          district: 'D07' },
  '26': { area: 'Middle Road / Golden Mile',          district: 'D07' },
  '27': { area: 'Middle Road / Golden Mile',          district: 'D07' },
  '28': { area: 'Little India',                       district: 'D08' },
  '29': { area: 'Little India',                       district: 'D08' },
  '30': { area: 'Orchard / River Valley',             district: 'D09' },
  '31': { area: 'Orchard / River Valley',             district: 'D09' },
  '32': { area: 'Orchard / River Valley',             district: 'D09' },
  '33': { area: 'Orchard / River Valley',             district: 'D09' },
  '34': { area: 'Buona Vista / Holland Village',      district: 'D10' },
  '35': { area: 'Buona Vista / Holland Village',      district: 'D10' },
  '36': { area: 'Buona Vista / Holland Village',      district: 'D10' },
  '37': { area: 'Buona Vista / Holland Village',      district: 'D10' },
  '38': { area: 'Novena / Thomson',                   district: 'D11' },
  '39': { area: 'Novena / Thomson',                   district: 'D11' },
  '40': { area: 'Toa Payoh / Balestier',              district: 'D12' },
  '41': { area: 'Toa Payoh / Balestier',              district: 'D12' },
  '42': { area: 'Macpherson / Braddell',              district: 'D13' },
  '43': { area: 'Macpherson / Braddell',              district: 'D13' },
  '44': { area: 'Macpherson / Braddell',              district: 'D13' },
  '45': { area: 'Macpherson / Braddell',              district: 'D13' },
  '46': { area: 'Geylang / Eunos',                    district: 'D14' },
  '47': { area: 'Geylang / Eunos',                    district: 'D14' },
  '48': { area: 'Geylang / Eunos',                    district: 'D14' },
  '49': { area: 'Katong / Joo Chiat / Amber',         district: 'D15' },
  '50': { area: 'Katong / Joo Chiat / Amber',         district: 'D15' },
  '51': { area: 'Katong / Joo Chiat / Amber',         district: 'D15' },
  '52': { area: 'Katong / Joo Chiat / Amber',         district: 'D15' },
  '53': { area: 'Bedok / Upper East Coast',           district: 'D16' },
  '54': { area: 'Bedok / Upper East Coast',           district: 'D16' },
  '55': { area: 'Bedok / Upper East Coast',           district: 'D16' },
  '56': { area: 'Changi / Loyang',                    district: 'D17' },
  '57': { area: 'Changi / Loyang',                    district: 'D17' },
  '58': { area: 'Tampines / Pasir Ris',               district: 'D18' },
  '59': { area: 'Tampines / Pasir Ris',               district: 'D18' },
  '60': { area: 'Hougang / Sengkang / Punggol',       district: 'D19' },
  '61': { area: 'Hougang / Sengkang / Punggol',       district: 'D19' },
  '62': { area: 'Hougang / Sengkang / Punggol',       district: 'D19' },
  '63': { area: 'Hougang / Sengkang / Punggol',       district: 'D19' },
  '64': { area: 'Hougang / Sengkang / Punggol',       district: 'D19' },
  '65': { area: 'Ang Mo Kio / Bishan',                district: 'D20' },
  '66': { area: 'Ang Mo Kio / Bishan',                district: 'D20' },
  '67': { area: 'Ang Mo Kio / Bishan',                district: 'D20' },
  '68': { area: 'Ang Mo Kio / Bishan',                district: 'D20' },
  '69': { area: 'Clementi Park / Upper Bukit Timah',  district: 'D21' },
  '70': { area: 'Clementi Park / Upper Bukit Timah',  district: 'D21' },
  '71': { area: 'Clementi Park / Upper Bukit Timah',  district: 'D21' },
  '72': { area: 'Jurong',                             district: 'D22' },
  '73': { area: 'Jurong',                             district: 'D22' },
  '74': { area: 'Jurong',                             district: 'D22' },
  '75': { area: 'Lim Chu Kang / Tengah',              district: 'D24' },
  '76': { area: 'Lim Chu Kang / Tengah',              district: 'D24' },
  '77': { area: 'Bukit Panjang / Dairy Farm',         district: 'D23' },
  '78': { area: 'Bukit Panjang / Dairy Farm',         district: 'D23' },
  '79': { area: 'Woodlands / Kranji',                 district: 'D25' },
  '80': { area: 'Woodlands / Kranji',                 district: 'D25' },
  '81': { area: 'Yishun / Sembawang',                 district: 'D27' },
  '82': { area: 'Yishun / Sembawang',                 district: 'D27' },
  '88': { area: 'Sentosa / Harbourfront',             district: 'D04' },
  '91': { area: 'Sengkang / Punggol (North-East)',    district: 'D19' },
};

/**
 * Given an array of DB rows from the SG sector query (each has `sector`,
 * `country`, `zip_count`), aggregate by district and return sorted results.
 * Sectors not in the lookup are grouped under "Unknown".
 */
function aggregateSgDistricts(rows) {
  const map = new Map(); // district key → accumulated entry
  for (const row of rows) {
    const info = SG_SECTOR_TO_DISTRICT[row.sector] || {
      area: `Sector ${row.sector}`,
      district: `S${row.sector}`,
    };
    const key = info.district;
    if (map.has(key)) {
      map.get(key).zip_count += row.zip_count;
    } else {
      map.set(key, {
        city: info.area,
        state: info.district,
        country: row.country,
        zip_count: row.zip_count,
      });
    }
  }
  return [...map.values()].sort((a, b) => a.state.localeCompare(b.state));
}

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
  SG_SECTOR_TO_DISTRICT,
  MAX_RADIUS_KM,
  asString,
  boundingBox,
  validateParams,
  aggregateSgDistricts,
};
