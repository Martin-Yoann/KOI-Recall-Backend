import type { OpenAPIHono } from '@hono/zod-openapi';

import type { ApplicationRegistry } from '../composition.js';
import { campaignResponseSchema, getCampaignRoute } from '../contracts/toc.js';
import type { AppEnv } from '../middleware/request-context.js';
import { isConnectionError } from '../shared/errors.js';
import { dependencyUnavailable, notFound } from './shared.js';

/**
 * Registers the public campaign and product-check routes. Kept as a pure
 * registration function so app.ts only assembles middleware and wiring.
 */
export function registerCampaignRoutes(app: OpenAPIHono<AppEnv>, registry: ApplicationRegistry) {
  app.openapi(getCampaignRoute, async (context) => {
    let campaign;
    try {
      campaign = await registry.services.campaigns.getPublishedCampaign({
        slug: context.req.valid('param').slug,
        locale: context.req.valid('query').locale,
      });
    } catch (error) {
      if (isConnectionError(error)) return dependencyUnavailable(context, 'Campaign retrieval');
      throw error;
    }

    if (!campaign) return notFound(context, 'Campaign');

    const response = campaignResponseSchema.parse({ campaign });
    return context.json(response, 200, {
      'Content-Language': response.campaign.locale,
      ETag: `"v${response.campaign.version}:${response.campaign.locale}"`,
    });
  });
}
