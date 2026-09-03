/* eslint-disable @typescript-eslint/require-await -- test fakes return resolved values synchronously */
import { describe, expect, it } from 'vitest';

import { createApp } from '../src/app.js';
import { createPlaceholderRegistry, type ApplicationRegistry } from '../src/composition.js';
import { loadConfig } from '../src/config/env.js';
import type { AdminService } from '../src/modules/admin/service.js';
import type { AuditEvent, AuditQuery, AuditService } from '../src/modules/staff/audit-service.js';
import type { StaffService, StaffUser } from '../src/modules/staff/service.js';
import type { SensitiveDataCryptoPort } from '../src/platform/crypto/port.js';
import { ClaimValidationError } from '../src/shared/errors.js';

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
    async changePassword({ currentPassword }) {
      if (currentPassword !== 'password1234')
        throw new ClaimValidationError('The current password is incorrect.');
      return Promise.resolve();
    },
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
        avatarDataUrl: null,
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
    async deleteStaffUser(userId, actorUserId) {
      if (userId === actorUserId) throw new Error('cannot delete yourself');
      if (!users.has(userId)) throw new Error('not found');
      users.delete(userId);
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
      const events2 = events.filter(
        (e) =>
          (!query.action || e.action === query.action) &&
          (!query.resourceId || e.resourceId === query.resourceId) &&
          (!query.actorUserId || e.actorUserId === query.actorUserId),
      );
      return { events: events2, total: events2.length, nextCursor: null };
    },
  };
}

function makeFailingAuditFake(): AuditService {
  return {
    record() {
      return Promise.reject(new Error('audit unavailable'));
    },
    query() {
      return Promise.resolve({ events: [], total: 0, nextCursor: null });
    },
  };
}

