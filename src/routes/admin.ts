import type { OpenAPIHono } from '@hono/zod-openapi';
import type { Context } from 'hono';

import type { ApplicationRegistry } from '../composition.js';
import type { AuditService } from '../modules/staff/audit-service.js';
import type { Permission } from '../modules/staff/permissions.js';
import { hasPermission } from '../modules/staff/permissions.js';
import type { StaffRole } from '../modules/staff/permissions.js';
import type { StaffService } from '../modules/staff/service.js';
import type { StaffPrincipal } from '../modules/staff/service.js';
import type { SensitiveDataCryptoPort } from '../platform/crypto/port.js';
import type { AppEnv } from '../middleware/request-context.js';
import { requestIpHash, requestUserAgentHash } from '../middleware/staff-auth.js';
import { createStaffAuthMiddleware } from '../middleware/staff-auth.js';
import { problemType } from '../shared/errors.js';

/**
 * ADR-0004: the B-end (internal-operations) surface. M2 dual-mode: a request
 * is accepted when it carries either a valid staff session token OR the legacy
 * `ADMIN_API_KEY` shared secret. The staff-auth middleware resolves either
 * path to a `principal` on the context; routes then enforce permissions.
 *
 * New endpoints (case detail, assign, status, sessions, staff mgmt, audit)
 * require a real staff session and do NOT accept the legacy key — they are
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
): Promise<StaffPrincipal | Response> {
  const principal = context.get('principal');
  if (!principal) {
    return unauthorized(context);
  }
  if (!hasPermission(principal.role, permission)) {
    // Record the denied attempt for accountability (best-effort; never blocks the 403).
    await registry.services.audit
      ?.record({
        actorUserId: principal.userId,
        actorRole: principal.role,
        action: permission,
        resourceType: 'permission',
        resourceId: permission,
        outcome: 'denied',
        reasonCode: 'insufficient_role',
        ipAddressHash: await requestIpHash(context, registry.platform.crypto),
      })
      .catch(() => undefined);
    return forbidden(context, permission);
  }
  return principal;
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

  // ---- Sessions (login/logout/refresh) — net-new, no legacy key ----

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
    return context.json(
      { token: result.token, sessionId: result.sessionId, expiresAt: result.expiresAt },
      201,
    );
  });

  app.delete('/admin/sessions', async (context) => {
    const principal = context.get('principal');
    const staff = registry.services.staff;
    if (!principal || !staff) return unauthorized(context);
    if (context.get('legacyAdminKey')) {
      return context.body(null, 204);
    }
    await staff.revokeSession(principal.sessionId);
    return context.body(null, 204);
  });

  app.post('/admin/sessions/refresh', async (context) => {
    const principal = context.get('principal');
    const staff = registry.services.staff;
    if (!principal || !staff) return unauthorized(context);
    if (context.get('legacyAdminKey')) {
      return unauthorized(context);
    }
    const refreshed = await staff.refreshSession(principal.sessionId);
    if (!refreshed) return unauthorized(context);
    return context.json(
      { token: refreshed.token, sessionId: refreshed.sessionId, expiresAt: refreshed.expiresAt },
      200,
    );
  });

  // ---- Staff management (staff.manage) ----

  app.get('/admin/staff', async (context) => {
    const guard = await requirePermission(context, registry, 'staff.manage');
    if (guard instanceof Response) return guard;
    const staff = registry.services.staff;
    if (!staff) return json(context, 501, { title: 'Staff service not configured.', status: 501 });
    const users = await staff.listStaff();
    return context.json({ staff: users }, 200);
  });

  app.post('/admin/staff', async (context) => {
    const guard = await requirePermission(context, registry, 'staff.manage');
    if (guard instanceof Response) return guard;
    const staff = registry.services.staff;
    if (!staff) return json(context, 501, { title: 'Staff service not configured.', status: 501 });
    const body = await bodyRecord(context);
    const email = asString(body.email);
    const password = asString(body.password);
    const displayName = asString(body.displayName);
    const role = asString(body.role);
    if (!email || !password || !displayName || !role) {
      return json(context, 422, {
        type: problemType('validation-error'),
        title: 'Invalid Request',
        status: 422,
        detail: 'email, displayName, role, and password are required.',
        requestId: context.get('requestId'),
      });
    }
    const created = await staff.createStaffUser({
      email,
      displayName,
      role: role as StaffRole,
      password,
    });
    await registry.services.audit
      ?.record({
        actorUserId: guard.userId,
        actorRole: guard.role,
        action: 'staff.create',
        resourceType: 'user',
        resourceId: created.id,
        outcome: 'success',
      })
      .catch(() => undefined);
    return context.json({ staff: created }, 201);
  });

  app.patch('/admin/staff/:id', async (context) => {
    const guard = await requirePermission(context, registry, 'staff.manage');
    if (guard instanceof Response) return guard;
    const staff = registry.services.staff;
    if (!staff) return json(context, 501, { title: 'Staff service not configured.', status: 501 });
    const userId = context.req.param('id');
    const body = await bodyRecord(context);
    const role = asString(body.role);
    const status = asString(body.status);
    const displayName = asString(body.displayName);
    const updated = await staff.updateStaffUser(userId, {
      ...(role !== undefined ? { role: role as StaffRole } : {}),
      ...(status !== undefined ? { status: status as 'active' | 'disabled' } : {}),
      ...(displayName !== undefined ? { displayName } : {}),
    });
    await registry.services.audit
      ?.record({
        actorUserId: guard.userId,
        actorRole: guard.role,
        action: 'staff.role.change',
        resourceType: 'user',
        resourceId: userId,
        outcome: 'success',
        metadata: { role: updated.role, status: updated.status },
      })
      .catch(() => undefined);
    return context.json({ staff: updated }, 200);
  });

  app.delete('/admin/sessions/by-user/:id', async (context) => {
    const guard = await requirePermission(context, registry, 'staff.manage');
    if (guard instanceof Response) return guard;
    const staff = registry.services.staff;
    if (!staff) return json(context, 501, { title: 'Staff service not configured.', status: 501 });
    const userId = context.req.param('id');
    await staff.revokeAllSessions(userId);
    return context.body(null, 204);
  });

  // ---- Case queue + export (M2 dual-mode: legacy key OR staff session) ----

  app.get('/admin/cases', async (context) => {
    const guard = await requirePermission(context, registry, 'case.queue.read');
    if (guard instanceof Response) return guard;
    const queueParam = context.req.query('queue');
    const queue = (['standard', 'manual_review', 'incident'] as const).includes(
      queueParam as 'standard' | 'manual_review' | 'incident',
    )
      ? (queueParam as 'standard' | 'manual_review' | 'incident')
      : undefined;
    const status = context.req.query('status') ?? undefined;
    const limit = Math.min(Number(context.req.query('limit') ?? 100) || 100, 1000);
    const cases = await registry.services.admin?.listCases({
      ...(queue ? { queue } : {}),
      ...(status ? { status } : {}),
      limit,
    });
    if (!cases) throw new Error('Admin service is not configured.');
    return context.json({ cases }, 200);
  });

  app.get('/admin/cases/export', async (context) => {
    const guard = await requirePermission(context, registry, 'case.export');
    if (guard instanceof Response) return guard;
    const cases = await registry.services.admin?.exportCases();
    if (!cases) throw new Error('Admin service is not configured.');
    await registry.services.audit
      ?.record({
        actorUserId: guard.userId,
        actorRole: guard.role,
        action: 'case.export',
        resourceType: 'case',
        outcome: 'success',
        metadata: { rowCount: cases.length },
      })
      .catch(() => undefined);
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

  // ---- Case detail (masked/raw two-tier PII) ----

  app.get('/admin/cases/:caseRef', async (context) => {
    const guard = await requirePermission(context, registry, 'case.detail.read');
    if (guard instanceof Response) return guard;
    const caseRef = context.req.param('caseRef');
    const detail = await registry.services.admin?.getCaseDetail({
      caseReference: caseRef,
      viewerRole: guard.role,
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
      await registry.services.audit
        ?.record({
          actorUserId: guard.userId,
          actorRole: guard.role,
          action: 'pii.view_raw',
          resourceType: 'case',
          resourceId: caseRef,
          outcome: 'success',
          reasonCode: 'raw_pii_view',
        })
        .catch(() => undefined);
    }
    return context.json({ case: detail }, 200);
  });

  app.post('/admin/cases/:caseRef/assign', async (context) => {
    const guard = await requirePermission(context, registry, 'case.assign');
    if (guard instanceof Response) return guard;
    const caseRef = context.req.param('caseRef');
    const body = await bodyRecord(context);
    const staffUserId = asString(body.staffUserId) ?? null;
    await registry.services.admin?.assignCase(caseRef, staffUserId);
    await registry.services.audit
      ?.record({
        actorUserId: guard.userId,
        actorRole: guard.role,
        action: 'case.assign',
        resourceType: 'case',
        resourceId: caseRef,
        outcome: 'success',
        metadata: { assignee: staffUserId },
      })
      .catch(() => undefined);
    return context.body(null, 204);
  });

  app.post('/admin/cases/:caseRef/status', async (context) => {
    const guard = await requirePermission(context, registry, 'case.status.transition');
    if (guard instanceof Response) return guard;
    const caseRef = context.req.param('caseRef');
    const body = await bodyRecord(context);
    const nextStatus = asString(body.status);
    if (!nextStatus) {
      return json(context, 422, {
        type: problemType('validation-error'),
        title: 'Invalid Request',
        status: 422,
        detail: 'status is required.',
        requestId: context.get('requestId'),
      });
    }
    await registry.services.admin?.transitionCaseStatus(caseRef, nextStatus);
    await registry.services.audit
      ?.record({
        actorUserId: guard.userId,
        actorRole: guard.role,
        action: 'case.status.transition',
        resourceType: 'case',
        resourceId: caseRef,
        outcome: 'success',
        metadata: { nextStatus: body.status },
      })
      .catch(() => undefined);
    return context.body(null, 204);
  });

  // ---- Reportability review close (review.close) ----

  app.post('/admin/reportability-reviews/:id/close', async (context) => {
    const guard = await requirePermission(context, registry, 'review.close');
    if (guard instanceof Response) return guard;
    const reviewId = context.req.param('id');
    const body = await bodyRecord(context);
    const cpscReference = asString(body.cpscReference);
    const outcome = asString(body.outcome);
    const rationaleValue = asString(body.rationale) ?? '';
    await registry.services.admin?.closeReportabilityReview(reviewId, {
      outcome: outcome === 'documented_non_reportable' ? 'documented_non_reportable' : 'filed',
      // reviewerId now sourced from the resolved principal, not the request body.
      reviewerId: guard.userId,
      rationale: rationaleValue,
      ...(cpscReference ? { cpscReference } : {}),
    });
    await registry.services.audit
      ?.record({
        actorUserId: guard.userId,
        actorRole: guard.role,
        action: 'review.close',
        resourceType: 'review',
        resourceId: reviewId,
        outcome: 'success',
        metadata: { outcome },
      })
      .catch(() => undefined);
    return context.body(null, 204);
  });

  // ---- Audit read (audit.read) ----

  app.get('/admin/audit-events', async (context) => {
    const guard = await requirePermission(context, registry, 'audit.read');
    if (guard instanceof Response) return guard;
    const audit = registry.services.audit;
    if (!audit) return json(context, 501, { title: 'Audit service not configured.', status: 501 });
    const q = context.req.query.bind(context.req);
    const since = q('since') ?? undefined;
    const until = q('until') ?? undefined;
    const events = await audit.query({
      ...(q('actorUserId') ? { actorUserId: q('actorUserId') } : {}),
      ...(q('resourceType') ? { resourceType: q('resourceType') } : {}),
      ...(q('resourceId') ? { resourceId: q('resourceId') } : {}),
      ...(q('action') ? { action: q('action') } : {}),
      ...(since ? { since } : {}),
      ...(until ? { until } : {}),
      limit: Math.min(Number(q('limit') ?? 100) || 100, 1000),
    });
    return context.json({ events }, 200);
  });
}
