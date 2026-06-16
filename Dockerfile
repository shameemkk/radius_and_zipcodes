# =============================================================================
# Multi-stage build for the Zip Proximity Search API (Node + SQLite/SpatiaLite)
#
# The GeoNames postal data is loaded into the SQLite/SpatiaLite database DURING
# the build (the "seeder" stage), straight from the tracked data/*.txt files.
# The final image is fully self-contained, so:
#     git clone  +  docker build   →   ready-to-run, data-loaded image
# No manual setup/import/seed step, and nothing data-related lives outside git
# except the .txt source files (which ARE committed).
# =============================================================================

# ---- Stage 1: builder — production node_modules -----------------------------
# better-sqlite3 is a native addon; the slim image lacks a toolchain, so install
# build deps here. They stay out of the seeder and runtime images.
FROM node:22-slim AS builder
WORKDIR /app
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# ---- Stage 2: seeder — build the database from data/*.txt -------------------
# Same base as builder so the compiled better-sqlite3 binary's ABI matches.
FROM node:22-slim AS seeder
WORKDIR /app
RUN apt-get update \
    && apt-get install -y --no-install-recommends libsqlite3-mod-spatialite \
    && rm -rf /var/lib/apt/lists/*
COPY --from=builder /app/node_modules ./node_modules
COPY package.json db.js lib.js setup.js import-data.js db_setup.sql ./
# Only data/*.txt enter the build context (see .dockerignore); the .db files do not.
COPY data/ ./data/
ENV DB_PATH=/app/db/zipcodes.db
ENV INPUT_DIR=/app/data
RUN npm run setup && npm run import

# ---- Stage 3: runtime — slim, non-root, data baked in -----------------------
FROM node:22-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app

# Runtime SpatiaLite library (pulls in libgeos/libproj). Loaded by db.js via
# better-sqlite3's loadExtension('mod_spatialite').
RUN apt-get update \
    && apt-get install -y --no-install-recommends libsqlite3-mod-spatialite \
    && rm -rf /var/lib/apt/lists/*

COPY --from=builder /app/node_modules ./node_modules

# Application code. setup.js/import-data.js/db_setup.sql are included too so the
# DB can also be rebuilt inside a container if ever needed (e.g. into a volume).
COPY package.json index.js db.js lib.js setup.js import-data.js db_setup.sql ./

# Bring in the database built by the seeder stage. The image is now self-contained.
RUN mkdir -p /app/db && chown -R node:node /app/db
COPY --from=seeder --chown=node:node /app/db/zipcodes.db /app/db/zipcodes.db

# Default DB location. Overridable at runtime with -e DB_PATH=... (e.g. to point
# at a mounted volume that overrides the baked copy).
ENV DB_PATH=/app/db/zipcodes.db

USER node
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.PORT||3000)+'/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

CMD ["node", "index.js"]
