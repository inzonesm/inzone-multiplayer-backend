/* Verifies the `Authorization: Bearer <Firebase-ID-token>` header. Returns
 * the decoded token (which carries the dev's UID) or throws AuthError. */

import { getAdminAuth } from './firebase.js';

export class AuthError extends Error {
  constructor(message: string, public status = 401) {
    super(message);
    this.name = 'AuthError';
  }
}

export interface AuthedUser {
  uid: string;
  email: string | null;
}

export async function verifyBearerToken(authHeader: string | undefined): Promise<AuthedUser> {
  if (!authHeader) throw new AuthError('Missing Authorization header');
  const match = /^Bearer (.+)$/i.exec(authHeader);
  if (!match) throw new AuthError('Authorization header must be `Bearer <token>`');
  const token = match[1].trim();
  if (!token) throw new AuthError('Empty Bearer token');

  try {
    const decoded = await getAdminAuth().verifyIdToken(token);
    return { uid: decoded.uid, email: decoded.email ?? null };
  } catch (err) {
    throw new AuthError(
      `Invalid Firebase ID token: ${(err as Error).message}`,
      401,
    );
  }
}
