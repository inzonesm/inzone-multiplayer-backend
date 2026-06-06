# InZone Studio backend

The deploy service that lets the upload portal push game servers onto
InZone's Fly.io org on the dev's behalf — no devs need a Fly account or
flyctl install.

```
┌──────────────────┐    POST /deploy        ┌──────────────────────┐
│ inzone-games     │ ─────────────────────► │ inzone-studio        │
│ /upload page     │  serverZip + slug      │ backend (Fastify +   │
│ (browser)        │  + Firebase ID token   │ flyctl in container) │
└──────────────────┘                        └──────────┬───────────┘
                                                       │
                                            ┌──────────▼───────────┐
                                            │ Fly.io org (InZone)  │
                                            │ apps:                │
                                            │   inz-snake-a3f1     │
                                            │   inz-tetris-9c00    │
                                            └──────────────────────┘
```

Status + log lines flow back through Firestore so the upload page can
subscribe directly (no long-polling, no SSE plumbing).

## Architecture

| Layer | What it does |
|---|---|
| `src/auth.ts` | Verifies `Authorization: Bearer <Firebase ID token>` |
| `src/firebase.ts` | firebase-admin init from `FIREBASE_SERVICE_ACCOUNT` env var |
| `src/deployments.ts` | Reads/writes `server_deployments/<id>` + appends to `logs` subcollection |
| `src/extract.ts` | Streaming yauzl zip extraction with zip-slip guards and 500 MB cap |
| `src/fly.ts` | `flyctl` subprocess wrapper (deploy / apps create / apps show) |
| `src/deploy.ts` | Orchestrator — ties extract + validation + fly together |
| `src/index.ts` | Fastify entrypoint — `POST /deploy`, `GET /deploy/:id`, `GET /healthz` |

The deploy uses `flyctl deploy --remote-only`, so the backend container
doesn't need a Docker daemon — Fly's remote builder handles the build.

## What the dev's server zip must contain

At minimum:
- `Dockerfile` at the **root** of the zip
- Server source files referenced by the Dockerfile

The Dockerfile must `EXPOSE` port **8080** (the backend generates a `fly.toml`
with `internal_port = 8080` if the dev doesn't ship one). Devs who need
finer control over their fly.toml (custom regions, multiple processes,
healthchecks, larger VMs) can include their own `fly.toml` next to the
Dockerfile.

A minimal example a dev could ship:

```dockerfile
FROM node:20-bookworm-slim
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY server ./server
EXPOSE 8080
USER node
CMD ["node", "server/main.js"]
```

## Required env vars

Set as secrets on whatever runtime hosts the backend (Cloud Run, Fly, etc.):

| Var | Purpose |
|---|---|
| `FIREBASE_SERVICE_ACCOUNT` | Single-line JSON service-account credentials — used to verify dev ID tokens + write Firestore deployment docs |
| `FLY_API_TOKEN` | Org-scoped Fly API token — generated with `fly tokens create org <slug> -x 8760h` |
| `FLY_ORG` | Fly org slug (e.g. `inzone-games`) — every deployed app lives here |
| `FLY_REGION` *(optional)* | Default Fly region for new apps. Defaults to `iad` |
| `CORS_ORIGINS` *(optional)* | Comma-separated list. Defaults to `http://localhost:3000` for dev |
| `LOG_LEVEL` *(optional)* | `info` / `debug` / `error`. Defaults to `info` |
| `PORT` *(optional)* | Listen port. Defaults to `8080` |

## Local dev

```bash
cd /Users/yxydw/Documents/inzone-studio-backend
npm install

# Set up your env (DON'T commit this)
cat > .env <<'EOF'
FIREBASE_SERVICE_ACCOUNT={"type":"service_account",…}
FLY_API_TOKEN=fly_...
FLY_ORG=inzone-games
CORS_ORIGINS=http://localhost:3000
EOF

# Run with auto-reload (requires flyctl available locally too)
npm run dev
# → InZone Studio backend listening on :8080
```

Point your local inzone-games at it:

```bash
# inzone-games/.env.local
NEXT_PUBLIC_STUDIO_API_BASE=http://localhost:8080
```

## Production deploy — Cloud Run (recommended)

```bash
# 1. Build + push the image to Artifact Registry / GCR
gcloud builds submit --tag gcr.io/$PROJECT_ID/inzone-studio-backend

# 2. Create the secrets
echo -n '{"type":"service_account",…}' | gcloud secrets create firebase-sa --data-file=-
echo -n 'fly_...'                       | gcloud secrets create fly-token   --data-file=-

# 3. Deploy
gcloud run deploy inzone-studio-backend \
  --image gcr.io/$PROJECT_ID/inzone-studio-backend \
  --region us-central1 \
  --platform managed \
  --memory 1Gi \
  --cpu 1 \
  --timeout 900 \
  --concurrency 4 \
  --max-instances 5 \
  --allow-unauthenticated \
  --set-env-vars FLY_ORG=inzone-games,CORS_ORIGINS=https://app.inzone.gg \
  --set-secrets FIREBASE_SERVICE_ACCOUNT=firebase-sa:latest,FLY_API_TOKEN=fly-token:latest
```

The `--timeout 900` (15 min) is important — flyctl builds can take a few
minutes for first-time deploys, and a default-timeout Cloud Run kills the
request before the deploy finishes.

Then set `NEXT_PUBLIC_STUDIO_API_BASE` to the printed Cloud Run URL in
`inzone-games/.env.production`.

## Production deploy — Fly.io

The backend can also host *itself* on Fly. Pick this if you'd rather have
one vendor for both the backend and the game servers.

```bash
fly launch --copy-config --name inzone-studio-backend --no-deploy --org inzone-games
fly secrets set --app inzone-studio-backend \
  FIREBASE_SERVICE_ACCOUNT="$(cat firebase-sa.json | tr -d '\n')" \
  FLY_API_TOKEN=fly_... \
  FLY_ORG=inzone-games \
  CORS_ORIGINS=https://app.inzone.gg
fly deploy --app inzone-studio-backend
```

You'll need a `fly.toml` here too — same shape as the BrowserQuest one
(`internal_port = 8080`, `force_https = true`).

## Required Firestore rules

The frontend reads `server_deployments/<id>` and its `logs` subcollection
directly. Add these rules to your Firestore security rules:

```
match /server_deployments/{deploymentId} {
  // Devs can read their own deployment docs; backend writes via admin SDK.
  allow read: if request.auth != null
              && resource.data.uploaderId == request.auth.uid;
  allow write: if false;

  match /logs/{logId} {
    allow read: if request.auth != null
                && get(/databases/$(database)/documents/server_deployments/$(deploymentId))
                    .data.uploaderId == request.auth.uid;
    allow write: if false;
  }
}
```

## What's not done yet

- **IAP API surface.** The deploy pipeline injects no env vars into the dev's
  server yet. Phase 2 will add `INZONE_GAME_ID`, `INZONE_API_BASE`, and a
  per-game `INZONE_API_KEY` so game servers can call your IAP endpoints.
- **Multiple regions / scaling.** Every app gets one machine in `FLY_REGION`.
  Multi-region failover, autoscaling per game, and capacity hints from the
  upload form are future work.
- **Cleanup of failed builds.** Failed deploys leave the Fly app in place
  for the next retry. A cron that prunes apps with zero successful deploys
  + the source dev removing the game would be a nice addition.
- **Abuse prevention.** Rate-limiting per-uploader, max apps per dev, and
  bundle-content scanning all need to land before this is opened to
  untrusted devs.
