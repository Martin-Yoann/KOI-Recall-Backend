import type { OpenAPIHono } from '@hono/zod-openapi';
import type { Context } from 'hono';

import type { AdminTransactionRunner, ApplicationRegistry } from '../composition.js';
import type { AuditService } from '../modules/staff/audit-service.js';
import type { Permission } from '../modules/staff/permissions.js';
import { hasPermission, STAFF_ROLES } from '../modules/staff/permissions.js';
import type { StaffRole } from '../modules/staff/permissions.js';
import type { StaffService } from '../modules/staff/service.js';
import type { StaffPrincipal } from '../modules/staff/service.js';
import type { SensitiveDataCryptoPort } from '../platform/crypto/port.js';
import type { AppEnv } from '../middleware/request-context.js';
import { requestIpHash, requestUserAgentHash } from '../middleware/staff-auth.js';
import { createStaffAuthMiddleware } from '../middleware/staff-auth.js';
import { NotImplementedServiceError, problemType } from '../shared/errors.js';
import { consoleSafeLogger } from '../platform/observability/logger.js';

/**
 * ADR-0004: the B-end (internal-operations) surface. M2 dual-mode: a request
 * is accepted when it carries either a valid staff session token OR the legacy
 * `ADMIN_API_KEY` shared secret. The staff-auth middleware resolves either
 * path to a `principal` on the context; routes then enforce permissions.
 *
 * New endpoints (case detail, assign, status, sessions, staff mgmt, audit)
 * require a real staff session and do NOT accept the legacy key 鈥?they are
 * net-new and have no backward-compat obligation.
 */

export interface AdminRouteDeps {
  adminApiKey?: string | undefined;
  staffService?: StaffService | undefined;
  auditService?: AuditService | undefined;
  crypto: SensitiveDataCryptoPort;
}

function unauthorized(context: Context<AppEnv>) {
  return context.json(
    {
      type: problemType('unauthorized'),
      title: 'Unauthorized',
      status: 401,
      detail: 'A valid staff session is required.',
      requestId: context.get('requestId'),
    },
    401,
    { 'Content-Type': 'application/problem+json' },
  );
}

function forbidden(context: Context<AppEnv>, permission: Permission) {
  return context.json(
    {
      type: problemType('forbidden'),
      title: 'Forbidden',
      status: 403,
      detail: `This action requires the '${permission}' permission.`,
      requestId: context.get('requestId'),
    },
    403,
    { 'Content-Type': 'application/problem+json' },
  );
}

/**
 * Guards a route by permission; writes a denied audit row on failure. Returns
 * the principal on success, or a ready-to-send error Response on failure. The
 * caller distinguishes the two with `instanceof Response`.
 */
async function requirePermission(
  context: Context<AppEnv>,
  registry: ApplicationRegistry,
  permission: Permission,
  options: { allowLegacy?: boolean } = {},
): Promise<StaffPrincipal | Response> {
  const principal = context.get('principal');
  if (!principal) {
    return unauthorized(context);
  }
  if (context.get('legacyAdminKey')) {
    if (!options.allowLegacy) return unauthorized(context);
    consoleSafeLogger.info('Deprecated legacy admin key used.', {
      requestId: context.get('requestId'),
      method: context.req.method,
      path: new URL(context.req.url).pathname,
    });
    return principal;
  }
  if (!hasPermission(principal.role, permission)) {
    const audit = requireAuditService(registry);
    await audit.record({
      actorUserId: principal.userId,
      actorRole: principal.role,
      action: permission,
      resourceType: 'permission',
      resourceId: permission,
      outcome: 'denied',
      reasonCode: 'insufficient_role',
      ipAddressHash: await requestIpHash(context, registry.platform.crypto),
      userAgentHash: await requestUserAgentHash(context, registry.platform.crypto),
    });
    return forbidden(context, permission);
  }
  return principal;
}

function requireAuditService(registry: ApplicationRegistry): AuditService {
  const audit = registry.services.audit;
  if (!audit) throw new NotImplementedServiceError('Admin audit recording');
  return audit;
}

function requireAdminTransactions(registry: ApplicationRegistry): AdminTransactionRunner {
  const transactions = registry.services.adminTransactions;
  if (!transactions) throw new NotImplementedServiceError('Transactional admin operations');
  return transactions;
}

const json = (context: Context<AppEnv>, status: number, body: unknown) =>
  context.json(body, status as never);

