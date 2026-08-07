import type { OpenAPIHono } from '@hono/zod-openapi';

import type { ApplicationRegistry } from '../composition.js';
import { productCheckResponseSchema, productCheckRoute } from '../contracts/toc.js';
import type { AppEnv } from '../middleware/request-context.js';
import { isConnectionError } from '../shared/errors.js';
import { dependencyUnavailable, notFound } from './shared.js';

/**
 * Registers the preliminary affected-product check route.
 */
export function registerProductCheckRoutes(
  app: OpenAPIHono<AppEnv>,
  registry: ApplicationRegistry,
) {
  app.openapi(productCheckRoute, async (context) => {
    let result;
    try {
      result = await registry.services.productChecks.check({
        campaignSlug: context.req.valid('param').slug,
        ...context.req.valid('json'),
      });
    } catch (error) {
      if (isConnectionError(error)) return dependencyUnavailable(context, 'Product checking');
      throw error;
    }

    if (!result) return notFound(context, 'Campaign');

    const response = productCheckResponseSchema.parse({
      ...result,
      disclaimer: 'This check is preliminary and is not a final eligibility decision.',
    });
    return context.json(response, 200);
  });
}
