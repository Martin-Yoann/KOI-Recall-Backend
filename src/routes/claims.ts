import type { OpenAPIHono } from '@hono/zod-openapi';

import type { ApplicationRegistry } from '../composition.js';
import { claimSubmissionResponseSchema, submitClaimRoute } from '../contracts/toc.js';
import type { AppEnv } from '../middleware/request-context.js';
import { isConnectionError } from '../shared/errors.js';
import { dependencyUnavailable } from './shared.js';

/**
 * Registers the recall-claim submission route (idempotent, single-transaction).
 */
export function registerClaimRoutes(app: OpenAPIHono<AppEnv>, registry: ApplicationRegistry) {
  app.openapi(submitClaimRoute, async (context) => {
    let submitted;
    try {
      submitted = await registry.services.cases.submit({
        campaignSlug: context.req.valid('param').slug,
        idempotencyKey: context.req.valid('header')['Idempotency-Key'],
        body: context.req.valid('json'),
      });
    } catch (error) {
      if (isConnectionError(error))
        return dependencyUnavailable(context, 'Recall claim submission');
      throw error;
    }

    return context.json(claimSubmissionResponseSchema.parse(submitted), 201);
  });
}
