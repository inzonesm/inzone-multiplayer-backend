/* Deployment status records — written to Firestore so the upload page can
 * subscribe and show live "Building → Pushing → Live" progress without the
 * backend having to hold a long-lived connection open.
 *
 * Two collections are used:
 *   server_deployments/<deploymentId>   one doc per deploy attempt; logs live
 *                                       in a `logs` subcollection so they
 *                                       can grow without bloating the parent.
 *   html_games/<slug>                   serverUrl + serverStatus get patched
 *                                       on success so the hub reads cleanly.
 */

import { FieldValue, getDb } from './firebase.js';

export type DeployStatus =
  | 'queued'      // request accepted, work not yet started
  | 'extracting'  // unzipping the upload + writing it to a temp dir
  | 'validating'  // Dockerfile present, size limits, etc.
  | 'building'    // flyctl remote-build is compiling the image
  | 'releasing'   // image built, Fly is rolling out machines
  | 'live'        // deployed; serverUrl populated
  | 'failed';     // see error field

export interface DeploymentDoc {
  id: string;
  gameSlug: string;
  uploaderId: string;
  flyApp: string;
  status: DeployStatus;
  serverUrl?: string;
  error?: string;
  createdAt: FirebaseFirestore.FieldValue;
  updatedAt: FirebaseFirestore.FieldValue;
}

export async function createDeployment(args: {
  id: string;
  gameSlug: string;
  uploaderId: string;
  flyApp: string;
}): Promise<void> {
  const db = getDb();
  await db.collection('server_deployments').doc(args.id).set({
    id: args.id,
    gameSlug: args.gameSlug,
    uploaderId: args.uploaderId,
    flyApp: args.flyApp,
    status: 'queued' as DeployStatus,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  });
}

export async function setDeploymentStatus(
  id: string,
  patch: { status: DeployStatus; serverUrl?: string; error?: string },
): Promise<void> {
  const db = getDb();
  await db
    .collection('server_deployments')
    .doc(id)
    .set({ ...patch, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
}

/** Appends one log line to server_deployments/<id>/logs. The doc ID is the
 *  timestamp so reads come back in order; a write-only cap of ~100 lines is
 *  enforced opportunistically (Firestore has no native cap). */
export async function appendDeploymentLog(id: string, line: string): Promise<void> {
  const db = getDb();
  const trimmed = line.length > 1024 ? line.slice(0, 1024) + '…' : line;
  await db
    .collection('server_deployments')
    .doc(id)
    .collection('logs')
    .add({ at: FieldValue.serverTimestamp(), line: trimmed });
}

/** Once Fly returns a hostname, stamp it onto the public game doc so the
 *  hub iframe can pass it through as `?serverUrl=…`. */
export async function setGameServerUrl(slug: string, url: string): Promise<void> {
  const db = getDb();
  await db
    .collection('html_games')
    .doc(slug)
    .set(
      {
        serverUrl: url,
        serverStatus: 'live',
        serverUpdatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
}

/** Record which Fly app backs this game as soon as the name is chosen — i.e.
 *  *before* the failure-prone build step. If a deploy dies mid-build or times
 *  out, the next attempt reads this back (via loadGameOwnedBy → flyApp) and
 *  redeploys to the SAME app instead of minting a new random suffix, which
 *  would leave the half-created app orphaned and billed. */
export async function setGameFlyApp(slug: string, flyApp: string): Promise<void> {
  const db = getDb();
  await db.collection('html_games').doc(slug).set({ flyApp }, { merge: true });
}

/** Every Fly app this uploader's deploy history ever bound to a slug. Drawn
 *  from server_deployments (which outlives the game doc), so destroy-on-delete
 *  still finds the server when the doc is already gone, plus any stray apps
 *  left behind by failed or duplicate deploys. */
export async function findFlyAppsForSlug(slug: string, uploaderId: string): Promise<string[]> {
  const db = getDb();
  const snap = await db
    .collection('server_deployments')
    .where('gameSlug', '==', slug)
    .where('uploaderId', '==', uploaderId)
    .get();
  const apps = new Set<string>();
  for (const d of snap.docs) {
    const app = d.data().flyApp;
    if (typeof app === 'string' && app) apps.add(app);
  }
  return [...apps];
}

/** Strip the server bindings off a game doc after its Fly app is destroyed,
 *  so the hub stops advertising a wss:// URL that no longer resolves. A
 *  missing doc is fine — the caller may be tearing down post-deletion. */
export async function clearGameServer(slug: string): Promise<void> {
  const db = getDb();
  try {
    await db.collection('html_games').doc(slug).update({
      serverUrl: FieldValue.delete(),
      flyApp: FieldValue.delete(),
      serverStatus: FieldValue.delete(),
      serverUpdatedAt: FieldValue.delete(),
    });
  } catch {
    /* doc already deleted — nothing to clear */
  }
}

/** Confirms the dev who's deploying actually owns the game they're targeting.
 *  Returns the game doc or throws. */
export async function loadGameOwnedBy(
  slug: string,
  uploaderId: string,
): Promise<FirebaseFirestore.DocumentData> {
  const db = getDb();
  const snap = await db.collection('html_games').doc(slug).get();
  if (!snap.exists) {
    throw new Error(`Game ${slug} not found — upload the client first.`);
  }
  const data = snap.data()!;
  if (data.uploaderId !== uploaderId) {
    throw new Error(`You don't own game ${slug}.`);
  }
  return data;
}
