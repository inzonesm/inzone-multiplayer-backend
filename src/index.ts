/* InZone Studio backend — HTTP entrypoint.
 *
 * Endpoints:
 *   POST   /deploy          multipart upload of a server bundle (zip + slug)
 *   GET    /deploy/:id      snapshot of a deployment doc (the upload UI
 *                           usually subscribes to Firestore directly for
 *                           live updates, but this is handy for retries
 *                           and curl-based testing)
 *   DELETE /server/:slug    destroy the Fly app(s) backing a game — called
 *                           by the website before it deletes the game doc
 *   GET    /healthz         liveness probe
 *
 * Fastify was chosen over Express for first-class multipart streaming + a
 * cleaner async error model. */

import Fastify from 'fastify';
import multipart from '@fastify/multipart';
import { AuthError, verifyBearerToken } from './auth.js';
import { runDeploy } from './deploy.js';
import { clearGameServer, findFlyAppsForSlug } from './deployments.js';
import { getDb } from './firebase.js';
import { destroyApp } from './fly.js';

const PORT = Number(process.env.PORT ?? 8080);
const MAX_UPLOAD_BYTES = 500 * 1024 * 1024; // mirror the extract.ts cap

const app = Fastify({
  logger: { level: process.env.LOG_LEVEL ?? 'info' },
  bodyLimit: MAX_UPLOAD_BYTES,
});

await app.register(multipart, {
  limits: {
    fileSize: MAX_UPLOAD_BYTES,
    files: 1,
    fields: 8,
  },
});

// CORS: respond to preflight + emit headers on every response. The studio
// frontend lives on a different origin from the backend, so this is required.
// Allow-list is env-driven; default permits the common dev origins.
const ALLOW_ORIGINS = (process.env.CORS_ORIGINS ?? 'http://localhost:3000')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

