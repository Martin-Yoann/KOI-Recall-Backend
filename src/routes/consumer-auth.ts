// ============================================================
// KOI Recall — Consumer Auth Routes (Phase 2)
// Public consumer account lifecycle: register / login / logout / me / avatar
// Self-contained: uses the drizzle client + scrypt password + HMAC lookup hash.
// All endpoints live under /v1/consumer-auth.
// ============================================================

import { createHash, randomBytes } from 'node:crypto';
import { eq, and } from 'drizzle-orm';
import type { OpenAPIHono } from '@hono/zod-openapi';
import type { AppEnv } from '../middleware/request-context.js';
import { createDatabase, type DatabaseHandle } from '../db/client.js';
import { consumerUsers, consumerSessions } from '../db/schema/consumers.js';
import { hashPassword, verifyPassword } from '../modules/staff/password.js';
import { NodeSensitiveDataCrypto } from '../platform/crypto/node-sensitive-data-crypto.js';

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const AVATAR_MAX_BYTES = 512 * 1024; // 512 KiB data-URL ceiling (matches staff)

let dbHandle: DatabaseHandle | null = null;
function db(): DatabaseHandle {
  if (!dbHandle) {
    if (!process.env.DATABASE_URL) {
      throw new Error('DATABASE_URL is not configured.');
    }
    dbHandle = createDatabase(process.env.DATABASE_URL);
  }
  return dbHandle;
}

function cryptoPort() {
  const enc = process.env.FIELD_ENCRYPTION_KEY;
  const pepper = process.env.HASH_PEPPER;
  if (!enc || !pepper) {
    throw new Error('FIELD_ENCRYPTION_KEY and HASH_PEPPER are required for consumer auth.');
  }
  return new NodeSensitiveDataCrypto(enc, pepper);
}

function sha256hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

function newToken(): string {
  return randomBytes(32).toString('base64url');
}

function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 254;
}

function validateAvatar(dataUrl: string | null): string | null {
  if (dataUrl === null || dataUrl === '') return null; // explicit clear
  // Accept data:image/(jpeg|png|webp);base64,<...>
  const match = /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
  if (!match) throw new Error('Avatar must be a data:image/(jpeg|png|webp);base64,... URL.');
  const payload = match[2]!;
  // base64 payload size ≈ bytes * 4/3
  if (payload.length * 0.75 > AVATAR_MAX_BYTES) {
    throw new Error(`Avatar exceeds the ${AVATAR_MAX_BYTES}-byte limit.`);
  }
  return dataUrl;
}

interface ConsumerPublic {
  consumerUserId: string;
  email: string;
  displayName: string;
  avatarDataUrl: string | null;
  createdAt: string;
}

