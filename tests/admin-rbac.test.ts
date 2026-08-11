/* eslint-disable @typescript-eslint/require-await -- test fakes return resolved values synchronously */
import { describe, expect, it } from 'vitest';

import { createApp } from '../src/app.js';
import { createPlaceholderRegistry, type ApplicationRegistry } from '../src/composition.js';
import { loadConfig } from '../src/config/env.js';
import type { AdminService } from '../src/modules/admin/service.js';
import type { AuditEvent, AuditQuery, AuditService } from '../src/modules/staff/audit-service.js';
import type { StaffService, StaffUser } from '../src/modules/staff/service.js';
import type { SensitiveDataCryptoPort } from '../src/platform/crypto/port.js';

/**
 * ADR-0004 B-end RBAC: covers the staff-session path, role-based permission
 * gating, masked vs raw PII tiering, the denied-audit row, and M2 dual-mode
 * (legacy ADMIN_API_KEY still accepted on the migrated routes). Uses in-memory
 * fakes — no DB. The crypto fake HMACs deterministically so tokens resolve.
 */

const ADMIN_KEY = 'admin-secret';

// --- deterministic crypto fake (no real AEAD; HMAC-like for email/token) ---

const cryptoFake: SensitiveDataCryptoPort = {
  encrypt(plaintext: string) {
    return Promise.resolve({ keyVersion: 'v1', value: `enc:${plaintext}` });
  },
  decrypt(ciphertext) {
    const v = ciphertext.value;
    return Promise.resolve(v.startsWith('enc:') ? v.slice(4) : v);
  },
  lookupHash(value: string) {
    return Promise.resolve(`h:${value}`);
  },
};

// --- staff service fake: lets the test pre-seed a user and its session ---

function makeStaffFake(): StaffService & {
  users: Map<string, StaffUser>;
  /** Map of token (plaintext) -> userId, simulating a session row. */
  sessions: Map<string, { userId: string; role: StaffUser['role']; sessionId: string }>;
} {
  const users = new Map<string, StaffUser>();
  const sessions = new Map<
    string,
    {
      userId: string;
      role: StaffUser['role'];
      sessionId: string;
      email: string;
      displayName: string;
    }
  >();
  return {
    users,
    sessions,
    async login(email) {
      const user = [...users.values()].find((u) => u.email === email);
      if (!user) return null;
      const token = `tok-${user.id}`;
      sessions.set(token, {
        userId: user.id,
        role: user.role,
        sessionId: `sess-${user.id}`,
        email: user.email,
        displayName: user.displayName,
      });
      return { token, sessionId: `sess-${user.id}`, expiresAt: '2099-01-01T00:00:00.000Z' };
    },
    async resolveSession(token) {
      const s = sessions.get(token);
      if (!s) return null;
      return {
        userId: s.userId,
        sessionId: s.sessionId,
        role: s.role,
        displayName: s.displayName,
        email: s.email,
        expiresAt: '2099-01-01T00:00:00.000Z',
      };
    },
    async touchSession() {},
    async revokeSession(sessionId) {
      for (const [tok, s] of sessions) if (s.sessionId === sessionId) sessions.delete(tok);
    },
    async revokeAllSessions() {},
    async refreshSession(sessionId) {
      for (const [, s] of sessions)
        if (s.sessionId === sessionId)
          return { token: `tok-${s.userId}`, sessionId, expiresAt: '2099-01-01T00:00:00.000Z' };
      return null;
    },
    async listStaff() {
      return [...users.values()];
    },
    async createStaffUser(input) {
      const user: StaffUser = {
        id: `u-${users.size + 1}`,
        email: input.email,
        displayName: input.displayName,
        role: input.role,
        status: 'active',
        lastLoginAt: null,
      };
      users.set(user.id, user);
      return user;
    },
    async updateStaffUser(userId, input) {
      const u = users.get(userId);
      if (!u) throw new Error('not found');
      const updated = { ...u, ...input };
      users.set(userId, updated);
      return updated;
    },
    async getStaffUserByEmail(email) {
      return [...users.values()].find((u) => u.email === email) ?? null;
    },
  };
}

