// ============================================================
// KOI Recall — Consumer Auth Routes (Phase 2)
// Public consumer account lifecycle: register / login / logout / me / avatar
// Self-contained: uses the drizzle client + scrypt password + HMAC lookup hash.
// All endpoints live under /v1/consumer-auth.
// ============================================================

import { createHash, randomBytes } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import type { OpenAPIHono } from '@hono/zod-openapi';
import type { Context } from 'hono';
import type { AppEnv } from '../middleware/request-context.js';
import { createDatabase, type DatabaseHandle } from '../db/client.js';
import {
  campaignLocalizations,
  campaignProducts,
  caseConsumers,
  caseEvents,
  caseResolutions,
  claimedProducts,
  consumerSessions,
  consumerUsers,
  recallCases,
  recallCampaigns,
} from '../db/schema/index.js';
import { hashPassword, verifyPassword } from '../modules/staff/password.js';
import { NodeSensitiveDataCrypto } from '../platform/crypto/node-sensitive-data-crypto.js';
import { problemType } from '../shared/errors.js';

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

type ConsumerUserRow = typeof consumerUsers.$inferSelect;

type ConsumerClaimStatus =
  | 'submitted'
  | 'under_review'
  | 'verified'
  | 'remedy_issued'
  | 'resolved'
  | 'rejected';

interface ConsumerClaimSummary {
  id: string;
  claimNumber: string;
  caseRef: string;
  campaignId: string;
  campaignTitle: string;
  campaignSlug: string;
  consumerName: string;
  consumerEmail: string;
  consumerPhone: string;
  productName: string;
  shape?: string;
  flavor?: string;
  lotCode?: string;
  dateCode?: string;
  remedyId: string;
  remedyTitle: string;
  remedyType: string;
  refundAmount?: number;
  status: ConsumerClaimStatus;
  evidenceCount: number;
  submittedAt: string;
  updatedAt: string;
  resolutionDate?: string;
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
  if (!session) throw new Error('Consumer session could not be created.');
  return { token, sessionId: session.id, expiresAt: expiresAt.toISOString() };
}

async function resolveBearer(authHeader: string | undefined): Promise<ConsumerUserRow | null> {
  if (!authHeader?.startsWith('Bearer ')) return null;
  const token = authHeader.slice('Bearer '.length).trim();
  if (!token) return null;
  const tokenHash = sha256hex(token);
  const handle = db();
  const [row] = await handle.db
    .select({ user: consumerUsers, session: consumerSessions })
    .from(consumerSessions)
    .innerJoin(consumerUsers, eq(consumerSessions.userId, consumerUsers.id))
    .where(and(eq(consumerSessions.tokenHash, tokenHash), eq(consumerSessions.status, 'active')));
  if (!row || row.session.expiresAt.getTime() < Date.now() || row.user.status !== 'active') return null;
  void handle.db
    .update(consumerSessions)
    .set({ lastUsedAt: new Date() })
    .where(eq(consumerSessions.id, row.session.id));
  return row.user;
}

