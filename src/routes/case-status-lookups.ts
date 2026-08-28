import type { OpenAPIHono } from '@hono/zod-openapi';

import type { ApplicationRegistry } from '../composition.js';
import { caseStatusLookupResponseSchema, createCaseStatusLookupRoute } from '../contracts/toc.js';
import type { AppEnv } from '../middleware/request-context.js';
import { isConnectionError } from '../shared/errors.js';
import { dependencyUnavailable, notFound } from './shared.js';

/**
 * Registers the public, PII-free case status lookup. Both failure shapes —
 * unknown case reference and reference/email mismatch — are collapsed into the
 * single `notFound` ProblemDetails so a probe cannot distinguish them.
 */
export function registerCaseStatusLookupRoutes(
  app: OpenAPIHono<AppEnv>,
  registry: ApplicationRegistry,
) {
  app.openapi(createCaseStatusLookupRoute, async (context) => {
    const body = context.req.valid('json');
    let view;
    try {
      view = await registry.services.caseStatusLookups.lookup(body.caseReference, body.email);
    } catch (error) {
      if (isConnectionError(error)) return dependencyUnavailable(context, 'Case status lookup');
      throw error;
    }

    if (!view) return notFound(context, 'Case');
    return context.json(caseStatusLookupResponseSchema.parse(view), 200);
  });
}