function makeAuditFake(): AuditService & { events: AuditEvent[] } {
  const events: AuditEvent[] = [];
  return {
    events,
    async record(input) {
      events.push({
        id: `e-${events.length + 1}`,
        actorUserId: input.actorUserId,
        actorRole: input.actorRole,
        action: input.action,
        resourceType: input.resourceType,
        resourceId: input.resourceId,
        outcome: input.outcome,
        reasonCode: input.reasonCode,
        metadata: input.metadata ?? {},
        occurredAt: new Date().toISOString(),
      });
    },
    async query(query: AuditQuery) {
      return events.filter(
        (e) =>
          (!query.action || e.action === query.action) &&
          (!query.resourceId || e.resourceId === query.resourceId) &&
          (!query.actorUserId || e.actorUserId === query.actorUserId),
      );
    },
  };
}

function makeAdminFake(): AdminService & { detailTierByRef: Map<string, 'masked' | 'raw'> } {
  const detailTierByRef = new Map<string, 'masked' | 'raw'>();
  return {
    detailTierByRef,
    async listCases() {
      return [];
    },
    async exportCases() {
      return [];
    },
    async closeReportabilityReview() {},
    async getCaseDetail({ caseReference, viewerRole }) {
      const tier = viewerRole === 'compliance' || viewerRole === 'administrator' ? 'raw' : 'masked';
      detailTierByRef.set(caseReference, tier);
      return {
        caseReference,
        status: 'submitted',
        subtype: 'standard',
        incidentFlag: false,
        submittedAt: '2026-08-10T00:00:00.000Z',
        assignedToStaffUserId: null,
        assignedAt: null,
        consumer: {
          piiTier: tier,
          firstName: tier === 'raw' ? 'Jane' : 'J•',
          lastName: tier === 'raw' ? 'Doe' : 'D•',
          email: tier === 'raw' ? 'jane@example.com' : 'j•••@e•••••.com',
        },
      };
    },
    async assignCase() {},
    async transitionCaseStatus() {},
  };
}

function appWith(opts: {
  staff?: StaffService;
  audit?: AuditService;
  admin?: AdminService;
  crypto?: SensitiveDataCryptoPort;
}) {
  const base = createPlaceholderRegistry();
  const registry: ApplicationRegistry = {
    services: {
      ...base.services,
      ...(opts.admin ? { admin: opts.admin } : {}),
      ...(opts.staff ? { staff: opts.staff } : {}),
      ...(opts.audit ? { audit: opts.audit } : {}),
    },
    platform: { ...base.platform, crypto: opts.crypto ?? cryptoFake },
  };
  return createApp({
    config: loadConfig({
      CORS_ALLOWED_ORIGINS: 'https://consumer.example.com',
      ADMIN_API_KEY: ADMIN_KEY,
    }),
    registry,
  });
}

