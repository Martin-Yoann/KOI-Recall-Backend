import { createHash } from 'node:crypto';

/**
 * Session-token helpers for staff sessions (ADR-0004 §2.1). Mirrors the
 * claim-draft capability-token pattern: the plaintext token is returned once
 * at issue and never stored; only its SHA-256 digest is persisted, so sessions
 * are revocable and not replayable from a DB read.
 */

/** Random bytes backing a session token. 48 bytes (384 bits). */
const SESSION_TOKEN_RANDOM_BYTES = 48;

/** Default hard ceiling on a session's lifetime, in milliseconds (7 days). */
export const DEFAULT_SESSION_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;

/** Generates a fresh opaque bearer token, base64url-encoded. */
export function generateSessionToken(): string {
  const bytes = new Uint8Array(SESSION_TOKEN_RANDOM_BYTES);
  crypto.getRandomValues(bytes);
  return Buffer.from(bytes).toString('base64url');
}

/** Derives the SHA-256 digest stored in `staff_sessions.token_hash`. */
export function hashSessionToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Normalizes an email for lookup-hash input: trim + lowercase. */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}
