/* Firebase Admin initialization — verifies dev ID tokens + writes status to
 * Firestore. Credentials come from FIREBASE_SERVICE_ACCOUNT (a single-line
 * JSON string set as a secret on Cloud Run / Fly). */

import { cert, getApps, initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { FieldValue, getFirestore } from 'firebase-admin/firestore';

function readServiceAccount() {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) {
    throw new Error(
      'FIREBASE_SERVICE_ACCOUNT is not set. Paste a service-account JSON ' +
        '(single line) into the runtime as a secret.',
    );
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `FIREBASE_SERVICE_ACCOUNT did not parse as JSON: ${(err as Error).message}`,
    );
  }
}

function ensureApp() {
  if (getApps().length === 0) {
    initializeApp({ credential: cert(readServiceAccount()) });
  }
}

export function getAdminAuth() {
  ensureApp();
  return getAuth();
}

export function getDb() {
  ensureApp();
  return getFirestore();
}

export { FieldValue };
