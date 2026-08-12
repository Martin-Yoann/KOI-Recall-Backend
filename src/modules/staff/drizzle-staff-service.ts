import { and, desc, eq, gt } from 'drizzle-orm';

import type { DatabaseExecutor } from '../../db/client.js';
import { staffSessions, staffUsers } from '../../db/schema/index.js';
import type { SensitiveDataCryptoPort } from '../../platform/crypto/port.js';
import { ClaimConflictError, ResourceNotFoundError } from '../../shared/errors.js';
import { hashPassword, verifyPassword } from './password.js';
import {
  DEFAULT_SESSION_LIFETIME_MS,
  generateSessionToken,
  hashSessionToken,
  normalizeEmail,
} from './sessions.js';
import type {
  CreateStaffUserInput,
  ResolvedSession,
  SessionIssueResult,
  StaffService,
  StaffUser,
  UpdateStaffUserInput,
} from './service.js';

const toStaffUser = (row: typeof staffUsers.$inferSelect): StaffUser => ({
  id: row.id,
  email: row.email,
  displayName: row.displayName,
  role: row.role,
  status: row.status,
  lastLoginAt: row.lastLoginAt ? row.lastLoginAt.toISOString() : null,
  avatarDataUrl: row.avatarDataUrl ?? null,
});

export const MAX_FAILED_LOGIN_ATTEMPTS = 5;
export const ACCOUNT_LOCK_DURATION_MS = 15 * 60 * 1000;

/**
 * Drizzle-backed staff + session service. Session plaintext tokens are minted
 * here and returned once; only their SHA-256 digest is persisted, mirroring
 * the claim-draft capability-token pattern (ADR-0004 §2.1).
 */
export class DrizzleStaffService implements StaffService {
  constructor(
    private readonly db: DatabaseExecutor,
    private readonly crypto: SensitiveDataCryptoPort,
  ) {}

  async login(
    email: string,
    password: string,
    issuedContext?: { ipHash?: string; userAgentHash?: string },
  ): Promise<SessionIssueResult | null> {
    const lookupHash = await this.crypto.lookupHash(normalizeEmail(email));
    const [user] = await this.db
      .select()
      .from(staffUsers)
      .where(eq(staffUsers.emailLookupHash, lookupHash))
      .limit(1);
    // No such user, disabled, or no password set (future SSO-only): reject uniformly.
    if (!user || user.status !== 'active' || !user.passwordHash) return null;
    const now = new Date();
    if (user.lockedUntil && user.lockedUntil.getTime() > now.getTime()) return null;

    const ok = await verifyPassword(password, user.passwordHash);
    if (!ok) {
      const previousAttempts = user.lockedUntil ? 0 : user.failedLoginAttempts;
      const failedLoginAttempts = previousAttempts + 1;
      await this.db
        .update(staffUsers)
        .set({
          failedLoginAttempts,
          lockedUntil:
            failedLoginAttempts >= MAX_FAILED_LOGIN_ATTEMPTS
              ? new Date(now.getTime() + ACCOUNT_LOCK_DURATION_MS)
              : null,
        })
        .where(eq(staffUsers.id, user.id));
      return null;
    }

    const token = generateSessionToken();
    const expiresAt = new Date(now.getTime() + DEFAULT_SESSION_LIFETIME_MS);
    const returning = await this.db
      .insert(staffSessions)
      .values({
        userId: user.id,
        tokenHash: hashSessionToken(token),
        status: 'active',
        issuedAt: now,
        expiresAt,
        issuedIpHash: issuedContext?.ipHash ?? null,
        issuedUserAgentHash: issuedContext?.userAgentHash ?? null,
      })
      .returning({ id: staffSessions.id });
    const session = returning[0];
    await this.db
      .update(staffUsers)
      .set({ lastLoginAt: now, failedLoginAttempts: 0, lockedUntil: null })
      .where(eq(staffUsers.id, user.id));

    if (!session) return null;
    return { token, sessionId: session.id, expiresAt: expiresAt.toISOString() };
  }

  async resolveSession(token: string): Promise<ResolvedSession | null> {
    if (!token) return null;
    const tokenHash = hashSessionToken(token);
    const [row] = await this.db
      .select({
        sessionId: staffSessions.id,
        userId: staffUsers.id,
        role: staffUsers.role,
        displayName: staffUsers.displayName,
        email: staffUsers.email,
        expiresAt: staffSessions.expiresAt,
        sessionStatus: staffSessions.status,
        userStatus: staffUsers.status,
      })
      .from(staffSessions)
      .innerJoin(staffUsers, eq(staffSessions.userId, staffUsers.id))
      .where(eq(staffSessions.tokenHash, tokenHash))
      .limit(1);
    if (!row) return null;
    if (row.sessionStatus !== 'active' || row.userStatus !== 'active') return null;
    if (row.expiresAt.getTime() <= Date.now()) return null;
    return {
      userId: row.userId,
      sessionId: row.sessionId,
      role: row.role,
      displayName: row.displayName,
      email: row.email,
      expiresAt: row.expiresAt.toISOString(),
    };
  }

