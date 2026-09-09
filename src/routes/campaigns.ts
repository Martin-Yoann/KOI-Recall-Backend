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

/**
 * Published campaign content is immutable per version and carries no PII, so
 * browsers (max-age) and the edge (s-maxage) may cache it. Publishing a new
 * version changes the ETag on its own — no invalidation is needed. This is
 * the only toC read whose response may enter shared caches; PII-bearing
 * endpoints must never set Cache-Control.
 */
const CAMPAIGN_CACHE_CONTROL = 'public, max-age=60, s-maxage=600, stale-while-revalidate=300';

/** Weak If-None-Match comparison against the response ETag (RFC 9110 §13.1.2). */
function ifNoneMatchMatches(headerValue: string | undefined, etag: string): boolean {
  if (!headerValue) return false;
  return headerValue.split(',').some((candidate) => {
    const trimmed = candidate.trim();
    if (trimmed === '*') return true;
    return trimmed.replace(/^W\//, '') === etag;
  });
}

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
    const headers = {
      'Content-Language': response.campaign.locale,
      ETag: `"v${response.campaign.version}:${response.campaign.locale}"`,
      'Cache-Control': CAMPAIGN_CACHE_CONTROL,
    };
    // Revalidation necessarily happens after the DB read — the current
    // published version is only known post-fetch — so a 304 saves the
    // payload, not the queries. The edge (s-maxage) is what keeps the
    // origin load down.
    if (ifNoneMatchMatches(context.req.header('If-None-Match'), headers.ETag)) {
      return context.body(null, 304, headers);
    }
    return context.json(response, 200, headers);
  });
}
