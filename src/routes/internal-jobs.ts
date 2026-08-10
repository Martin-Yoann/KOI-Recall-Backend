import type { OpenAPIHono } from '@hono/zod-openapi';

import type { AppEnv } from '../middleware/request-context.js';
import { NotImplementedServiceError, problemType } from '../shared/errors.js';

/**
 * Rejects internal cron-job requests that do not present the configured
 * CRON_SECRET (T5.2/O5). Missing or invalid secrets get 401 so unauthenticated
 * callers cannot trigger the outbox drain or cleanup.
 */
export function requireCronSecret(
  expected: string | undefined,
  context: { req: { header(name: string): string | undefined } },
): boolean {
  const presented = context.req.header('Authorization')?.replace(/^Bearer\s+/i, '');
  return expected !== undefined && presented !== undefined && presented === expected;
}

export interface OutboxDrainResult {
  claimed: number;
  succeeded: number;
  failed: number;
}

export interface DraftCleanupResult {
  deleted: number;
  pending: number;
}

/**
 * Registers the internal cron-job routes (T5.2/O5): the outbox drain and the
 * draft cleanup. Both require the configured CRON_SECRET. The workers are
 * injected via handlers; until a worker is wired the handler throws
 * NotImplementedServiceError (mapped to 501 by onError).
 */
export function registerInternalJobRoutes(
  app: OpenAPIHono<AppEnv>,
  cronSecret: string | undefined,
  handlers: {
    drainOutbox: () => Promise<OutboxDrainResult>;
    cleanupDrafts: () => Promise<DraftCleanupResult>;
  },
) {
  app.get('/internal/jobs/outbox', async (context) => {
    if (!requireCronSecret(cronSecret, context)) {
      return context.json(
        {
          type: problemType('unauthorized'),
          title: 'Unauthorized',
          status: 401,
          detail: 'A valid CRON_SECRET is required.',
          requestId: context.get('requestId'),
        },
        401,
        { 'Content-Type': 'application/problem+json' },
      );
    }
    const result = await handlers.drainOutbox();
    return context.json(result, 200);
  });

  app.get('/internal/jobs/cleanup-drafts', async (context) => {
    if (!requireCronSecret(cronSecret, context)) {
      return context.json(
        {
          type: problemType('unauthorized'),
          title: 'Unauthorized',
          status: 401,
          detail: 'A valid CRON_SECRET is required.',
          requestId: context.get('requestId'),
        },
        401,
        { 'Content-Type': 'application/problem+json' },
      );
    }
    const result = await handlers.cleanupDrafts();
    return context.json(result, 200);
  });
}

/** Default handlers until workers are wired — surface 501 like the skeleton. */
export function notImplementedJobHandler<T>(capability: string): () => Promise<T> {
  return () => Promise.reject(new NotImplementedServiceError(capability));
}
