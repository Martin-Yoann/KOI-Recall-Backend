import type { OpenAPIHono } from '@hono/zod-openapi';

import type { ApplicationRegistry } from '../composition.js';
import {
  productCheckResponseSchema,
  productCheckRoute,
  type ProductCheckRequest,
  type ProductCheckResponse,
} from '../contracts/toc.js';
import type { AppEnv } from '../middleware/request-context.js';
import type {
  IdentificationInput,
  IdentificationResult,
} from '../modules/product-identification/policy.js';
import { isConnectionError } from '../shared/errors.js';
import { dependencyUnavailable, notFound } from './shared.js';

/**
 * Maps the discriminated-union request body onto the Policy's identification
 * input. `purchase_evidence` signals are passed through as corroboration
 * (V1.1/O3.1); `product_identifiers` values become normalized lookups; legacy
 * shape/flavor/lot/date are carried as-is for the M1–M3 dual-read path.
 */
function toIdentificationInput(slug: string, body: ProductCheckRequest): IdentificationInput {
  switch (body.mode) {
    case 'product_identifiers':
      return {
        mode: 'product_identifiers',
        campaignSlug: slug,
        signals: {
          identifiers: body.identifiers.map((identifier) => identifier.value),
          purchaseEvidence: body.purchaseEvidence,
        },
      };
    case 'purchase_evidence':
      return {
        mode: 'purchase_evidence',
        campaignSlug: slug,
        signals: { purchaseEvidence: body.purchaseEvidence },
      };
    case 'unknown':
      return {
        mode: 'unknown',
        campaignSlug: slug,
        signals: { purchaseEvidence: body.purchaseEvidence },
      };
  }
}

/** Derives the consumer-facing messageKey from the policy result (ADR-0002 §2.4). */
function messageKeyFor(result: IdentificationResult): ProductCheckResponse['messageKey'] {
  if (result.result === 'potential_match') return 'product_check.potential_match';
  if (result.reasonCodes.includes('identifier.ambiguous_multi_match')) {
    return 'product_check.manual_review.ambiguous';
  }
  if (result.result === 'not_matched') return 'product_check.not_matched';
  return 'product_check.manual_review.insufficient_signals';
}

/**
 * Registers the preliminary affected-product check route. The route only maps
 * HTTP shapes; all triage lives in the shared ProductIdentificationPolicy.
 */
export function registerProductCheckRoutes(
  app: OpenAPIHono<AppEnv>,
  registry: ApplicationRegistry,
) {
  app.openapi(productCheckRoute, async (context) => {
    let result;
    try {
      result = await registry.services.productChecks.check(
        toIdentificationInput(context.req.valid('param').slug, context.req.valid('json')),
      );
    } catch (error) {
      if (isConnectionError(error)) return dependencyUnavailable(context, 'Product checking');
      throw error;
    }

    if (!result) return notFound(context, 'Campaign');

    const response = productCheckResponseSchema.parse({
      ...result,
      identificationMode: context.req.valid('json').mode,
      messageKey: messageKeyFor(result),
      disclaimer: 'This check is preliminary and is not a final eligibility decision.',
    });
    return context.json(response, 200);
  });
}