/** Parses a JSON request body as a typed record (defaults to {} on parse error). */
async function bodyRecord(context: Context<AppEnv>): Promise<Record<string, unknown>> {
  let parsed: unknown;
  try {
    parsed = await context.req.json();
  } catch {
    return {};
  }
  return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
}

const asString = (value: unknown): string | undefined =>
  typeof value === 'string' ? value : undefined;

const STAFF_USER_STATUSES = ['active', 'disabled'] as const;
const CASE_STATUSES = [
  'submitted',
  'triage',
  'under_review',
  'need_info',
  'approved',
  'rejected',
  'duplicate',
  'withdrawn',
  'closure_review',
  'closed',
] as const;

function isStaffRole(value: string | undefined): value is StaffRole {
  return value !== undefined && STAFF_ROLES.includes(value as StaffRole);
}

function isStaffUserStatus(value: string | undefined): value is 'active' | 'disabled' {
  return value !== undefined && STAFF_USER_STATUSES.includes(value as 'active' | 'disabled');
}

function validationError(context: Context<AppEnv>, detail: string) {
  return json(context, 422, {
    type: problemType('validation-error'),
    title: 'Invalid Request',
    status: 422,
    detail,
    requestId: context.get('requestId'),
  });
}

export function registerAdminRoutes(
  app: OpenAPIHono<AppEnv>,
  registry: ApplicationRegistry,
  deps: AdminRouteDeps,
) {
  // Resolve the principal on every /admin/* request (staff session or legacy key).
  app.use(
    '/admin/*',
    createStaffAuthMiddleware({
      staffService: deps.staffService,
      crypto: deps.crypto,
      legacyAdminApiKey: deps.adminApiKey,
    }),
  );

  // ---- Sessions (login/logout/refresh) 鈥?net-new, no legacy key ----

  app.post('/admin/sessions', async (context) => {
    const staff = registry.services.staff;
    if (!staff) return json(context, 501, { title: 'Staff service not configured.', status: 501 });
    const body = await bodyRecord(context);
    const email = asString(body.email) ?? '';
    const password = asString(body.password) ?? '';
    const ipHash = await requestIpHash(context, deps.crypto);
    const uaHash = await requestUserAgentHash(context, deps.crypto);
    const result = await staff.login(email, password, {
      ipHash,
      userAgentHash: uaHash,
    });
    if (!result) {
      return unauthorized(context);
    }
    const profile = await staff.getStaffUserByEmail(email);
    return context.json(
      {
        token: result.token,
        sessionId: result.sessionId,
        expiresAt: result.expiresAt,
        staffUserId: profile?.id ?? null,
        displayName: profile?.displayName ?? email,
        avatarDataUrl: profile?.avatarDataUrl ?? null,
        role: profile?.role ?? 'MANAGER',
      },
      201,
    );
  });

  // ---- Update own profile (name, avatar) 鈥?requires valid session ----

  app.patch('/admin/profile', async (context) => {
    const principal = context.get('principal');
    if (!principal) return unauthorized(context);
    if (context.get('legacyAdminKey')) return unauthorized(context);

    const body = await bodyRecord(context);
    const displayName = asString(body.displayName);
    const avatarDataUrl =
      body.avatarDataUrl !== undefined
        ? typeof body.avatarDataUrl === 'string'
          ? body.avatarDataUrl
          : null
        : undefined;

    if (displayName !== undefined && displayName.trim().length === 0) {
      return validationError(context, 'Display name must not be empty.');
    }

    if (avatarDataUrl !== undefined && avatarDataUrl !== null) {
      if (!avatarDataUrl.startsWith('data:image/')) {
        return validationError(context, 'Avatar must be a data:image/... URL.');
      }
      if (avatarDataUrl.length > 800_000) {
        return validationError(context, 'Avatar image must be under 512 KiB.');
      }
    }

    const updated = await requireAdminTransactions(registry).run(async ({ staff, audit }) => {
      const user = await staff.updateStaffUser(principal.userId, {
        ...(displayName !== undefined ? { displayName: displayName.trim() } : {}),
        ...(avatarDataUrl !== undefined ? { avatarDataUrl } : {}),
      });
      await audit.record({
        actorUserId: principal.userId,
        actorRole: principal.role,
        action: 'staff.update_profile',
        resourceType: 'staff',
        resourceId: principal.userId,
        outcome: 'success',
      });
      return user;
    });

    return context.json(
      {
        displayName: updated.displayName,
        avatarDataUrl: updated.avatarDataUrl,
      },
      200,
    );
  });

  // ---- Self-service password change (valid session, staff.change_password audit) ----

  app.post('/admin/profile/password', async (context) => {
    const principal = context.get('principal');
    if (!principal) return unauthorized(context);
    if (context.get('legacyAdminKey')) {
      return unauthorized(context);
    }
    const body = await bodyRecord(context);
    const currentPassword = asString(body.currentPassword) ?? '';
    const newPassword = asString(body.newPassword) ?? '';
    if (!currentPassword || !newPassword) {
      return validationError(context, 'currentPassword and newPassword are required.');
    }
    await requireAdminTransactions(registry).run(async ({ staff, audit }) => {
      await staff.changePassword({
        userId: principal.userId,
        currentPassword,
        newPassword,
        keepSessionId: principal.sessionId,
      });
      await audit.record({
        actorUserId: principal.userId,
        actorRole: principal.role,
        action: 'staff.change_password',
        resourceType: 'staff',
        resourceId: principal.userId,
        outcome: 'success',
      });
    });
    return context.body(null, 204);
  });

  app.delete('/admin/sessions', async (context) => {
    const principal = context.get('principal');
    if (!principal) return unauthorized(context);
    if (context.get('legacyAdminKey')) {
      return unauthorized(context);
    }
    await requireAdminTransactions(registry).run(async ({ staff, audit }) => {
      await staff.revokeSession(principal.sessionId);
      await audit.record({
        actorUserId: principal.userId,
        actorRole: principal.role,
        action: 'session.revoke',
        resourceType: 'session',
        resourceId: principal.sessionId,
        outcome: 'success',
      });
    });
    return context.body(null, 204);
  });

  app.post('/admin/sessions/refresh', async (context) => {
    const principal = context.get('principal');
    if (!principal) return unauthorized(context);
    if (context.get('legacyAdminKey')) {
      return unauthorized(context);
    }
    const refreshed = await requireAdminTransactions(registry).run(async ({ staff, audit }) => {
      const session = await staff.refreshSession(principal.sessionId);
      if (!session) return null;
      await audit.record({
        actorUserId: principal.userId,
        actorRole: principal.role,
        action: 'session.refresh',
        resourceType: 'session',
        resourceId: principal.sessionId,
        outcome: 'success',
      });
      return session;
    });
    if (!refreshed) return unauthorized(context);
    // The middleware already resolved the current active staff principal. Do
    // not perform another DB lookup after rotating the token: if that lookup
    // failed, the client would retain the old (now invalid) token despite a
    // successful rotation.
    return context.json(
      {
        token: refreshed.token,
        sessionId: refreshed.sessionId,
        expiresAt: refreshed.expiresAt,
        staffUserId: principal.userId,
        displayName: principal.displayName,
        role: principal.role,
      },
      200,
    );
  });

  // ---- Staff management (staff.read for listing; staff.manage for mutations) ----

  app.get('/admin/staff', async (context) => {
    const guard = await requirePermission(context, registry, 'staff.read');
    if (guard instanceof Response) return guard;
    const staff = registry.services.staff;
    if (!staff) return json(context, 501, { title: 'Staff service not configured.', status: 501 });
    const users = await staff.listStaff();
    return context.json({ staff: users }, 200);
  });

  app.post('/admin/staff', async (context) => {
    const guard = await requirePermission(context, registry, 'staff.manage');
    if (guard instanceof Response) return guard;
    const body = await bodyRecord(context);
    const email = asString(body.email);
    const password = asString(body.password);
    const displayName = asString(body.displayName);
    const role = asString(body.role);
    if (!email || !password || !displayName || !role) {
      return validationError(context, 'email, displayName, role, and password are required.');
    }
    if (!isStaffRole(role)) return validationError(context, 'role is invalid.');
    if (password.length < 12 || password.length > 1024) {
      return validationError(context, 'password must contain between 12 and 1024 characters.');
    }
    const created = await requireAdminTransactions(registry).run(async ({ staff, audit }) => {
      const user = await staff.createStaffUser({ email, displayName, role, password });
      await audit.record({
        actorUserId: guard.userId,
        actorRole: guard.role,
        action: 'staff.create',
        resourceType: 'user',
        resourceId: user.id,
        outcome: 'success',
      });
      return user;
    });
    return context.json({ staff: created }, 201);
  });

  app.patch('/admin/staff/:id', async (context) => {
    const guard = await requirePermission(context, registry, 'staff.manage');
    if (guard instanceof Response) return guard;
    const userId = context.req.param('id');
    const body = await bodyRecord(context);
    const role = asString(body.role);
    const status = asString(body.status);
    const displayName = asString(body.displayName);
    if (role !== undefined && !isStaffRole(role)) {
      return validationError(context, 'role is invalid.');
    }
    if (status !== undefined && !isStaffUserStatus(status)) {
      return validationError(context, 'status is invalid.');
    }
    if (role === undefined && status === undefined && displayName === undefined) {
      return validationError(context, 'At least one staff field must be supplied.');
    }
    const updated = await requireAdminTransactions(registry).run(async ({ staff, audit }) => {
      const user = await staff.updateStaffUser(userId, {
        ...(role !== undefined ? { role } : {}),
        ...(status !== undefined ? { status } : {}),
        ...(displayName !== undefined ? { displayName } : {}),
      });
      await audit.record({
        actorUserId: guard.userId,
        actorRole: guard.role,
        action: 'staff.role.change',
        resourceType: 'user',
        resourceId: userId,
        outcome: 'success',
        metadata: { role: user.role, status: user.status },
      });
      return user;
    });
    return context.json({ staff: updated }, 200);
  });

  app.delete('/admin/staff/:id', async (context) => {
    const guard = await requirePermission(context, registry, 'staff.manage');
    if (guard instanceof Response) return guard;
    const staffUserId = context.req.param('id');
    await requireAdminTransactions(registry).run(async ({ staff, audit }) => {
      await staff.deleteStaffUser(staffUserId, guard.userId);
      await audit.record({
        actorUserId: guard.userId,
        actorRole: guard.role,
        action: 'staff.delete',
        resourceType: 'user',
        resourceId: staffUserId,
        outcome: 'success',
      });
    });
    return context.body(null, 204);
  });

  app.delete('/admin/sessions/by-user/:id', async (context) => {
    const guard = await requirePermission(context, registry, 'staff.manage');
    if (guard instanceof Response) return guard;
    const userId = context.req.param('id');
    await requireAdminTransactions(registry).run(async ({ staff, audit }) => {
      await staff.revokeAllSessions(userId);
      await audit.record({
        actorUserId: guard.userId,
        actorRole: guard.role,
        action: 'session.revoke_all',
        resourceType: 'session',
        resourceId: userId,
        outcome: 'success',
      });
    });
    return context.body(null, 204);
  });

  // ---- Case queue + export (M2 dual-mode: legacy key OR staff session) ----

  app.get('/admin/cases', async (context) => {
    const guard = await requirePermission(context, registry, 'case.queue.read', {
      allowLegacy: true,
    });
    if (guard instanceof Response) return guard;
    const queueParam = context.req.query('queue');
    const queue = (
      ['standard', 'manual_review', 'incident', 'need_info', 'decision', 'closure'] as const
    ).includes(
      queueParam as
        'standard' | 'manual_review' | 'incident' | 'need_info' | 'decision' | 'closure',
    )
      ? (queueParam as
          'standard' | 'manual_review' | 'incident' | 'need_info' | 'decision' | 'closure')
      : undefined;
    const status = context.req.query('status') ?? undefined;
    const resolutionType = context.req.query('resolutionType');
    const resolutionStatus = context.req.query('resolutionStatus');
    const incidentParam = context.req.query('incident');
    const incident =
      incidentParam === 'true' ? true : incidentParam === 'false' ? false : undefined;
    const limit = Math.min(Number(context.req.query('limit') ?? 100) || 100, 1000);
    const cursor = context.req.query('cursor') ?? undefined;
    const search = context.req.query('search') ?? undefined;
    const page = await registry.services.admin?.listCases({
      ...(queue ? { queue } : {}),
      ...(status ? { status } : {}),
      ...(resolutionType === 'replacement' || resolutionType === 'refund'
        ? { resolutionType }
        : {}),
      ...(resolutionStatus === 'requested' ||
      resolutionStatus === 'approved' ||
      resolutionStatus === 'externally_completed' ||
      resolutionStatus === 'cancelled'
        ? { resolutionStatus }
        : {}),
      ...(incident !== undefined ? { incident } : {}),
      ...(search ? { search } : {}),
      limit,
      ...(cursor ? { cursor } : {}),
    });
    if (!page) throw new Error('Admin service is not configured.');
    return context.json({ cases: page.cases, total: page.total, nextCursor: page.nextCursor }, 200);
  });

  app.get('/admin/cases/export', async (context) => {
    const guard = await requirePermission(context, registry, 'case.export', { allowLegacy: true });
    if (guard instanceof Response) return guard;
    const cases = await registry.services.admin?.exportCases();
    if (!cases) throw new Error('Admin service is not configured.');
    if (!context.get('legacyAdminKey')) {
      await requireAuditService(registry).record({
        actorUserId: guard.userId,
        actorRole: guard.role,
        action: 'case.export',
        resourceType: 'case',
        outcome: 'success',
        metadata: { rowCount: cases.length },
      });
    }
    const csv = [
      'caseReference,status,subtype,incidentFlag,submittedAt',
      ...cases.map((c) =>
        [c.caseReference, c.status, c.subtype, String(c.incidentFlag), c.submittedAt].join(','),
      ),
    ].join('\n');
    return context.body(csv, 200, {
      'Content-Type': 'text/csv',
      'Content-Disposition': 'attachment; filename="cases.csv"',
    });
  });

  // ---- Incident operations list (incidents & safety surface) ----

  app.get('/admin/incidents', async (context) => {
    const guard = await requirePermission(context, registry, 'case.queue.read');
    if (guard instanceof Response) return guard;
    const admin = registry.services.admin;
    if (!admin) throw new Error('Admin service is not configured.');
    const search = context.req.query('search') ?? undefined;
    const severity = context.req.query('severity') ?? undefined;
    const reportabilityStatus = context.req.query('reportabilityStatus');
    const limit = Math.min(Number(context.req.query('limit') ?? 100) || 100, 1000);
    const cursor = context.req.query('cursor') ?? undefined;
    const page = await admin.listIncidents({
      ...(search ? { search } : {}),
      ...(severity ? { severity } : {}),
      ...(reportabilityStatus === 'pending' ||
      reportabilityStatus === 'filed' ||
      reportabilityStatus === 'documented_non_reportable'
        ? { reportabilityStatus }
        : {}),
      limit,
      ...(cursor ? { cursor } : {}),
    });
    return context.json(
      { incidents: page.incidents, total: page.total, nextCursor: page.nextCursor },
      200,
    );
  });

  app.get('/admin/incidents/:id', async (context) => {
    const guard = await requirePermission(context, registry, 'case.queue.read');
    if (guard instanceof Response) return guard;
    const admin = registry.services.admin;
    if (!admin) throw new Error('Admin service is not configured.');
    const incidentId = context.req.param('id');
    const detail = await admin.getIncidentDetail(incidentId);
    if (!detail) {
      return json(context, 404, {
        type: problemType('not-found'),
        title: 'Not Found',
        status: 404,
        detail: 'Incident was not found.',
        requestId: context.get('requestId'),
      });
    }
    return context.json(detail, 200);
  });

  // ---- Campaign overview (read-only intake context) ----

  app.get('/admin/campaigns', async (context) => {
    const guard = await requirePermission(context, registry, 'case.queue.read');
    if (guard instanceof Response) return guard;
    const admin = registry.services.admin;
    if (!admin) throw new Error('Admin service is not configured.');
    const campaigns = await admin.listCampaigns();
    return context.json({ campaigns }, 200);
  });

  // ---- Case detail (masked/raw two-tier PII) ----

  app.get('/admin/cases/:caseRef', async (context) => {
    const guard = await requirePermission(context, registry, 'case.detail.read');
    if (guard instanceof Response) return guard;
    const caseRef = context.req.param('caseRef');
    // PII tier must be requested explicitly; masked is the only default so a
    // casual detail read never decrypts consumer data (raw reads are audited).
    const rawPii = context.req.query('pii') ?? 'masked';
    if (rawPii !== 'masked' && rawPii !== 'raw') {
      return validationError(context, 'pii must be either "masked" or "raw".');
    }
    const detail = await registry.services.admin?.getCaseDetail({
      caseReference: caseRef,
      viewerRole: guard.role,
      piiLevel: rawPii,
    });
    if (!detail) {
      return json(context, 404, {
        type: problemType('not-found'),
        title: 'Not Found',
        status: 404,
        detail: 'Case was not found.',
        requestId: context.get('requestId'),
      });
    }
    // Raw PII read: write a pii.view_raw audit event (compliance).
    if (detail.consumer.piiTier === 'raw') {
      await requireAuditService(registry).record({
        actorUserId: guard.userId,
        actorRole: guard.role,
        action: 'pii.view_raw',
        resourceType: 'case',
        resourceId: caseRef,
        outcome: 'success',
        reasonCode: 'raw_pii_view',
        metadata: {
          fields: [
            ...Object.keys(detail.consumer).filter((field) => field !== 'piiTier'),
            ...(detail.incident?.narrative !== undefined ? ['incident.narrative'] : []),
          ],
        },
      });
    }
    return context.json({ case: detail }, 200);
  });

  // ---- Evidence file access (image preview / download, audited) ----

  app.get('/admin/cases/:caseRef/documents/:documentId/url', async (context) => {
    const guard = await requirePermission(context, registry, 'case.detail.read');
    if (guard instanceof Response) return guard;
    const caseRef = context.req.param('caseRef');
    const documentId = context.req.param('documentId');
    // document ids are uuids; a malformed id must not hit the DB driver.
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(documentId)) {
      return validationError(context, 'documentId must be a UUID.');
    }
    const admin = registry.services.admin;
    if (!admin?.getDocumentAccess) throw new Error('Admin service is not configured.');
    const access = await admin.getDocumentAccess(caseRef, documentId);
    if (!access) {
      return json(context, 404, {
        type: problemType('not-found'),
        title: 'Not Found',
        status: 404,
        detail: 'Document was not found on this case.',
        requestId: context.get('requestId'),
      });
    }
    await requireAuditService(registry).record({
      actorUserId: guard.userId,
      actorRole: guard.role,
      action: 'document.download',
      resourceType: 'document',
      resourceId: documentId,
      outcome: 'success',
      metadata: { caseReference: caseRef, fileName: access.fileName },
    });
    return context.json(access, 200);
  });

  app.post('/admin/cases/:caseRef/assign', async (context) => {
    const guard = await requirePermission(context, registry, 'case.assign');
    if (guard instanceof Response) return guard;
    const caseRef = context.req.param('caseRef');
    const body = await bodyRecord(context);
    const staffUserId = asString(body.staffUserId) ?? null;
    await requireAdminTransactions(registry).run(async ({ admin, audit }) => {
      await admin.assignCase(caseRef, staffUserId);
      await audit.record({
        actorUserId: guard.userId,
        actorRole: guard.role,
        action: 'case.assign',
        resourceType: 'case',
        resourceId: caseRef,
        outcome: 'success',
        metadata: { assignee: staffUserId },
      });
    });
    return context.body(null, 204);
  });

  app.post('/admin/cases/:caseRef/status', async (context) => {
    const guard = await requirePermission(context, registry, 'case.status.transition');
    if (guard instanceof Response) return guard;
    const caseRef = context.req.param('caseRef');
    const body = await bodyRecord(context);
    const nextStatus = asString(body.status);
    if (!nextStatus || !CASE_STATUSES.includes(nextStatus as (typeof CASE_STATUSES)[number])) {
      return json(context, 422, {
        type: problemType('validation-error'),
        title: 'Invalid Request',
        status: 422,
        detail: 'status must be one of the supported case statuses.',
        requestId: context.get('requestId'),
      });
    }
    const note = asString(body.note);
    const trimmedNote = note?.trim();
    // The consumer must be told what to provide: a need_info transition
    // without a note would strand them in "action required" with no guidance.
    if (
      guard.role !== 'ADMIN' &&
      nextStatus === 'need_info' &&
      (!trimmedNote || trimmedNote.length < 10)
    ) {
      return validationError(
        context,
        'A note of at least 10 characters is required when requesting additional information.',
      );
    }
    if (trimmedNote && trimmedNote.length > 2000) {
      return validationError(context, 'The transition note must be at most 2000 characters.');
    }
    await requireAdminTransactions(registry).run(async ({ admin, audit }) => {
      await admin.transitionCaseStatus(
        caseRef,
        nextStatus,
        guard.userId,
        trimmedNote,
        guard.role === 'ADMIN',
      );
      await audit.record({
        actorUserId: guard.userId,
        actorRole: guard.role,
        action: 'case.status.transition',
        resourceType: 'case',
        resourceId: caseRef,
        outcome: 'success',
        metadata: {
          nextStatus: body.status,
          ...(guard.role === 'ADMIN' ? { forced: true } : {}),
          ...(trimmedNote ? { note: trimmedNote } : {}),
        },
      });
    });
    return context.body(null, 204);
  });

  // ---- Resolution lifecycle (case.status.transition) ----

  app.post('/admin/cases/:caseRef/resolution/approve', async (context) => {
    const guard = await requirePermission(context, registry, 'case.status.transition');
    if (guard instanceof Response) return guard;
    const body = await bodyRecord(context);
    const type = asString(body.type);
    const note = asString(body.note) ?? '';
    const expectedVersion =
      typeof body.expectedVersion === 'number'
        ? body.expectedVersion
        : Number(body.expectedVersion);
    if (
      (type !== 'replacement' && type !== 'refund') ||
      note.trim().length < 10 ||
      note.length > 1000 ||
      !Number.isInteger(expectedVersion)
    )
      return validationError(
        context,
        'type, note (10-1000 characters), and integer expectedVersion are required.',
      );
    const refundAmountMinor =
      typeof body.refundAmountMinor === 'number'
        ? body.refundAmountMinor
        : Number(body.refundAmountMinor);
    const currency = asString(body.currency);
    if (
      type === 'refund' &&
      (!Number.isInteger(refundAmountMinor) || refundAmountMinor <= 0 || !currency)
    )
      return validationError(
        context,
        'refund approvals require a positive integer refundAmountMinor and currency.',
      );
    if (!registry.services.admin?.approveResolution)
      throw new Error('Resolution service is not configured.');
    const result =
      type === 'refund' && currency
        ? await registry.services.admin.approveResolution(context.req.param('caseRef'), {
            type,
            note,
            expectedVersion,
            actorUserId: guard.userId,
            actorRole: guard.role,
            refundAmountMinor,
            currency,
          })
        : await registry.services.admin.approveResolution(context.req.param('caseRef'), {
            type: 'replacement',
            note,
            expectedVersion,
            actorUserId: guard.userId,
            actorRole: guard.role,
          });
    if (!result) throw new Error('Admin service is not configured.');
    return context.json({ resolution: result }, 200);
  });

  app.post('/admin/cases/:caseRef/resolution/complete', async (context) => {
    const guard = await requirePermission(context, registry, 'case.status.transition');
    if (guard instanceof Response) return guard;
    const body = await bodyRecord(context);
    const note = asString(body.note) ?? '';
    const expectedVersion =
      typeof body.expectedVersion === 'number'
        ? body.expectedVersion
        : Number(body.expectedVersion);
    if (note.trim().length < 10 || note.length > 2000 || !Number.isInteger(expectedVersion))
      return validationError(
        context,
        'note (10-2000 characters) and integer expectedVersion are required.',
      );
    if (!registry.services.admin?.completeResolution)
      throw new Error('Resolution service is not configured.');
    const externalReference = asString(body.externalReference);
    const result = externalReference
      ? await registry.services.admin.completeResolution(context.req.param('caseRef'), {
          note,
          expectedVersion,
          actorUserId: guard.userId,
          actorRole: guard.role,
          externalReference,
        })
      : await registry.services.admin.completeResolution(context.req.param('caseRef'), {
          note,
          expectedVersion,
          actorUserId: guard.userId,
          actorRole: guard.role,
        });
    if (!result) throw new Error('Admin service is not configured.');
    return context.json({ resolution: result }, 200);
  });

  app.post('/admin/cases/:caseRef/resolution/cancel', async (context) => {
    const guard = await requirePermission(context, registry, 'case.status.transition');
    if (guard instanceof Response) return guard;
    const body = await bodyRecord(context);
    const note = asString(body.note) ?? '';
    const expectedVersion =
      typeof body.expectedVersion === 'number'
        ? body.expectedVersion
        : Number(body.expectedVersion);
    if (note.trim().length < 10 || note.length > 2000 || !Number.isInteger(expectedVersion))
      return validationError(
        context,
        'note (10-2000 characters) and integer expectedVersion are required.',
      );
    if (!registry.services.admin?.cancelResolution)
      throw new Error('Resolution service is not configured.');
    const result = await registry.services.admin.cancelResolution(context.req.param('caseRef'), {
      note,
      expectedVersion,
      actorUserId: guard.userId,
      actorRole: guard.role,
      actorIsAdministrator: guard.role === 'ADMIN',
    });
    if (!result) throw new Error('Admin service is not configured.');
    return context.json({ resolution: result }, 200);
  });

  app.get('/admin/refund-exports', async (context) => {
    const guard = await requirePermission(context, registry, 'case.export');
    if (guard instanceof Response) return guard;
    const service = registry.services.refundExports;
    if (!service)
      return json(context, 501, { title: 'Refund export service not configured.', status: 501 });
    const batches = await service.listBatches();
    return context.json({ batches }, 200);
  });

  app.post('/admin/refund-exports', async (context) => {
    try {
      const guard = await requirePermission(context, registry, 'case.export');
      if (guard instanceof Response) return guard;
      const service = registry.services.refundExports;
      if (!service)
        return json(context, 501, { title: 'Refund export service not configured.', status: 501 });
      const body = await bodyRecord(context);
      const purpose = asString(body.purpose) ?? '';
      if (purpose.trim().length === 0 || purpose.length > 500)
        return validationError(context, 'purpose is required and must be at most 500 characters.');
      const result = await service.export({
        actorUserId: guard.userId,
        actorRole: guard.role,
        purpose,
        includeExported: body.includeExported === true,
      });
      return context.body(result.csv, 200, {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="refund-export-${result.batchId}.csv"`,
        'X-Refund-Export-Batch-Id': result.batchId,
        'X-Refund-Export-Sha256': result.sha256,
      });
    } catch (error: unknown) {
      console.error('Backend Export Error:', error);
      const detail = error instanceof Error ? error.message : 'Failed to complete the request.';
      if (detail.includes('eligible')) {
        return json(context, 400, { title: 'Export failed', status: 400, detail });
      }
      return json(context, 500, { title: 'Internal Server Error', status: 500, detail });
    }
  });
  // ---- Reportability review close (review.close) ----

  app.post('/admin/reportability-reviews/:id/close', async (context) => {
    const guard = await requirePermission(context, registry, 'review.close', { allowLegacy: true });
    if (guard instanceof Response) return guard;
    const reviewId = context.req.param('id');
    const body = await bodyRecord(context);
    const cpscReference = asString(body.cpscReference);
    const outcome = asString(body.outcome);
    const legacyReviewerId = asString(body.reviewerId);
    const rationaleValue = asString(body.rationale) ?? '';
    const reviewerId = context.get('legacyAdminKey') ? (legacyReviewerId ?? '') : guard.userId;
    const input = {
      outcome: outcome === 'documented_non_reportable' ? 'documented_non_reportable' : 'filed',
      // Staff sessions use the resolved principal; legacy M2 preserves the old body contract.
      reviewerId,
      rationale: rationaleValue,
      ...(cpscReference ? { cpscReference } : {}),
    } as const;
    if (context.get('legacyAdminKey')) {
      await registry.services.admin?.closeReportabilityReview(reviewId, input);
      return context.body(null, 204);
    }
    await requireAdminTransactions(registry).run(async ({ admin, audit }) => {
      await admin.closeReportabilityReview(reviewId, input);
      await audit.record({
        actorUserId: guard.userId,
        actorRole: guard.role,
        action: 'review.close',
        resourceType: 'review',
        resourceId: reviewId,
        outcome: 'success',
        metadata: { outcome },
      });
    });
    return context.body(null, 204);
  });

  // ---- Audit read (audit.read) ----

  app.get('/admin/audit-events', async (context) => {
    const guard = await requirePermission(context, registry, 'audit.read');
    if (guard instanceof Response) return guard;
    const audit = registry.services.audit;
    if (!audit) return json(context, 501, { title: 'Audit service not configured.', status: 501 });
    const q = (name: string) => context.req.query(name);
    const since = q('since') ?? undefined;
    const until = q('until') ?? undefined;
    const outcomeParam = q('outcome');
    const outcome = (['success', 'denied', 'error'] as const).includes(
      outcomeParam as 'success' | 'denied' | 'error',
    )
      ? (outcomeParam as 'success' | 'denied' | 'error')
      : undefined;
    const page = await audit.query({
      ...(q('actorUserId') ? { actorUserId: q('actorUserId') } : {}),
      ...(q('resourceType') ? { resourceType: q('resourceType') } : {}),
      ...(q('resourceId') ? { resourceId: q('resourceId') } : {}),
      ...(q('action') ? { action: q('action') } : {}),
      ...(outcome ? { outcome } : {}),
      ...(since ? { since } : {}),
      ...(until ? { until } : {}),
      limit: Math.min(Number(q('limit') ?? 100) || 100, 1000),
      ...(q('cursor') ? { cursor: q('cursor') } : {}),
    });
    return context.json(
      { events: page.events, total: page.total, nextCursor: page.nextCursor },
      200,
    );
  });
}
