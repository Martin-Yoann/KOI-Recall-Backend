import { createHash } from 'node:crypto';

/**
 * Pure, database-free helpers for the one-time {@link claim_drafts.token_hash}
 * secret. The plaintext token is returned to the consumer exactly once and is
 * never persisted; only its SHA-256 digest is stored, mirroring the way
 * idempotency and lookup hashes are treated elsewhere in the schema. Random
 * bytes come from the global WebCrypto `crypto` (the same surface already used
 * for request ids); hashing uses Node's `createHash` since WebCrypto has no
 * synchronous digest helper.
 */

/** Number of random bytes backing a draft token. 32 bytes (256 bits). */
const DRAFT_TOKEN_RANDOM_BYTES = 32;

/**
 * Generates a fresh, unguessable draft token. The 32 random bytes are base64url
 * encoded so the value is URL-safe and at least 43 characters long, satisfying
 * the contract's `z.string().min(32)` constraint with margin.
 */
export function generateDraftToken(): string {
  const bytes = new Uint8Array(DRAFT_TOKEN_RANDOM_BYTES);
  crypto.getRandomValues(bytes);
  return Buffer.from(bytes).toString('base64url');
}

/**
 * Derives the deterministic digest stored in `claim_drafts.token_hash`. SHA-256
 * yields a 64-character lowercase hex string, well within the column's
 * `varchar(128)` and unique index.
 */
export function hashDraftToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
