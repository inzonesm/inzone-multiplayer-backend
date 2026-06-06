/* Deploy orchestrator. Given a zip + metadata, this:
 *   1. extracts the zip into a temp dir
 *   2. validates Dockerfile presence
 *   3. ensures the dev's html_games doc exists and is owned by them
 *   4. creates the Fly app if it doesn't exist yet
 *   5. writes a fly.toml if the dev didn't ship one
 *   6. shells out to `flyctl deploy --remote-only`, streaming logs
 *   7. stamps the resulting wss:// URL onto the public game doc
 * Each phase patches the deployment doc's status so the upload UI can show
 * live progress without polling our backend. */

import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  appendDeploymentLog,
  createDeployment,
  loadGameOwnedBy,
  setDeploymentStatus,
  setGameFlyApp,
  setGameServerUrl,
} from './deployments.js';
import { extractZip } from './extract.js';
import {
  appExists,
  createApp,
  deployApp,
  normalizeFlyTomlAppName,
  parseExposedPort,
  publicWss,
  readFlyEnv,
  writeDefaultFlyToml,
} from './fly.js';
import { randomBytes } from 'node:crypto';

const APP_PREFIX = 'inz-';        // every InZone-managed Fly app is namespaced
const DEFAULT_PORT = 8080;        // dev's Dockerfile must EXPOSE this (documented)

export interface DeployArgs {
  zipBuffer: Buffer;
  gameSlug: string;
  uploaderId: string;
}

export interface DeployResult {
  deploymentId: string;
  flyApp: string;
  serverUrl: string;
}

/** Generate a Fly-acceptable app name. Slugs come from the upload pipeline
 *  and are already kebab-case; we prefix with `inz-` so InZone-managed apps
 *  are visually distinct in the Fly dashboard. A 4-char suffix is appended
 *  on first deploy so re-uploads of an existing game keep deploying to the
 *  same app rather than colliding. */
function flyAppNameFor(slug: string, existingApp?: string): string {
  if (existingApp) return existingApp;
  const suffix = randomBytes(2).toString('hex');
  return `${APP_PREFIX}${slug}-${suffix}`;
}

export async function runDeploy(args: DeployArgs): Promise<DeployResult> {
  const flyEnv = readFlyEnv();
  const deploymentId = randomBytes(8).toString('hex');

  // Step 1: confirm the dev owns the game doc, derive Fly app name.
  const gameDoc = await loadGameOwnedBy(args.gameSlug, args.uploaderId);
  const existingApp: string | undefined = (gameDoc.flyApp as string) || undefined;
  const flyApp = flyAppNameFor(args.gameSlug, existingApp);

  await createDeployment({
    id: deploymentId,
    gameSlug: args.gameSlug,
    uploaderId: args.uploaderId,
    flyApp,
  });

  // Bind this game to its Fly app on the game doc *before* the build runs, so a
  // deploy that fails or times out mid-build is retried onto the same app
  // rather than spawning a new (orphaned, billed) one. Idempotent: when an
  // existing app is being reused this just rewrites the same value.
  await setGameFlyApp(args.gameSlug, flyApp);

  const workDir = mkdtempSync(join(tmpdir(), `inzone-deploy-${deploymentId}-`));

  try {
    // Step 2: extract.
    await setDeploymentStatus(deploymentId, { status: 'extracting' });
    const { files, totalBytes } = await extractZip(args.zipBuffer, workDir);
    await appendDeploymentLog(
      deploymentId,
      `Extracted ${files.length} files (${totalBytes} bytes uncompressed)`,
    );

    // Step 3: validate.
    await setDeploymentStatus(deploymentId, { status: 'validating' });
    if (!existsSync(join(workDir, 'Dockerfile'))) {
      throw new Error(
        'NO_DOCKERFILE: server bundle must include a Dockerfile at the root.',
      );
    }
    if (!existsSync(join(workDir, 'fly.toml'))) {
      // Route to the port the image actually listens on (from the Dockerfile's
      // EXPOSE), falling back to DEFAULT_PORT. A wrong internal_port means Fly
      // proxies to a dead port and the game's WebSocket never connects.
      const exposed = parseExposedPort(join(workDir, 'Dockerfile'));
      const internalPort = exposed ?? DEFAULT_PORT;
      writeDefaultFlyToml({
        cwd: workDir,
        appName: flyApp,
        region: flyEnv.defaultRegion,
        internalPort,
      });
      await appendDeploymentLog(
        deploymentId,
        `Generated fly.toml (internal_port=${internalPort}${exposed ? ' from Dockerfile EXPOSE' : ' (default)'}, region=${flyEnv.defaultRegion})`,
      );
    } else {
      // We deploy with `--app ${flyApp}`, which overrides the file's app name.
      // Rewrite the shipped fly.toml's `app = …` to match so the file, the
      // deploy target, and the stamped serverUrl (publicWss(flyApp)) can never
      // diverge.
      normalizeFlyTomlAppName(join(workDir, 'fly.toml'), flyApp);
      await appendDeploymentLog(
        deploymentId,
        `Using fly.toml shipped in the upload (app normalized to ${flyApp})`,
      );
    }

    // Step 4: ensure the Fly app exists.
    if (!(await appExists(flyApp))) {
      await appendDeploymentLog(deploymentId, `Creating Fly app ${flyApp} under org ${flyEnv.org}…`);
      await createApp(flyApp, flyEnv.org);
    }

    // Step 5: build + release. flyctl handles the remote builder, image
    // push, and machine rollout; we just relay each log line so the dev
    // can watch progress in the upload UI.
    await setDeploymentStatus(deploymentId, { status: 'building' });
    await deployApp({
      cwd: workDir,
      appName: flyApp,
      onLine: (_stream, line) => {
        // Fire-and-forget — failed log writes shouldn't break a deploy.
        appendDeploymentLog(deploymentId, line).catch(() => undefined);
      },
    });

    // Step 6: stamp the URL onto the public game doc.
    await setDeploymentStatus(deploymentId, { status: 'releasing' });
    const serverUrl = publicWss(flyApp);
    await setGameServerUrl(args.gameSlug, serverUrl);

    // flyApp was already bound to the game doc before the build (see above), so
    // re-deploys reuse it — nothing more to persist here.
    await setDeploymentStatus(deploymentId, { status: 'live', serverUrl });
    await appendDeploymentLog(deploymentId, `✓ Live at ${serverUrl}`);

    return { deploymentId, flyApp, serverUrl };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await setDeploymentStatus(deploymentId, { status: 'failed', error: message });
    await appendDeploymentLog(deploymentId, `✗ ${message}`);
    throw err;
  } finally {
    try { rmSync(workDir, { recursive: true, force: true }); } catch { /* nothing to clean */ }
  }
}
