import { z } from '@hono/zod-openapi';

export const productCheckRequestSchema = z
  .object({
    shape: z.string().min(1).max(80),
    flavor: z.string().min(1).max(80),
    lotCode: z.string().min(1).max(80),
    dateCode: z.string().min(1).max(40),
  })
  .openapi('ProductCheckRequest');

export const productCheckResponseSchema = z
  .object({
    result: z.enum(['potential_match', 'not_matched', 'manual_review']),
    message: z.string(),
    checkedCampaignVersion: z.number().int().positive(),
    disclaimer: z.literal('This check is preliminary and is not a final eligibility decision.'),
  })
  .openapi('ProductCheckResponse');

/**
 * The preliminary product-check result returned to consumers. Derived from the
 * Zod contract so the service and route handler share one shape.
 */
export type ProductCheckResponse = z.infer<typeof productCheckResponseSchema>;