  async touchSession(sessionId: string): Promise<void> {
    await this.db
      .update(staffSessions)
      .set({ lastUsedAt: new Date() })
      .where(
        and(
          eq(staffSessions.id, sessionId),
          eq(staffSessions.status, 'active'),
          gt(staffSessions.expiresAt, new Date()),
        ),
      );
  }

  async revokeSession(sessionId: string): Promise<void> {
    await this.db
      .update(staffSessions)
      .set({ status: 'revoked', revokedAt: new Date() })
      .where(eq(staffSessions.id, sessionId));
  }

  async revokeAllSessions(userId: string): Promise<void> {
    await this.db
      .update(staffSessions)
      .set({ status: 'revoked', revokedAt: new Date() })
      .where(and(eq(staffSessions.userId, userId), eq(staffSessions.status, 'active')));
  }

  async refreshSession(sessionId: string): Promise<SessionIssueResult | null> {
    const [existing] = await this.db
      .select()
      .from(staffSessions)
      .where(eq(staffSessions.id, sessionId))
      .limit(1);
    if (!existing || existing.status !== 'active') return null;
    if (existing.expiresAt.getTime() <= Date.now()) return null;

    // Rotate the token without extending the immutable hard expiry ceiling.
    const token = generateSessionToken();
    const now = new Date();
    const expiresAt = existing.expiresAt;
    await this.db
      .update(staffSessions)
      .set({ tokenHash: hashSessionToken(token), expiresAt, lastUsedAt: now })
      .where(eq(staffSessions.id, sessionId));
    return { token, sessionId, expiresAt: expiresAt.toISOString() };
  }

  async listStaff(): Promise<StaffUser[]> {
    const rows = await this.db.select().from(staffUsers).orderBy(desc(staffUsers.createdAt));
    return rows.map(toStaffUser);
  }

  async createStaffUser(input: CreateStaffUserInput): Promise<StaffUser> {
    const lookupHash = await this.crypto.lookupHash(normalizeEmail(input.email));
    const passwordHash = await hashPassword(input.password);
    const [existing] = await this.db
      .select({ id: staffUsers.id })
      .from(staffUsers)
      .where(eq(staffUsers.emailLookupHash, lookupHash))
      .limit(1);
    if (existing) throw new ClaimConflictError('A staff user with that email already exists.');

    const inserted = await this.db
      .insert(staffUsers)
      .values({
        email: normalizeEmail(input.email),
        emailLookupHash: lookupHash,
        displayName: input.displayName,
        role: input.role,
        status: 'active',
        passwordHash,
        passwordChangedAt: new Date(),
      })
      .returning();
    const row = inserted[0];
    if (!row) throw new Error('Staff user insert returned no row.');
    return toStaffUser(row);
  }

  async updateStaffUser(userId: string, input: UpdateStaffUserInput): Promise<StaffUser> {
    const setData: Record<string, unknown> = {};
    if (input.role !== undefined) setData.role = input.role;
    if (input.status !== undefined) setData.status = input.status;
    if (input.displayName !== undefined) setData.displayName = input.displayName;
    if (input.avatarDataUrl !== undefined) setData.avatarDataUrl = input.avatarDataUrl;

    const updated = await this.db
      .update(staffUsers)
      .set(setData as never)
      .where(eq(staffUsers.id, userId))
      .returning();
    const row = updated[0];
    if (!row) throw new ResourceNotFoundError('Staff user was not found.');

    // Role change or disable invalidates existing sessions (ADR-0004 §2.1).
    if (input.role !== undefined || input.status === 'disabled') {
      await this.revokeAllSessions(userId);
    }
    return toStaffUser(row);
  }

  async getStaffUserByEmail(email: string): Promise<StaffUser | null> {
    const lookupHash = await this.crypto.lookupHash(normalizeEmail(email));
    const [row] = await this.db
      .select()
      .from(staffUsers)
      .where(eq(staffUsers.emailLookupHash, lookupHash))
      .limit(1);
    return row ? toStaffUser(row) : null;
  }
}