app.addHook('onSend', async (req, reply, payload) => {
  const origin = req.headers.origin ?? '';
  if (ALLOW_ORIGINS.includes('*') || ALLOW_ORIGINS.includes(origin)) {
    reply.header('Access-Control-Allow-Origin', origin || '*');
    reply.header('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    reply.header('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    reply.header('Vary', 'Origin');
  }
  return payload;
});

app.options('/*', async (_req, reply) => {
  reply.code(204).send();
});

app.get('/healthz', async () => ({ ok: true }));

/** POST /deploy — multipart with fields:
 *   serverZip  (file, required)  the dev's server bundle (Dockerfile + src)
 *   gameSlug   (text, required)  matches html_games/<slug>
 *
 * Auth: Authorization: Bearer <Firebase ID token>. The token's UID must
 * match html_games/<slug>.uploaderId or the deploy is rejected.
 */
app.post('/deploy', async (req, reply) => {
  let user;
  try {
    user = await verifyBearerToken(req.headers.authorization);
  } catch (err) {
    if (err instanceof AuthError) return reply.code(err.status).send({ error: err.message });
    throw err;
  }

  let zipBuffer: Buffer | null = null;
  let gameSlug: string | null = null;

  // Fastify-multipart streams each part. We buffer the single zip part into
  // memory; for >500MB uploads this would need to spill to disk, but our cap
  // is already at 500MB so memory is fine.
  for await (const part of req.parts()) {
    if (part.type === 'file' && part.fieldname === 'serverZip') {
      const chunks: Buffer[] = [];
      for await (const chunk of part.file) chunks.push(chunk as Buffer);
      zipBuffer = Buffer.concat(chunks);
    } else if (part.type === 'field' && part.fieldname === 'gameSlug') {
      gameSlug = String(part.value ?? '').trim();
    }
  }

  if (!zipBuffer) return reply.code(400).send({ error: 'serverZip is required' });
  if (!gameSlug) return reply.code(400).send({ error: 'gameSlug is required' });
  if (!/^[a-z0-9-]+$/.test(gameSlug)) {
    return reply.code(400).send({ error: 'gameSlug must be lowercase kebab-case' });
  }

  try {
    const result = await runDeploy({
      zipBuffer,
      gameSlug,
      uploaderId: user.uid,
    });
    return reply.send(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Deploy failed';
    req.log.error({ err }, 'deploy failed');
    return reply.code(500).send({ error: message });
  }
});

/** DELETE /server/:slug — tear down the Fly app(s) backing a game. The
 *  website calls this before deleting a game doc so removing a game never
 *  leaves a billed server running.
 *
 *  Ownership: the caller must own the game doc — or, when the doc is already
 *  gone, own the deployment records that created the app(s). Candidates come
 *  from both the doc's flyApp binding and the full deploy history, so stray
 *  apps from failed/duplicate deploys get swept too. Idempotent: a game with
 *  no server resolves to { destroyed: [] }. */
const SELF_APP = process.env.FLY_APP_NAME ?? 'inzone-studio-backend';

app.delete<{ Params: { slug: string } }>('/server/:slug', async (req, reply) => {
  let user;
  try {
    user = await verifyBearerToken(req.headers.authorization);
  } catch (err) {
    if (err instanceof AuthError) return reply.code(err.status).send({ error: err.message });
    throw err;
  }
  const slug = req.params.slug;
  if (!/^[a-z0-9-]+$/.test(slug)) {
    return reply.code(400).send({ error: 'slug must be lowercase kebab-case' });
  }

  const candidates = new Set<string>();
  const gameSnap = await getDb().collection('html_games').doc(slug).get();
  if (gameSnap.exists) {
    const data = gameSnap.data()!;
    if (data.uploaderId !== user.uid) {
      return reply.code(403).send({ error: `You don't own game ${slug}.` });
    }
    if (typeof data.flyApp === 'string' && data.flyApp) candidates.add(data.flyApp);
    const m =
      typeof data.serverUrl === 'string'
        ? data.serverUrl.match(/^wss?:\/\/([a-z0-9-]+)\.fly\.dev\/?$/)
        : null;
    if (m) candidates.add(m[1]);
  }
  for (const appName of await findFlyAppsForSlug(slug, user.uid)) candidates.add(appName);

  const destroyed: string[] = [];
  const failed: { app: string; error: string }[] = [];
  for (const appName of candidates) {
    // Hard guard: only InZone-managed game apps, never this control plane.
    if (!appName.startsWith('inz-') || appName === SELF_APP) continue;
    try {
      await destroyApp(appName);
      destroyed.push(appName);
      req.log.info({ appName, slug, uid: user.uid }, 'destroyed game server app');
    } catch (err) {
      failed.push({ app: appName, error: err instanceof Error ? err.message : String(err) });
      req.log.error({ err, appName, slug }, 'failed to destroy game server app');
    }
  }

  if (gameSnap.exists && destroyed.length > 0) {
    await clearGameServer(slug).catch(() => undefined);
  }
  if (failed.length > 0) {
    return reply
      .code(502)
      .send({ error: `Failed to destroy: ${failed.map((f) => f.app).join(', ')}`, destroyed, failed });
  }
  return reply.send({ destroyed });
});

/** GET /deploy/:id — snapshot of a deployment doc. The frontend usually
 *  subscribes to Firestore directly (so it gets live updates without us
 *  staying in the loop), but this is handy for curl-based debugging. */
app.get<{ Params: { id: string } }>('/deploy/:id', async (req, reply) => {
  let user;
  try {
    user = await verifyBearerToken(req.headers.authorization);
  } catch (err) {
    if (err instanceof AuthError) return reply.code(err.status).send({ error: err.message });
    throw err;
  }
  const snap = await getDb().collection('server_deployments').doc(req.params.id).get();
  if (!snap.exists) return reply.code(404).send({ error: 'Not found' });
  const data = snap.data()!;
  if (data.uploaderId !== user.uid) return reply.code(403).send({ error: 'Forbidden' });
  return reply.send(data);
});

try {
  await app.listen({ host: '0.0.0.0', port: PORT });
  app.log.info(`InZone Studio backend listening on :${PORT}`);
} catch (err) {
  app.log.error({ err }, 'Failed to bind port');
  process.exit(1);
}
