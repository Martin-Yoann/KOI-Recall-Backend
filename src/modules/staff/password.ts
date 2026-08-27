import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

/**
 * Password hashing for staff accounts (ADR-0004 §2.1).
 *
 * Uses `node:crypto.scrypt` — a memory-hard KDF built into Node, zero external
 * dependencies, OWASP-recognized. This deliberately avoids argon2id, which
 * would be the repo's first native-module dependency (ADR-0004 §6-H).
 *
 * The encoded envelope is self-describing (`scrypt.<N>.<r>.<p>.<saltB64>.<digestB64>`)
 * so future parameter changes stay backward-compatible: verify reads N/r/p from
 * the envelope and a rehash can be triggered when stored params drift from
 * current defaults.
 */

const scrypt = promisify(scryptCallback) as (
  password: string | Buffer,
  salt: Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

/** OWASP-recommended scrypt cost (N=2^17), block size r=8, parallelization p=1. */
const SCRYPT_N = 1 << 17;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
/** Derived key length in bytes (32 → 256-bit). */
const KEY_LENGTH = 32;
/** Salt length in bytes (16 → 128-bit). */
const SALT_LENGTH = 16;
/**
 * maxmem in bytes. scrypt with N=2^17, r=8 needs ~ N * r * 128 bytes ≈ 134 MB
 * for the working area; Node's default maxmem (32 MB) is too low, so raise it
 * with a safety margin.
 */
const MAXMEM = 256 * 1024 * 1024;

export const SCRYPT_PARAMS = { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P } as const;

/**
 * Hashes a password, returning a self-describing envelope:
 * `scrypt.<N>.<r>.<p>.<base64url(salt)>.<base64url(digest)>`.
 */
export async function hashPassword(password: string, minimumLength = 12): Promise<string> {
  validatePasswordShape(password, minimumLength);
  const salt = randomBytes(SALT_LENGTH);
  const derived = await scrypt(password, salt, KEY_LENGTH, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: MAXMEM,
  });
  return `scrypt.${SCRYPT_N}.${SCRYPT_R}.${SCRYPT_P}.${salt.toString('base64url')}.${derived.toString('base64url')}`;
}

/**
 * Verifies a password against an envelope produced by {@link hashPassword}.
 * Constant-time over the derived digest (timingSafeEqual). Throws if the
 * envelope is malformed (never returns partial success).
 */
export async function verifyPassword(password: string, envelope: string): Promise<boolean> {
  const parsed = parseEnvelope(envelope);
  if (parsed === null) throw new Error('Malformed password envelope.');
  const { N, r, p, salt, digest } = parsed;
  const candidate = await scrypt(password, salt, digest.length, { N, r, p, maxmem: MAXMEM });
  return timingSafeEqual(candidate, digest);
}

/**
 * Returns true when the envelope's parameters differ from current defaults,
 * signaling the caller should rehash on next successful login.
 */
export function needsRehash(envelope: string): boolean {
  const parsed = parseEnvelope(envelope);
  if (parsed === null) return true;
  return parsed.N !== SCRYPT_N || parsed.r !== SCRYPT_R || parsed.p !== SCRYPT_P;
}

/** Rejects empty or implausibly long passwords before the KDF runs. */
function validatePasswordShape(password: string, minimumLength: number): void {
  if (typeof password !== 'string') throw new Error('Password must be a string.');
  if (!Number.isInteger(minimumLength) || minimumLength < 1 || minimumLength > 1024) {
    throw new Error('Password minimum length must be between 1 and 1024 characters.');
  }
  if (password.length === 0) throw new Error('Password must not be empty.');
  if (password.length < minimumLength) {
    throw new Error(`Password must contain at least ${minimumLength} characters.`);
  }
  if (password.length > 1024) throw new Error('Password must not exceed 1024 characters.');
}

interface ParsedEnvelope {
  N: number;
  r: number;
  p: number;
  salt: Buffer;
  digest: Buffer;
}

function parseEnvelope(envelope: string): ParsedEnvelope | null {
  const parts = envelope.split('.');
  if (parts.length !== 6) return null;
  if (parts[0] !== 'scrypt') return null;
  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  const saltB64 = parts[4];
  const digestB64 = parts[5];
  if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p)) return null;
  if (N <= 0 || r <= 0 || p <= 0) return null;
  if (!saltB64 || !digestB64) return null;
  let salt: Buffer;
  let digest: Buffer;
  try {
    salt = Buffer.from(saltB64, 'base64url');
    digest = Buffer.from(digestB64, 'base64url');
  } catch {
    return null;
  }
  if (salt.length === 0 || digest.length === 0) return null;
  return { N, r, p, salt, digest };
}