function problem(
  context: Context<AppEnv>,
  status: 400 | 401 | 403 | 404 | 409 | 500 | 503,
  title: string,
  detail: string,
) {
  return context.json(
    {
      type: problemType('consumer-auth'),
      title,
      status,
      detail,
      requestId: context.get('requestId'),
    },
    status,
    { 'Content-Type': 'application/problem+json' },
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function readString(body: Record<string, unknown>, key: string): string | undefined {
  const value = body[key];
  return typeof value === 'string' ? value : undefined;
}

function readNullableString(body: Record<string, unknown>, key: string): string | null | undefined {
  const value = body[key];
  if (value === null) return null;
  return typeof value === 'string' ? value : undefined;
}

function normalizeClaimStatus(
  caseStatus: typeof recallCases.$inferSelect.status,
  resolutionStatus: typeof caseResolutions.$inferSelect.status | null,
): ConsumerClaimStatus {
  if (caseStatus === 'rejected' || caseStatus === 'duplicate' || caseStatus === 'withdrawn') return 'rejected';
  if (caseStatus === 'closed') return 'resolved';
  if (resolutionStatus === 'externally_completed') return 'resolved';
  if (resolutionStatus === 'approved' || caseStatus === 'approved' || caseStatus === 'closure_review') return 'remedy_issued';
  if (caseStatus === 'triage' || caseStatus === 'under_review') return 'under_review';
  if (caseStatus === 'need_info') return 'verified';
  return 'submitted';
}

async function buildConsumerClaim(caseId: string): Promise<ConsumerClaimSummary | null> {
  const handle = db();
  const crypto = cryptoPort();
  const [joined] = await handle.db
    .select({
      caseId: recallCases.id,
      claimNumber: recallCases.publicReference,
      campaignId: recallCases.campaignId,
      campaignSlug: recallCampaigns.slug,
      submittedAt: recallCases.submittedAt,
      updatedAt: recallCases.updatedAt,
      caseStatus: recallCases.status,
      consumerFirstNameEncrypted: caseConsumers.firstNameEncrypted,
      consumerLastNameEncrypted: caseConsumers.lastNameEncrypted,
      consumerEmailEncrypted: caseConsumers.emailEncrypted,
      consumerPhoneEncrypted: caseConsumers.phoneEncrypted,
      consumerKeyVersion: caseConsumers.keyVersion,
      productName: campaignProducts.name,
      shape: claimedProducts.shape,
      flavor: claimedProducts.flavor,
      lotCode: claimedProducts.lotCode,
      dateCode: claimedProducts.dateCode,
      resolutionRequestedType: caseResolutions.requestedType,
      resolutionApprovedType: caseResolutions.approvedType,
      resolutionStatus: caseResolutions.status,
      refundAmountMinor: caseResolutions.refundAmountMinor,
      currency: caseResolutions.currency,
      resolutionCompletedAt: caseResolutions.completedAt,
      campaignTitle: campaignLocalizations.title,
    })
    .from(recallCases)
    .innerJoin(recallCampaigns, eq(recallCampaigns.id, recallCases.campaignId))
    .innerJoin(caseConsumers, eq(caseConsumers.caseId, recallCases.id))
    .leftJoin(claimedProducts, eq(claimedProducts.caseId, recallCases.id))
    .leftJoin(campaignProducts, eq(campaignProducts.id, claimedProducts.campaignProductId))
    .leftJoin(caseResolutions, eq(caseResolutions.caseId, recallCases.id))
    .leftJoin(
      campaignLocalizations,
      and(
        eq(campaignLocalizations.campaignVersionId, recallCases.campaignVersionId),
        eq(campaignLocalizations.locale, recallCases.locale),
      ),
    )
    .where(eq(recallCases.id, caseId))
    .limit(1);
  if (!joined) return null;

  const [firstName, lastName, consumerEmail, consumerPhone, eventRows] = await Promise.all([
    crypto.decrypt({ value: joined.consumerFirstNameEncrypted, keyVersion: joined.consumerKeyVersion }),
    crypto.decrypt({ value: joined.consumerLastNameEncrypted, keyVersion: joined.consumerKeyVersion }),
    crypto.decrypt({ value: joined.consumerEmailEncrypted, keyVersion: joined.consumerKeyVersion }),
    joined.consumerPhoneEncrypted
      ? crypto.decrypt({ value: joined.consumerPhoneEncrypted, keyVersion: joined.consumerKeyVersion })
      : Promise.resolve(''),
    handle.db.select({ eventType: caseEvents.eventType }).from(caseEvents).where(eq(caseEvents.caseId, caseId)),
  ]);

  const remedyType = joined.resolutionApprovedType ?? joined.resolutionRequestedType ?? 'replacement';
  const refundAmount =
    joined.currency === 'USD' && joined.refundAmountMinor !== null && joined.refundAmountMinor !== undefined
      ? joined.refundAmountMinor / 100
      : undefined;

  return {
    id: joined.caseId,
    claimNumber: joined.claimNumber,
    caseRef: joined.claimNumber,
    campaignId: joined.campaignId,
    campaignTitle: joined.campaignTitle ?? joined.campaignSlug,
    campaignSlug: joined.campaignSlug,
    consumerName: `${firstName} ${lastName}`.trim(),
    consumerEmail,
    consumerPhone,
    productName: joined.productName ?? 'Unknown Product',
    ...(joined.shape ? { shape: joined.shape } : {}),
    ...(joined.flavor ? { flavor: joined.flavor } : {}),
    ...(joined.lotCode ? { lotCode: joined.lotCode } : {}),
    ...(joined.dateCode ? { dateCode: joined.dateCode } : {}),
    remedyId: remedyType,
    remedyTitle: remedyType === 'refund' ? 'Refund' : 'Replacement',
    remedyType,
    ...(refundAmount !== undefined ? { refundAmount } : {}),
    status: normalizeClaimStatus(joined.caseStatus, joined.resolutionStatus ?? null),
    evidenceCount: eventRows.filter((eventRow) => eventRow.eventType === 'document.uploaded').length,
    submittedAt: joined.submittedAt.toISOString(),
    updatedAt: joined.updatedAt.toISOString(),
    ...(joined.resolutionCompletedAt ? { resolutionDate: joined.resolutionCompletedAt.toISOString() } : {}),
  };
}

export function registerConsumerAuthRoutes(app: OpenAPIHono<AppEnv>) {
  // ── POST /v1/consumer-auth/register ──
  app.post('/v1/consumer-auth/register', async (c) => {
    let body: Record<string, unknown>;
    try {
      const parsed = await c.req.json<unknown>();
      if (!isRecord(parsed)) return problem(c, 400, 'Invalid Request', 'Request body must be a JSON object.');
      body = parsed;
    } catch {
      return problem(c, 400, 'Invalid Request', 'Request body must be JSON.');
    }
    const email = (readString(body, 'email') ?? '').trim().toLowerCase();
    const password = readString(body, 'password') ?? '';
    const displayName = (readString(body, 'displayName') ?? '').trim();
    if (!isValidEmail(email)) return problem(c, 400, 'Invalid Email', 'A valid email is required.');
    if (password.length < 6) return problem(c, 400, 'Weak Password', 'Password must be at least 6 characters.');
    if (displayName.length < 1 || displayName.length > 160) return problem(c, 400, 'Invalid Name', 'Display name must be 1–160 characters.');

    try {
      const crypto = cryptoPort();
      const emailLookupHash = await crypto.lookupHash(email);
      const handle = db();
      const existing = await handle.db.select({ id: consumerUsers.id }).from(consumerUsers).where(eq(consumerUsers.emailLookupHash, emailLookupHash)).limit(1);
      if (existing.length > 0) {
        return problem(c, 409, 'Email Already Registered', 'An account with this email already exists.');
      }
      const passwordHash = await hashPassword(password, 6);
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
    let body: Record<string, unknown>;
    try {
      const parsed = await c.req.json<unknown>();
      if (!isRecord(parsed)) return problem(c, 400, 'Invalid Request', 'Request body must be a JSON object.');
      body = parsed;
    } catch {
      return problem(c, 400, 'Invalid Request', 'Request body must be JSON.');
    }
    const email = (readString(body, 'email') ?? '').trim().toLowerCase();
    const password = readString(body, 'password') ?? '';
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
    let body: Record<string, unknown>;
    try {
      const parsed = await c.req.json<unknown>();
      if (!isRecord(parsed)) return problem(c, 400, 'Invalid Request', 'Request body must be a JSON object.');
      body = parsed;
    } catch {
      return problem(c, 400, 'Invalid Request', 'Request body must be JSON.');
    }
    const patch: Partial<{ displayName: string; avatarDataUrl: string | null }> = {};
    const displayName = readString(body, 'displayName');
    if (displayName !== undefined) {
      const name = displayName.trim();
      if (name.length < 1 || name.length > 160) return problem(c, 400, 'Invalid Name', 'Display name must be 1-160 characters.');
      patch.displayName = name;
    }
    const avatarDataUrl = readNullableString(body, 'avatarDataUrl');
    if (avatarDataUrl !== undefined) {
      try {
        patch.avatarDataUrl = validateAvatar(avatarDataUrl);
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
      if (!updated) return problem(c, 404, 'Not Found', 'Consumer account was not found.');
      return c.json({ user: toPublic(updated) });
    } catch (err) {
      return problem(c, 500, 'Update Error', err instanceof Error ? err.message : 'Profile update failed.');
    }
  });

  app.get('/v1/consumer-auth/claims', async (c) => {
    const user = await resolveBearer(c.req.header('Authorization'));
    if (!user) return problem(c, 401, 'Unauthorized', 'A valid session token is required.');

    try {
      const crypto = cryptoPort();
      const emailLookupHash = await crypto.lookupHash(user.email.trim().toLowerCase());
      const rows = await db().db
        .select({ caseId: caseConsumers.caseId })
        .from(caseConsumers)
        .where(eq(caseConsumers.emailLookupHash, emailLookupHash));
      const claims = (
        await Promise.all(rows.map((row) => buildConsumerClaim(row.caseId)))
      ).filter((claim): claim is ConsumerClaimSummary => claim !== null);
      claims.sort((left, right) => right.submittedAt.localeCompare(left.submittedAt));
      return c.json({ claims });
    } catch (err) {
      return problem(c, 500, 'Claims Error', err instanceof Error ? err.message : 'Could not load claims.');
    }
  });

  app.get('/v1/consumer-auth/claims/:claimNumber', async (c) => {
    const user = await resolveBearer(c.req.header('Authorization'));
    if (!user) return problem(c, 401, 'Unauthorized', 'A valid session token is required.');

    try {
      const claimNumber = c.req.param('claimNumber').trim().toUpperCase();
      const [row] = await db().db
        .select({ caseId: recallCases.id })
        .from(recallCases)
        .where(eq(recallCases.publicReference, claimNumber))
        .limit(1);
      if (!row) return problem(c, 404, 'Not Found', 'Claim was not found.');
      const claim = await buildConsumerClaim(row.caseId);
      if (!claim || claim.consumerEmail.toLowerCase() !== user.email.toLowerCase()) {
        return problem(c, 404, 'Not Found', 'Claim was not found.');
      }
      return c.json({ claim });
    } catch (err) {
      return problem(c, 500, 'Claim Detail Error', err instanceof Error ? err.message : 'Could not load claim.');
    }
  });

  app.get('/v1/consumer-auth/lookup/:claimNumber', async (c) => {
    const claimNumber = c.req.param('claimNumber').trim().toUpperCase();
    const phone = (c.req.query('phone') ?? '').trim();
    if (!phone) return problem(c, 400, 'Invalid Request', 'phone is required.');

    try {
      const [row] = await db().db
        .select({ caseId: recallCases.id })
        .from(recallCases)
        .where(eq(recallCases.publicReference, claimNumber))
        .limit(1);
      if (!row) return problem(c, 404, 'Not Found', 'Claim was not found.');
      const claim = await buildConsumerClaim(row.caseId);
      if (!claim || claim.consumerPhone.trim() !== phone) {
        return problem(c, 404, 'Not Found', 'Claim was not found.');
      }
      return c.json({
        claim,
        campaignTitle: claim.campaignTitle,
        productName: claim.productName,
        remedyTitle: claim.remedyTitle,
        remedyType: claim.remedyType,
        refundAmount: claim.refundAmount,
      });
    } catch (err) {
      return problem(c, 500, 'Lookup Error', err instanceof Error ? err.message : 'Could not look up claim.');
    }
  });
}
