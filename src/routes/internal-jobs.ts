import type { OpenAPIHono } from '@hono/zod-openapi';

import type { AppEnv } from '../middleware/request-context.js';
import { problem } from './shared.js';

/**
 * Registers the internal cron-job routes. Both the Outbox drain and the draft
 * cleanup remain 501 until the workers land (O5/T5.2). The 501 bodies are
 * produced here so app.ts only assembles wiring.
 */
export function registerInternalJobRoutes(app: OpenAPIHono<AppEnv>) {
  app.get('/internal/jobs/outbox', (context) =>
    context.json(problem(context.get('requestId'), 'Outbox processing'), 501, {
      'Content-Type': 'application/problem+json',
    }),
  );
  app.get('/internal/jobs/cleanup-drafts', (context) =>
    context.json(problem(context.get('requestId'), 'Draft cleanup'), 501, {
      'Content-Type': 'application/problem+json',
    }),
  );
}