function makeAdminFake(): AdminService & { detailTierByRef: Map<string, 'masked' | 'raw'> } {
  const detailTierByRef = new Map<string, 'masked' | 'raw'>();
  return {
    detailTierByRef,
    async listCases() {
      return { cases: [], total: 0, nextCursor: null };
    },
    async listIncidents() {
      return { incidents: [], total: 0, nextCursor: null };
    },
    async getIncidentDetail() {
      return null;
    },
    async listCampaigns() {
      return [];
    },
    async exportCases() {
      return [];
    },
    async closeReportabilityReview() {},
    async getCaseDetail({ caseReference, viewerRole, piiLevel }) {
      const tier =
        piiLevel === 'raw' && (viewerRole === 'MANAGER' || viewerRole === 'ADMIN')
          ? 'raw'
          : 'masked';
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

function makeAdminTransactions(admin: AdminService, staff: StaffService, audit: AuditService) {
  return {
    run: <T>(
      work: (services: {
        admin: AdminService;
        staff: StaffService;
        audit: AuditService;
      }) => Promise<T>,
    ) => work({ admin, staff, audit }),
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
      ...(opts.admin && opts.staff && opts.audit
        ? {
            adminTransactions: makeAdminTransactions(opts.admin, opts.staff, opts.audit),
          }
        : {}),
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

  it('rejects the legacy ADMIN_API_KEY on net-new staff-management routes', async () => {
    const app = appWith({
      admin: makeAdminFake(),
      staff: makeStaffFake(),
      audit: makeAuditFake(),
    });
    const response = await app.request('/admin/staff', {
      headers: { Authorization: `Bearer ${ADMIN_KEY}` },
    });

    expect(response.status).toBe(401);
  });

  it('rejects the legacy ADMIN_API_KEY on net-new raw-PII routes', async () => {
    const app = appWith({
      admin: makeAdminFake(),
      staff: makeStaffFake(),
      audit: makeAuditFake(),
    });
    const response = await app.request('/admin/cases/KOI-7N4Q-A91M2X6P', {
      headers: { Authorization: `Bearer ${ADMIN_KEY}` },
    });

    expect(response.status).toBe(401);
  });

  it('resolves a staff session token and enforces role permissions', async () => {
    const staff = makeStaffFake();
    const admin = makeAdminFake();
    const audit = makeAuditFake();
    const manager = await staff.createStaffUser({
      email: 'manager@x.com',
      displayName: 'Manager',
      role: 'MANAGER',
      password: 'password1234',
    });
    const adminUser = await staff.createStaffUser({
      email: 'admin@x.com',
      displayName: 'Admin',
      role: 'ADMIN',
      password: 'password1234',
    });
    const managerToken = (await staff.login('manager@x.com', 'password1234'))!.token;
    const adminToken = (await staff.login('admin@x.com', 'password1234'))!.token;

    const app = appWith({ admin, staff, audit });

    const adminLogin = await app.request('/admin/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'admin@x.com', password: 'password1234' }),
    });
    expect(adminLogin.status).toBe(201);
    expect(await adminLogin.json()).toMatchObject({
      staffUserId: adminUser.id,
      displayName: 'Admin',
      role: 'ADMIN',
    });

    // MANAGER can read and manage business data.
    const queue = await app.request('/admin/cases', {
      headers: { Authorization: `Bearer ${managerToken}` },
    });
    expect(queue.status).toBe(200);
    const exportRes = await app.request('/admin/cases/export', {
      headers: { Authorization: `Bearer ${managerToken}` },
    });
    expect(exportRes.status).toBe(200);

    // MANAGER can view the staff directory, but cannot mutate staff accounts.
    const staffRes = await app.request('/admin/staff', {
      headers: { Authorization: `Bearer ${managerToken}` },
    });
    expect(staffRes.status).toBe(200);
    expect(((await staffRes.json()) as { staff: StaffUser[] }).staff).toHaveLength(2);

    const managerCreate = await app.request('/admin/staff', {
      method: 'POST',
      headers: { Authorization: `Bearer ${managerToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'blocked@x.com',
        displayName: 'Blocked',
        role: 'MANAGER',
        password: 'password1234',
      }),
    });
    expect(managerCreate.status).toBe(403);

    const managerUpdate = await app.request(`/admin/staff/${adminUser.id}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${managerToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ role: 'MANAGER' }),
    });
    expect(managerUpdate.status).toBe(403);

    const managerDelete = await app.request(`/admin/staff/${adminUser.id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${managerToken}` },
    });
    expect(managerDelete.status).toBe(403);

    const managerRevoke = await app.request(`/admin/sessions/by-user/${adminUser.id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${managerToken}` },
    });
    expect(managerRevoke.status).toBe(403);

    // ADMIN can read audit events and manage staff accounts.
    const auditRes = await app.request('/admin/audit-events', {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    expect(auditRes.status).toBe(200);
    const createRes = await app.request('/admin/staff', {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'new@x.com',
        displayName: 'New',
        role: 'MANAGER',
        password: 'password1234',
      }),
    });
    expect(createRes.status).toBe(201);
    expect(manager.id).not.toBe(adminUser.id);
  });

  it('audits logout in the same authenticated session flow', async () => {
    const staff = makeStaffFake();
    const audit = makeAuditFake();
    const user = await staff.createStaffUser({
      email: 'logout@example.com',
      displayName: 'Logout',
      role: 'MANAGER',
      password: 'password1234',
    });
    const token = (await staff.login('logout@example.com', 'password1234'))!.token;
    const app = appWith({ admin: makeAdminFake(), staff, audit });

    const response = await app.request('/admin/sessions', {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(response.status).toBe(204);
    expect(audit.events).toContainEqual(
      expect.objectContaining({
        actorUserId: user.id,
        action: 'session.revoke',
        outcome: 'success',
      }),
    );
  });

  it('audits session refresh', async () => {
    const staff = makeStaffFake();
    const audit = makeAuditFake();
    const user = await staff.createStaffUser({
      email: 'refresh@example.com',
      displayName: 'Refresh',
      role: 'MANAGER',
      password: 'password1234',
    });
    const token = (await staff.login('refresh@example.com', 'password1234'))!.token;
    const app = appWith({ admin: makeAdminFake(), staff, audit });

    const response = await app.request('/admin/sessions/refresh', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      staffUserId: user.id,
      displayName: 'Refresh',
      role: 'MANAGER',
    });
    expect(audit.events).toContainEqual(
      expect.objectContaining({
        actorUserId: user.id,
        action: 'session.refresh',
        outcome: 'success',
      }),
    );
  });

  it('returns raw PII for MANAGER and ADMIN only on an explicit raw request, with raw-view audits', async () => {
    const staff = makeStaffFake();
    const admin = makeAdminFake();
    const audit = makeAuditFake();
    await staff.createStaffUser({
      email: 'manager-pii@x.com',
      displayName: 'Manager',
      role: 'MANAGER',
      password: 'password1234',
    });
    await staff.createStaffUser({
      email: 'admin-pii@x.com',
      displayName: 'Admin',
      role: 'ADMIN',
      password: 'password1234',
    });
    const managerToken = (await staff.login('manager-pii@x.com', 'password1234'))!.token;
    const adminToken = (await staff.login('admin-pii@x.com', 'password1234'))!.token;

    const app = appWith({ admin, staff, audit });
    const ref = 'KOI-7N4Q-A91M2X6P';

    // Default and explicit masked reads stay masked for every role.
    for (const query of ['', '?pii=masked']) {
      const maskedResponse = await app.request(`/admin/cases/${ref}${query}`, {
        headers: { Authorization: `Bearer ${managerToken}` },
      });
      expect(maskedResponse.status).toBe(200);
      const maskedBody = (await maskedResponse.json()) as {
        case: { consumer: { piiTier: string; firstName: string } };
      };
      expect(maskedBody.case.consumer.piiTier).toBe('masked');
      expect(maskedBody.case.consumer.firstName).toBe('J•');
    }

    for (const token of [managerToken, adminToken]) {
      const response = await app.request(`/admin/cases/${ref}?pii=raw`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        case: { consumer: { firstName: string; piiTier: string } };
      };
      expect(body.case.consumer.piiTier).toBe('raw');
      expect(body.case.consumer.firstName).toBe('Jane');
    }
    expect(audit.events.filter((e) => e.action === 'pii.view_raw')).toHaveLength(2);
  });

  it('rejects an unknown pii tier with 422', async () => {
    const staff = makeStaffFake();
    await staff.createStaffUser({
      email: 'manager-pii@x.com',
      displayName: 'Manager',
      role: 'MANAGER',
      password: 'password1234',
    });
    const token = (await staff.login('manager-pii@x.com', 'password1234'))!.token;
    const app = appWith({ admin: makeAdminFake(), staff, audit: makeAuditFake() });

    const response = await app.request('/admin/cases/KOI-7N4Q-A91M2X6P?pii=decrypted', {
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(response.status).toBe(422);
  });

  it('fails closed when the raw-PII audit write fails', async () => {
    const staff = makeStaffFake();
    await staff.createStaffUser({
      email: 'compliance@example.com',
      displayName: 'Compliance',
      role: 'MANAGER',
      password: 'password1234',
    });
    const token = (await staff.login('compliance@example.com', 'password1234'))!.token;
    const app = appWith({ admin: makeAdminFake(), staff, audit: makeFailingAuditFake() });

    const response = await app.request('/admin/cases/KOI-7N4Q-A91M2X6P?pii=raw', {
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(response.status).toBe(500);
  });

  it('fails closed when the assignment audit write fails', async () => {
    const staff = makeStaffFake();
    await staff.createStaffUser({
      email: 'reviewer@example.com',
      displayName: 'Reviewer',
      role: 'MANAGER',
      password: 'password1234',
    });
    const token = (await staff.login('reviewer@example.com', 'password1234'))!.token;
    const app = appWith({ admin: makeAdminFake(), staff, audit: makeFailingAuditFake() });

    const response = await app.request('/admin/cases/KOI-7N4Q-A91M2X6P/assign', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ staffUserId: null }),
    });

    expect(response.status).toBe(500);
  });

  it('rejects an invalid staff role before calling the database service', async () => {
    const staff = makeStaffFake();
    await staff.createStaffUser({
      email: 'admin@example.com',
      displayName: 'Admin',
      role: 'ADMIN',
      password: 'password1234',
    });
    const token = (await staff.login('admin@example.com', 'password1234'))!.token;
    const app = appWith({ admin: makeAdminFake(), staff, audit: makeAuditFake() });

    const response = await app.request('/admin/staff', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'new@example.com',
        displayName: 'New',
        role: 'superuser',
        password: 'password1234',
      }),
    });

    expect(response.status).toBe(422);
    expect(staff.users.size).toBe(1);
  });

  it('rejects an invalid staff status before calling the database service', async () => {
    const staff = makeStaffFake();
    const adminUser = await staff.createStaffUser({
      email: 'admin-status@example.com',
      displayName: 'Admin',
      role: 'ADMIN',
      password: 'password1234',
    });
    const token = (await staff.login('admin-status@example.com', 'password1234'))!.token;
    const app = appWith({ admin: makeAdminFake(), staff, audit: makeAuditFake() });

    const response = await app.request(`/admin/staff/${adminUser.id}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'deleted' }),
    });

    expect(response.status).toBe(422);
    expect(staff.users.get(adminUser.id)?.status).toBe('active');
  });

  it('rejects a staff password shorter than twelve characters', async () => {
    const staff = makeStaffFake();
    await staff.createStaffUser({
      email: 'admin-password@example.com',
      displayName: 'Admin',
      role: 'ADMIN',
      password: 'password1234',
    });
    const token = (await staff.login('admin-password@example.com', 'password1234'))!.token;
    const app = appWith({ admin: makeAdminFake(), staff, audit: makeAuditFake() });

    const response = await app.request('/admin/staff', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'short-password@example.com',
        displayName: 'Short Password',
        role: 'MANAGER',
        password: 'too-short',
      }),
    });

    expect(response.status).toBe(422);
    expect(staff.users.size).toBe(1);
  });

  it('lets an administrator read audit events and manage staff', async () => {
    const staff = makeStaffFake();
    const audit = makeAuditFake();
    const admin = makeAdminFake();
    const adminUser = await staff.createStaffUser({
      email: 'a@x.com',
      displayName: 'Admin',
      role: 'ADMIN',
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
        role: 'MANAGER',
        password: 'password1234',
      }),
    });
    expect(createRes.status).toBe(201);
    const createBody = (await createRes.json()) as { staff: StaffUser };
    expect(createBody.staff.role).toBe('MANAGER');

    // The staff.create action is audited.
    const createAudit = audit.events.find((e) => e.action === 'staff.create');
    expect(createAudit).toBeTruthy();
    expect(createAudit?.actorUserId).toBe(adminUser.id);
  });

  it('lists incidents for a viewer via GET /admin/incidents', async () => {
    const staff = makeStaffFake();
    const admin = makeAdminFake();
    admin.listIncidents = () =>
      Promise.resolve({
        incidents: [
          {
            id: 'i-1',
            caseReference: 'KOI-7N4Q-A91M2X6P',
            caseStatus: 'triage',
            answer: 'yes',
            eventTypes: ['burn'],
            injurySeverity: 'moderate',
            medicalTreatment: 'yes',
            occurredAt: '2026-08-01T00:00:00.000Z',
            createdAt: '2026-08-02T00:00:00.000Z',
            reportability: {
              id: 'r-1',
              status: 'pending',
              cpscReference: null,
              filedAt: null,
              decisionAt: null,
            },
          },
        ],
        total: 1,
        nextCursor: null,
      });
    await staff.createStaffUser({
      email: 'v2@x.com',
      displayName: 'Viewer2',
      role: 'MANAGER',
      password: 'password1234',
    });
    const token = (await staff.login('v2@x.com', 'password1234'))!.token;
    const app = appWith({ admin, staff, audit: makeAuditFake() });

    const res = await app.request('/admin/incidents', {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { incidents: Array<{ id: string; caseReference: string }> };
    expect(body.incidents[0]?.caseReference).toBe('KOI-7N4Q-A91M2X6P');
  });

  it('lists campaigns for a viewer via GET /admin/campaigns', async () => {
    const staff = makeStaffFake();
    const admin = makeAdminFake();
    admin.listCampaigns = () =>
      Promise.resolve([
        {
          id: 'c-1',
          slug: 'music-lollipop-demo-2026',
          code: 'KOI-ML-2026',
          status: 'active',
          launchAt: '2026-01-01T00:00:00.000Z',
          closeAt: null,
          title: 'Music Lollipop Recall',
          caseCount: 12,
        },
      ]);
    await staff.createStaffUser({
      email: 'v3@x.com',
      displayName: 'Viewer3',
      role: 'MANAGER',
      password: 'password1234',
    });
    const token = (await staff.login('v3@x.com', 'password1234'))!.token;
    const app = appWith({ admin, staff, audit: makeAuditFake() });

    const res = await app.request('/admin/campaigns', {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { campaigns: Array<{ slug: string; caseCount: number }> };
    expect(body.campaigns[0]?.slug).toBe('music-lollipop-demo-2026');
    expect(body.campaigns[0]?.caseCount).toBe(12);
  });

  it('requires a note when transitioning to need_info and forwards it otherwise', async () => {
    const staff = makeStaffFake();
    const admin = makeAdminFake();
    const audit = makeAuditFake();
    const forwarded: Array<{ nextStatus: string; note?: string }> = [];
    admin.transitionCaseStatus = (_ref, nextStatus, _userId, note) => {
      forwarded.push({ nextStatus, ...(note !== undefined ? { note } : {}) });
      return Promise.resolve();
    };
    await staff.createStaffUser({
      email: 'r3@x.com',
      displayName: 'Reviewer3',
      role: 'MANAGER',
      password: 'password1234',
    });
    const token = (await staff.login('r3@x.com', 'password1234'))!.token;
    const app = appWith({ admin, staff, audit });

    // need_info without a note is rejected with 422.
    const withoutNote = await app.request('/admin/cases/KOI-7N4Q-A91M2X6P/status', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'need_info' }),
    });
    expect(withoutNote.status).toBe(422);

    // need_info with a short note is rejected with 422.
    const shortNote = await app.request('/admin/cases/KOI-7N4Q-A91M2X6P/status', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'need_info', note: 'short' }),
    });
    expect(shortNote.status).toBe(422);

    // A valid note is forwarded to the service.
    const withNote = await app.request('/admin/cases/KOI-7N4Q-A91M2X6P/status', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        status: 'need_info',
        note: 'Please provide a photo of the lot code.',
      }),
    });
    expect(withNote.status).toBe(204);
    expect(forwarded).toEqual([
      {
        nextStatus: 'need_info',
        note: 'Please provide a photo of the lot code.',
      },
    ]);

    // Transitions to other states carry an optional note too.
    const triage = await app.request('/admin/cases/KOI-7N4Q-A91M2X6P/status', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'triage', note: 'Product anomaly suspected.' }),
    });
    expect(triage.status).toBe(204);
    expect(forwarded[1]).toEqual({ nextStatus: 'triage', note: 'Product anomaly suspected.' });
  });

  it('mints an audited evidence access URL for a case document', async () => {
    const staff = makeStaffFake();
    const admin = makeAdminFake();
    const audit = makeAuditFake();
    let requestedCaseRef: string | undefined;
    admin.getDocumentAccess = (caseRef, _documentId) => {
      requestedCaseRef = caseRef;
      return Promise.resolve({
        documentId: '11111111-1111-4111-8111-111111111111',
        fileName: 'receipt.png',
        contentType: 'image/png',
        url: 'https://blob.example.test/drafts/x/receipt.png',
        downloadUrl: 'https://blob.example.test/drafts/x/receipt.png?download=1',
      });
    };
    await staff.createStaffUser({
      email: 'mgr@x.com',
      displayName: 'Manager',
      role: 'MANAGER',
      password: 'password1234',
    });
    const token = (await staff.login('mgr@x.com', 'password1234'))!.token;
    const app = appWith({ admin, staff, audit });

    const res = await app.request(
      '/admin/cases/KOI-7N4Q-A91M2X6P/documents/11111111-1111-4111-8111-111111111111/url',
      { headers: { Authorization: `Bearer ${token}` } },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { url: string; fileName: string };
    expect(body.url).toContain('blob.example.test');
    expect(body.fileName).toBe('receipt.png');
    expect(requestedCaseRef).toBe('KOI-7N4Q-A91M2X6P');

    // The access mint is audited (document.download).
    expect(audit.events).toContainEqual(
      expect.objectContaining({ action: 'document.download', outcome: 'success' }),
    );
  });

  it('rejects a malformed document id and missing documents with 404', async () => {
    const staff = makeStaffFake();
    const admin = makeAdminFake();
    admin.getDocumentAccess = () => Promise.resolve(null);
    await staff.createStaffUser({
      email: 'mgr2@x.com',
      displayName: 'Manager2',
      role: 'MANAGER',
      password: 'password1234',
    });
    const token = (await staff.login('mgr2@x.com', 'password1234'))!.token;
    const app = appWith({ admin, staff, audit: makeAuditFake() });

    const malformed = await app.request('/admin/cases/KOI-7N4Q-A91M2X6P/documents/not-a-uuid/url', {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(malformed.status).toBe(422);

    const missing = await app.request(
      '/admin/cases/KOI-7N4Q-A91M2X6P/documents/11111111-1111-4111-8111-111111111111/url',
      { headers: { Authorization: `Bearer ${token}` } },
    );
    expect(missing.status).toBe(404);
  });

  it('lets a staff user change their own password (audited)', async () => {
    const staff = makeStaffFake();
    const audit = makeAuditFake();
    await staff.createStaffUser({
      email: 'changepw@x.com',
      displayName: 'ChangePw',
      role: 'ADMIN',
      password: 'password1234',
    });
    const token = (await staff.login('changepw@x.com', 'password1234'))!.token;
    const app = appWith({ admin: makeAdminFake(), staff, audit });

    const ok = await app.request('/admin/profile/password', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ currentPassword: 'password1234', newPassword: 'newpassword1234' }),
    });
    expect(ok.status).toBe(204);
    expect(audit.events).toContainEqual(
      expect.objectContaining({ action: 'staff.change_password', outcome: 'success' }),
    );

    // wrong current password -> 422
    const bad = await app.request('/admin/profile/password', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ currentPassword: 'wrong', newPassword: 'newpassword1234' }),
    });
    expect(bad.status).toBe(422);
  });
});
