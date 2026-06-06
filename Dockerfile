# InZone Studio backend — receives game-server zips and deploys them to
# the InZone Fly.io org via the bundled `flyctl` binary.

# ──────────────── build stage ────────────────
FROM node:20-bookworm-slim AS build
WORKDIR /app

# Install only what's needed to compile TS.
COPY package.json package-lock.json* ./
RUN npm install

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ──────────────── runtime stage ────────────────
FROM node:20-bookworm-slim AS runtime
WORKDIR /app

# Install flyctl. The official install script writes to /root/.fly/bin; symlink
# into /usr/local/bin so it's on PATH for any user. Pinned to a recent stable
# version so production behaviour is reproducible across rebuilds.
RUN apt-get update \
 && apt-get install -y --no-install-recommends curl ca-certificates \
 && curl -L https://fly.io/install.sh | FLYCTL_INSTALL=/usr/local sh \
 && rm -rf /var/lib/apt/lists/* \
 && /usr/local/bin/flyctl version

# Prod-only deps.
COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY --from=build /app/dist ./dist

# Required env vars (passed via Cloud Run / Fly secrets, never baked):
#   FIREBASE_SERVICE_ACCOUNT  — JSON service-account credentials (single line)
#   FLY_API_TOKEN             — org-scoped Fly.io API token
#   FLY_ORG                   — Fly org slug (e.g. "inzone-games")
# Optional:
#   PORT                      — defaults to 8080 (Cloud Run convention)
#   FLY_REGION                — default region for new apps ("iad" if unset)
ENV PORT=8080
EXPOSE 8080

USER node
CMD ["node", "dist/index.js"]