describe('B-end RBAC (ADR-0004)', () => {
  it('rejects a request with no auth on /admin/* with 401', async () => {
    const app = appWith({ admin: makeAdminFake(), staff: makeStaffFake() });
    const res = await app.request('/admin/cases');
    expect(res.status).toBe(401);
  });

  it('accepts the legacy ADMIN_API_KEY as a full administrator (M2 dual-mode)', async () => {
    const admin = makeAdminFake();
    const app = appWith({ admin, staff: makeStaffFake() });
    const res = await app.request('/admin/cases', {
      headers: { Authorization: `Bearer ${ADMIN_KEY}` },
    });
    expect(res.status).toBe(200);
  });

  it('resolves a staff session token and enforces role permissions', async () => {
    const staff = makeStaffFake();
    const admin = makeAdminFake();
    const audit = makeAuditFake();
    // Seed a viewer and a compliance user.
    const viewer = await staff.createStaffUser({
      email: 'v@x.com',
      displayName: 'Viewer',
      role: 'viewer',
      password: 'password1234',
    });
    await staff.createStaffUser({
      email: 'c@x.com',
      displayName: 'Compliance',
      role: 'compliance',
      password: 'password1234',
    });
    const viewerToken = (await staff.login('v@x.com', 'password1234'))!.token;
    const complianceToken = (await staff.login('c@x.com', 'password1234'))!.token;

    const app = appWith({ admin, staff, audit });

    // Viewer can read the case queue.
    const queue = await app.request('/admin/cases', {
      headers: { Authorization: `Bearer ${viewerToken}` },
    });
    expect(queue.status).toBe(200);

    // Viewer CANNOT export (requires case.export).
    const exportRes = await app.request('/admin/cases/export', {
      headers: { Authorization: `Bearer ${viewerToken}` },
    });
    expect(exportRes.status).toBe(403);

    // Compliance CAN export.
    const exportOk = await app.request('/admin/cases/export', {
      headers: { Authorization: `Bearer ${complianceToken}` },
    });
    expect(exportOk.status).toBe(200);

    // The denied export attempt produced an audit row.
    const denied = audit.events.find((e) => e.action === 'case.export' && e.outcome === 'denied');
    expect(denied).toBeTruthy();
    expect(denied?.actorUserId).toBe(viewer.id);
  });

  it('returns masked PII for a reviewer and raw PII for compliance, with raw-view audit', async () => {
    const staff = makeStaffFake();
    const admin = makeAdminFake();
    const audit = makeAuditFake();
    await staff.createStaffUser({
      email: 'r@x.com',
      displayName: 'Reviewer',
      role: 'reviewer',
      password: 'password1234',
    });
    await staff.createStaffUser({
      email: 'c2@x.com',
      displayName: 'Compliance2',
      role: 'compliance',
      password: 'password1234',
    });
    const reviewerToken = (await staff.login('r@x.com', 'password1234'))!.token;
    const complianceToken = (await staff.login('c2@x.com', 'password1234'))!.token;

    const app = appWith({ admin, staff, audit });
    const ref = 'KOI-7N4Q-A91M2X6P';

    // Reviewer sees masked PII; no raw-view audit row.
    const revRes = await app.request(`/admin/cases/${ref}`, {
      headers: { Authorization: `Bearer ${reviewerToken}` },
    });
    expect(revRes.status).toBe(200);
    const revBody = (await revRes.json()) as {
      case: { consumer: { firstName: string; piiTier: string } };
    };
    expect(revBody.case.consumer.piiTier).toBe('masked');
    expect(revBody.case.consumer.firstName).toBe('J•');
    expect(audit.events.filter((e) => e.action === 'pii.view_raw')).toHaveLength(0);

    // Compliance sees raw PII; a pii.view_raw audit row is written.
    const compRes = await app.request(`/admin/cases/${ref}`, {
      headers: { Authorization: `Bearer ${complianceToken}` },
    });
    expect(compRes.status).toBe(200);
    const compBody = (await compRes.json()) as {
      case: { consumer: { firstName: string; piiTier: string } };
    };
    expect(compBody.case.consumer.piiTier).toBe('raw');
    expect(compBody.case.consumer.firstName).toBe('Jane');
    expect(audit.events.filter((e) => e.action === 'pii.view_raw')).toHaveLength(1);
  });

  it('lets an administrator read audit events and manage staff', async () => {
    const staff = makeStaffFake();
    const audit = makeAuditFake();
    const admin = makeAdminFake();
    const adminUser = await staff.createStaffUser({
      email: 'a@x.com',
      displayName: 'Admin',
      role: 'administrator',
      password: 'password1234',
    });
    const adminToken = (await staff.login('a@x.com', 'password1234'))!.token;
    const app = appWith({ admin, staff, audit });

    // Administrator can list audit events.
    const auditRes = await app.request('/admin/audit-events', {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    expect(auditRes.status).toBe(200);

    // Administrator can create another staff user.
    const createRes = await app.request('/admin/staff', {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'new@x.com',
        displayName: 'New',
        role: 'viewer',
        password: 'password1234',
      }),
    });
    expect(createRes.status).toBe(201);
    const createBody = (await createRes.json()) as { staff: StaffUser };
    expect(createBody.staff.role).toBe('viewer');

    // The staff.create action is audited.
    const createAudit = audit.events.find((e) => e.action === 'staff.create');
    expect(createAudit).toBeTruthy();
    expect(createAudit?.actorUserId).toBe(adminUser.id);
  });
});
