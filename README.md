# Zip Code Proximity Search API

A small, highly-performant **radius search** API: given an origin postal code and a
radius in kilometres, it returns every postal code within that radius. All distance
math runs **in SQL** via SpatiaLite — no Haversine in JavaScript — and is accelerated
by an R-Tree spatial index.

- **Runtime:** Node.js + Express
- **Database:** SQLite + [SpatiaLite](https://www.gaia-gis.it/fossil/libspatialite/index)
  (the SQLite analog of PostGIS)
- **Deploy:** multi-stage Docker image

> **Note on the stack.** The original brief mentioned PostGIS/`ST_DWithin` on Supabase.
> This implementation targets **SQLite + SpatiaLite** instead (a deliberate choice).
> SpatiaLite has no `ST_DWithin`; the equivalent — and what we use — is
> `ST_Distance(geom, origin, 1) <= radius_m`, where the `1` selects geodesic metres
> on SRID 4326. It is functionally identical and still evaluated entirely in SQL.

## API

> **Full API reference (parameters, responses, error codes, and how the radius
> search works): [API.md](API.md).**

### `GET /api/v1/proximity-search`

| Param      | Type   | Notes                                                                 |
| ---------- | ------ | --------------------------------------------------------------------- |
| `country`  | string | **Required.** One of `UK`, `AU`, `MX`, `US`, `SG` (case-insensitive). Else `400`. |
| `zip_code` | string | **Required.** The origin postal code.                                 |
| `radius`   | number | **Required.** Distance in **kilometres**; positive, finite.           |

**Success `200`** — array (nearest first; includes the origin itself):

```json
[
  { "zip_code": "2000", "city": "Sydney", "state": "New South Wales", "country": "AU" },
  { "zip_code": "2007", "city": "Ultimo", "state": "New South Wales", "country": "AU" }
]
```

**Responses**

| Status | When                                                            |
| ------ | -------------------------------------------------------------- |
| `200`  | Success. An empty array `[]` means "origin found, no neighbours". |
| `400`  | `invalid_request` — bad/missing `country`, `zip_code`, or `radius`. |
| `404`  | `origin_not_found` — the origin `zip_code` isn't in the database.  |
| `500`  | `internal_error`.                                              |

### `GET /health`

Returns `{ "status": "ok", "spatialite": "<version>" }` (confirms the SpatiaLite
extension loaded), or `503` if the database is unavailable.

## Quick start (Docker — recommended, works on Windows/macOS/Linux)

**The database is built into the image at build time** from the committed
`data/*.txt` files (the Dockerfile's "seeder" stage runs `setup` + `import`). All
~232k zip codes ship inside the container, so running it needs **no setup, no
import, and no volume** — and you don't need `mod_spatialite` on your host.

```powershell
# Build (loads the data) and serve on http://localhost:3000
docker compose up -d --build

# Try it (use curl.exe on Windows for raw JSON)
curl.exe "http://localhost:3000/health"
curl.exe "http://localhost:3000/api/v1/proximity-search?country=us&zip_code=10001&radius=10"
```

That's the whole thing. To stop: `docker compose down`.

### Works with `git` out of the box

The repo tracks **code + the GeoNames `data/*.txt` source files**; the generated
SQLite database is *not* in git (it's rebuilt during the image build). So anyone
can:

```bash
git clone <repo> && cd <repo>
docker compose up -d --build      # builds the DB from data/*.txt → runs
```

No seed file to ship, no data download, no extra step.

> `curl.exe` (with the `.exe`) shows raw JSON. `Invoke-RestMethod` also works but
> wraps arrays as `{"value":[...]}` in its display — that's just PowerShell.

## Deployment

Because the data is inside the image, deploying is just shipping and running the
image — no database step on the server:

```bash
# Build locally (or in CI)
docker build -t <registry>/zip-proximity-api:1.0 .

# Push, then on the server:
docker push <registry>/zip-proximity-api:1.0
docker run -d -p 3000:3000 --restart unless-stopped <registry>/zip-proximity-api:1.0
```

No `setup`, no `import`, no mounted volume, no GeoNames files on the server.

## Refreshing the data

The database is built from `data/*.txt` during the image build, so updating the
data is just: replace the files and rebuild.

```powershell
# 1. Drop updated GeoNames files in ./data (GB.txt, AU.txt, MX.txt, US.txt, SG.txt)
#    (download fresh archives from https://download.geonames.org/export/zip/)

# 2. Rebuild — the seeder stage re-imports them
docker compose up -d --build
```

Commit the changed `data/*.txt` to git so other builds pick up the same data.

## Local development (without Docker)

```bash
npm install
npm run setup
npm run import      # after downloading data — see below
npm run dev         # auto-reload, or: npm start
```

Requires `mod_spatialite` to be loadable:

- **Linux:** `sudo apt-get install libsqlite3-mod-spatialite`
- **macOS:** `brew install libspatialite` (you may need to set `SPATIALITE_PATH`)
- **Windows:** download the SpatiaLite Windows binaries from
  [gaia-gis.it](https://www.gaia-gis.it/gaia-sins/), put the DLLs on your `PATH`,
  and set `SPATIALITE_PATH` to the full path of `mod_spatialite.dll`.
  If that's fiddly, just use the Docker path above — it Just Works on Linux.

## Loading data

Postal data comes from **GeoNames** (free, CC-BY):
<https://download.geonames.org/export/zip/>

1. Download the per-country archives and unzip the `.txt` files into `./data/`:
   - `GB.zip` → `GB.txt` (United Kingdom — GeoNames uses ISO **`GB`**; the importer
     **remaps it to `UK`** to match the API contract)
   - `AU.zip` → `AU.txt` (Australia)
   - `MX.zip` → `MX.txt` (Mexico)
   - `US.zip` → `US.txt` (United States)
   - `SG.zip` → `SG.txt` (Singapore — a city-state, so `state` is blank)
2. Load:
   ```bash
   npm run import                          # auto-discovers ./data/{GB,AU,MX,US,SG}.txt
   npm run import -- ./data/GB.txt          # or pass explicit paths
   npm run import -- --truncate ./data/GB.txt   # clear table first
   ```

The importer streams the TSV, skips malformed/out-of-range rows, builds each point
with `MakePoint(longitude, latitude, 4326)`, inserts in batched transactions, and
runs `ANALYZE` at the end.

## Configuration

| Env var           | Default               | Purpose                                    |
| ----------------- | --------------------- | ------------------------------------------ |
| `DB_PATH`         | `./data/zipcodes.db`  | SQLite database file path.                 |
| `PORT`            | `3000`                | HTTP listen port.                          |
| `SPATIALITE_PATH` | _(auto)_              | Full path to `mod_spatialite` if needed.   |

See `.env.example`.

## How the search works

1. **Validate** `country` (case-insensitive whitelist), `zip_code`, `radius`.
2. **Resolve origin** with a separate query (`AVG(ST_X)`, `AVG(ST_Y)` — collapses a
   multi-locality postal code to one representative point). No match → `404`
   (distinct from a valid empty result).
3. **Search** with an R-Tree bounding-box prefilter (`SpatialIndex` virtual table)
   then an exact geodesic refine: `ST_Distance(geom, origin, 1) <= radius * 1000`.
   Results are ordered nearest-first. JS computes only the bounding box; the
   distance test itself is SQL.

All queries use **named/bound parameters**, so user input is never concatenated into
SQL (injection-safe).

## Project layout

| File             | Purpose                                              |
| ---------------- | ---------------------------------------------------- |
| `db_setup.sql`   | SpatiaLite schema (table, geometry column, indexes). |
| `setup.js`       | Loads the extension and applies `db_setup.sql`.      |
| `db.js`          | Shared connection + SpatiaLite loader.               |
| `lib.js`         | Pure helpers: param validation + bounding-box math.  |
| `index.js`       | Express server, route handlers, prepared queries.    |
| `import-data.js` | GeoNames bulk importer (`GB`→`UK` remap).            |
| `Dockerfile`     | Multi-stage build (compile native addon → slim run). |