function toPublic(row: typeof consumerUsers.$inferSelect): ConsumerPublic {
  return {
    consumerUserId: row.id,
    email: row.email,
    displayName: row.displayName,
    avatarDataUrl: row.avatarDataUrl ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

async function issueSession(userId: string): Promise<{ token: string; sessionId: string; expiresAt: string }> {
  const token = newToken();
  const tokenHash = sha256hex(token);
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  const handle = db();
  const [session] = await handle.db
    .insert(consumerSessions)
    .values({ userId, tokenHash, expiresAt })
    .returning({ id: consumerSessions.id });
  return { token, sessionId: session!.id, expiresAt: expiresAt.toISOString() };
}

/** Resolve a Bearer token to an active, non-expired consumer session + user. */
async function resolveBearer(authHeader: string | undefined): Promise<typeof consumerUsers.$inferSelect | null> {
  if (!authHeader?.startsWith('Bearer ')) return null;
  const token = authHeader.slice('Bearer '.length).trim();
  if (!token) return null;
  const tokenHash = sha256hex(token);
  const handle = db();
  const rows = await handle.db
    .select({ user: consumerUsers, session: consumerSessions })
    .from(consumerSessions)
    .innerJoin(consumerUsers, eq(consumerSessions.userId, consumerUsers.id))
    .where(and(eq(consumerSessions.tokenHash, tokenHash), eq(consumerSessions.status, 'active')));
  const row = rows[0];
  if (!row) return null;
  if (row.session.expiresAt.getTime() < Date.now()) return null;
  if (row.user.status !== 'active') return null;
  // Touch lastUsedAt (fire-and-forget)
  handle.db
    .update(consumerSessions)
    .set({ lastUsedAt: new Date() })
    .where(eq(consumerSessions.id, row.session.id))
    .execute()
    .catch(() => {});
  return row.user;
}

function problem(context: any, status: number, title: string, detail: string) {
  return context.json(
    {
      type: 'about:blank',
      title,
      status,
      detail,
      requestId: context.get('requestId'),
    },
    status,
    { 'Content-Type': 'application/problem+json' },
  );
}

export function registerConsumerAuthRoutes(app: OpenAPIHono<AppEnv>) {
  // ── POST /v1/consumer-auth/register ──
  app.post('/v1/consumer-auth/register', async (c) => {
    let body: { email?: string; password?: string; displayName?: string };
    try {
      body = await c.req.json();
    } catch {
      return problem(c, 400, 'Invalid Request', 'Request body must be JSON.');
    }
    const email = (body.email ?? '').trim().toLowerCase();
    const password = body.password ?? '';
    const displayName = (body.displayName ?? '').trim();
    if (!isValidEmail(email)) return problem(c, 400, 'Invalid Email', 'A valid email is required.');
    if (password.length < 12) return problem(c, 400, 'Weak Password', 'Password must be at least 12 characters.');
    if (displayName.length < 1 || displayName.length > 160) return problem(c, 400, 'Invalid Name', 'Display name must be 1–160 characters.');

    try {
      const crypto = cryptoPort();
      const emailLookupHash = await crypto.lookupHash(email);
      const handle = db();
      const existing = await handle.db.select({ id: consumerUsers.id }).from(consumerUsers).where(eq(consumerUsers.emailLookupHash, emailLookupHash)).limit(1);
      if (existing.length > 0) {
        return problem(c, 409, 'Email Already Registered', 'An account with this email already exists.');
      }
      const passwordHash = await hashPassword(password);
      const [user] = await handle.db
        .insert(consumerUsers)
        .values({ email, emailLookupHash, displayName, passwordHash, status: 'active' })
        .returning();
      const session = await issueSession(user!.id);
      return c.json({ ...session, user: toPublic(user!) }, 201);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Registration failed.';
      if (msg.includes('DATABASE_URL') || msg.includes('FIELD_ENCRYPTION_KEY')) {
        return problem(c, 503, 'Service Unavailable', msg);
      }
      return problem(c, 500, 'Registration Error', msg);
    }
  });

  // ── POST /v1/consumer-auth/login ──
  app.post('/v1/consumer-auth/login', async (c) => {
    let body: { email?: string; password?: string };
    try {
      body = await c.req.json();
    } catch {
      return problem(c, 400, 'Invalid Request', 'Request body must be JSON.');
    }
    const email = (body.email ?? '').trim().toLowerCase();
    const password = body.password ?? '';
    if (!email || !password) return problem(c, 400, 'Missing Credentials', 'Email and password are required.');

    try {
      const crypto = cryptoPort();
      const emailLookupHash = await crypto.lookupHash(email);
      const handle = db();
      const rows = await handle.db.select().from(consumerUsers).where(eq(consumerUsers.emailLookupHash, emailLookupHash)).limit(1);
      const user = rows[0];
      if (!user || !user.passwordHash) return problem(c, 401, 'Invalid Credentials', 'Email or password is incorrect.');
      if (user.status !== 'active') return problem(c, 403, 'Account Disabled', 'This account has been disabled.');
      const ok = await verifyPassword(password, user.passwordHash);
      if (!ok) return problem(c, 401, 'Invalid Credentials', 'Email or password is incorrect.');
      await handle.db.update(consumerUsers).set({ lastLoginAt: new Date(), failedLoginAttempts: 0 }).where(eq(consumerUsers.id, user.id));
      const session = await issueSession(user.id);
      return c.json({ ...session, user: toPublic(user) });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Login failed.';
      if (msg.includes('DATABASE_URL') || msg.includes('FIELD_ENCRYPTION_KEY')) {
        return problem(c, 503, 'Service Unavailable', msg);
      }
      return problem(c, 500, 'Login Error', msg);
    }
  });

  // ── POST /v1/consumer-auth/logout ──
  app.post('/v1/consumer-auth/logout', async (c) => {
    const user = await resolveBearer(c.req.header('Authorization'));
    if (!user) return problem(c, 401, 'Unauthorized', 'A valid session token is required.');
    try {
      const token = c.req.header('Authorization')!.slice('Bearer '.length).trim();
      const handle = db();
      await handle.db
        .update(consumerSessions)
        .set({ status: 'revoked', revokedAt: new Date() })
        .where(and(eq(consumerSessions.tokenHash, sha256hex(token)), eq(consumerSessions.status, 'active')));
      return c.json({ ok: true });
    } catch (err) {
      return problem(c, 500, 'Logout Error', err instanceof Error ? err.message : 'Logout failed.');
    }
  });

  // ── GET /v1/consumer-auth/me ──
  app.get('/v1/consumer-auth/me', async (c) => {
    const user = await resolveBearer(c.req.header('Authorization'));
    if (!user) return problem(c, 401, 'Unauthorized', 'A valid session token is required.');
    return c.json({ user: toPublic(user) });
  });

  // ── PATCH /v1/consumer-auth/me ──
  app.patch('/v1/consumer-auth/me', async (c) => {
    const user = await resolveBearer(c.req.header('Authorization'));
    if (!user) return problem(c, 401, 'Unauthorized', 'A valid session token is required.');
    let body: { displayName?: string; avatarDataUrl?: string | null };
    try {
      body = await c.req.json();
    } catch {
      return problem(c, 400, 'Invalid Request', 'Request body must be JSON.');
    }
    const patch: Partial<{ displayName: string; avatarDataUrl: string | null }> = {};
    if (body.displayName !== undefined) {
      const name = body.displayName.trim();
      if (name.length < 1 || name.length > 160) return problem(c, 400, 'Invalid Name', 'Display name must be 1–160 characters.');
      patch.displayName = name;
    }
    if (body.avatarDataUrl !== undefined) {
      try {
        patch.avatarDataUrl = validateAvatar(body.avatarDataUrl);
      } catch (err) {
        return problem(c, 400, 'Invalid Avatar', err instanceof Error ? err.message : 'Avatar rejected.');
      }
    }
    if (Object.keys(patch).length === 0) return problem(c, 400, 'Nothing to Update', 'Provide displayName or avatarDataUrl.');

    try {
      const handle = db();
      const [updated] = await handle.db
        .update(consumerUsers)
        .set({ ...patch, updatedAt: new Date() })
        .where(eq(consumerUsers.id, user.id))
        .returning();
      return c.json({ user: toPublic(updated!) });
    } catch (err) {
      return problem(c, 500, 'Update Error', err instanceof Error ? err.message : 'Profile update failed.');
    }
  });
}
