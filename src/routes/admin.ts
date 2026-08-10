import type { OpenAPIHono } from '@hono/zod-openapi';
import type { Context } from 'hono';

import type { ApplicationRegistry } from '../composition.js';
import type { AppEnv } from '../middleware/request-context.js';
import { problemType } from '../shared/errors.js';

/**
 * Single-role admin auth (T8/O10): the bearer token must match ADMIN_API_KEY.
 * No multi-role RBAC, field masking, or per-user scopes — exactly one role.
 */
function requireAdminKey(expected: string | undefined, presented: string | undefined): boolean {
  return expected !== undefined && presented !== undefined && presented === expected;
}

/**
 * Registers the single-role admin surface (T8/O10): case queues, full export,
 * and the reportability-close gate. These are internal routes (not part of the
 * public v1 OpenAPI contract). Without ADMIN_API_KEY they surface 501.
 */
export function registerAdminRoutes(
  app: OpenAPIHono<AppEnv>,
  registry: ApplicationRegistry,
  adminApiKey: string | undefined,
) {
  const authorized = (context: { req: { header(name: string): string | undefined } }) =>
    requireAdminKey(adminApiKey, context.req.header('Authorization')?.replace(/^Bearer\s+/i, ''));

  const unauthorized = (context: Context<AppEnv>) =>
    context.json(
      {
        type: problemType('unauthorized'),
        title: 'Unauthorized',
        status: 401,
        detail: 'A valid Admin API key is required.',
        requestId: context.get('requestId'),
      },
      401,
      { 'Content-Type': 'application/problem+json' },
    );

  app.get('/admin/cases', async (context) => {
    if (!authorized(context)) {
      return unauthorized(context);
    }
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
    if (!authorized(context)) {
      return unauthorized(context);
    }
    const cases = await registry.services.admin?.exportCases();
    if (!cases) throw new Error('Admin service is not configured.');
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

  app.post('/admin/reportability-reviews/:id/close', async (context) => {
    if (!authorized(context)) {
      return unauthorized(context);
    }
    const reviewId = context.req.param('id');
    const emptyBody: Record<string, unknown> = {};
    const body = await context.req.json<Record<string, unknown>>().catch(() => emptyBody);
    const cpscValue = body.cpscReference;
    const cpscReference = typeof cpscValue === 'string' ? cpscValue : undefined;
    const outcome = body.outcome;
    const reviewerIdValue = body.reviewerId;
    const rationaleValue = body.rationale;
    await registry.services.admin?.closeReportabilityReview(reviewId, {
      outcome: outcome === 'documented_non_reportable' ? 'documented_non_reportable' : 'filed',
      reviewerId: typeof reviewerIdValue === 'string' ? reviewerIdValue : '',
      rationale: typeof rationaleValue === 'string' ? rationaleValue : '',
      ...(cpscReference ? { cpscReference } : {}),
    });
    return context.body(null, 204);
  });
}
