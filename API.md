
# API Reference — Zip Code Proximity Search

Base URL (local): `http://localhost:3000`

All responses are JSON. No authentication. Only `GET` is used.

---

## `GET /api/v1/proximity-search`

Returns every postal code within a given radius of an origin postal code,
**nearest first**.

### Query parameters

| Parameter  | Type   | Required | Rules |
| ---------- | ------ | :------: | ----- |
| `country`  | string | yes | One of `UK`, `AU`, `MX`, `US`. **Case-insensitive** (`us` = `US`). Any other value → `400`. |
| `zip_code` | string | yes | The origin postal code. Matched against stored values (see [Postal-code format](#postal-code-format)). |
| `radius`   | number | yes | Distance in **kilometres**. Must be a positive, finite number, `0 < radius ≤ 20000`. |

### Success — `200 OK`

A JSON **array** (possibly empty), each element exactly:

```json
{
  "zip_code": "10001",
  "city": "New York",
  "state": "New York",
  "country": "US"
}
```

The array is ordered **closest to the origin first**, and **includes the origin
postal code itself** (it is at distance 0).

### Example

```bash
curl "http://localhost:3000/api/v1/proximity-search?country=us&zip_code=10001&radius=10"
```

```json
[
  { "zip_code": "10001", "city": "New York", "state": "New York", "country": "US" },
  { "zip_code": "10199", "city": "New York", "state": "New York", "country": "US" },
  { "zip_code": "10121", "city": "New York", "state": "New York", "country": "US" }
]
```

> On Windows PowerShell use `curl.exe` (not the `curl` alias) to see raw JSON.

### Error responses

| Status | `error` | When |
| ------ | ------- | ---- |
| `400`  | `invalid_request` | Missing/invalid `country`, `zip_code`, or `radius`. `details` lists each problem. |
| `404`  | `origin_not_found` | The origin `zip_code` does not exist for that `country`. |
| `500`  | `internal_error` | Unexpected server/database error. |

```jsonc
// 400 — country=CA, radius=abc
{ "error": "invalid_request",
  "details": ["country must be one of 'UK', 'AU', 'MX', 'US'",
              "radius must be a positive number (kilometres)"] }

// 404 — country=US, zip_code=00000
{ "error": "origin_not_found",
  "message": "zip_code '00000' was not found for country 'US'" }
```

#### `200 []` vs `404`
- **`404`** means the origin itself isn't in the database — we couldn't even find
  a starting point.
- **`200` with `[]`** means the origin was found but nothing (not even itself)
  fell inside the radius. Because the origin is always at distance 0, this is rare
  in practice — it only happens for a multi-locality origin whose averaged centre
  sits farther than `radius` from every one of its localities.

---

## `GET /health`

Liveness check. `200` when the service and SpatiaLite extension are up.

```bash
curl "http://localhost:3000/health"
```
```json
{ "status": "ok", "spatialite": "5.0.1" }
```
Returns `503 {"status":"degraded","error":"db_unavailable"}` if the database
can't be queried.

---

## How the radius works

### 1. Units — kilometres
`radius` is in **kilometres**. `radius=10` means "within 10 km". Internally it is
converted to metres (`radius × 1000`) because the distance function works in
metres.

### 2. What "within the radius" means
It is the **straight-line distance across the surface of the Earth** (a geodesic
"as the crow flies" distance), **not** road/travel distance and **not** a simple
flat-map approximation. The database computes it on the WGS84 ellipsoid
(SpatiaLite's `ST_Distance(..., use_ellipsoid = 1)`), so it is accurate over both
short and long distances and accounts for the Earth's curvature.

A postal code is included when:

```
distance(origin_point, candidate_point) ≤ radius
```

### 3. Finding the origin point
The origin's coordinates come from the `(country, zip_code)` you supply. Some
postal codes map to **several localities** (e.g. UK `BR1` covers both *Bromley*
and *Bickley*). In that case the origin is the **average (centroid)** of those
points — one representative centre — so the search still has a single origin.

### 4. The origin is included; results are sorted nearest-first
The origin postal code is at distance 0, so it is always the **first** result
(when it exists in the data). Every other result follows in order of increasing
distance.

### 5. Why it's fast (two-step search)
Measuring the exact distance to all ~232,000 points on every request would be
slow. So the query runs in two steps:

1. **Bounding-box pre-filter (the spatial index).** A rectangle roughly `radius`
   wide is drawn around the origin, and the **R-Tree spatial index** instantly
   returns only the points inside that rectangle — skipping everything far away.
2. **Exact distance refine.** For just those candidates, the precise geodesic
   distance is computed and only those `≤ radius` are kept, then sorted.

The rectangle is a generous superset of the circle (its corners are farther than
`radius`), so step 2 trims the corners. **No distance math runs in the
application code** — the database does all of it.

### 6. Same-country only
The search is restricted to the **same country** as the origin. UK/AU/MX/US are
far apart, so this is both correct (you never get a US result for a UK query) and
faster.

### 7. Limits and edge cases
| Input | Behaviour |
| ----- | --------- |
| `radius ≤ 0`, non-numeric, empty, or `> 20000` | `400 invalid_request` |
| Very large radius (e.g. `5000`) | Works; effectively returns most/all of that country (and is slower). |
| Origin postal code not in the data | `404 origin_not_found` |
| No neighbours within the radius | `200` with just the origin (or `[]` — see above) |

### Worked example
`country=AU&zip_code=2000&radius=10` (Sydney, 10 km):
1. Origin = Sydney `2000`'s coordinates (~ `-33.87, 151.21`).
2. A ~10 km box is drawn around it; the spatial index returns the candidate
   points inside it.
3. Exact geodesic distance is measured; codes ≤ 10 km are kept and sorted.
4. Result: `2000` first (0 km), then `2007` (~1.6 km), `2060` (~3.4 km), … —
   Melbourne `3000` (~713 km) is **not** included. Raising `radius` to `1000`
   would include it.

---

## Postal-code format

`zip_code` is matched against the values as stored from the source data, so use
the same form:

- **US / MX** — numeric (`10001`, `06000`).
- **AU** — 4-digit (`2000`).
- **UK** — GeoNames' free dataset stores **outward codes** (the first part:
  `M9`, `BR1`, `SW1A`), uppercase. Full unit postcodes like `SW1A 1AA` are a
  separate, separately-licensed dataset and are not loaded by default.

> Matching is currently exact (case- and space-sensitive). For UK especially,
> pass the outward code in uppercase (e.g. `M9`, not `m9`).

## Supported countries & data

Data is from [GeoNames](https://download.geonames.org/export/zip/) (free,
CC-BY). GeoNames labels the UK as `GB`; the importer remaps it to `UK` to match
the API. Current load: UK 27,450 · AU 18,521 · MX 144,655 · US 41,490.
