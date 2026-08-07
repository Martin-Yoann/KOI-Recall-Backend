import { z } from '@hono/zod-openapi';

import { isoDateTime, uuid } from './common.js';

export const claimDraftResponseSchema = z
  .object({
    draftId: uuid,
    draftToken: z.string().min(32),
    expiresAt: isoDateTime,
  })
  .openapi('ClaimDraftResponse');

/**
 * The created draft returned to consumers. Derived from the Zod contract so the
 * service and route handler share one shape.
 */
export type ClaimDraftResponse = z.infer<typeof claimDraftResponseSchema>;

export const draftTokenHeaderSchema = z.object({
  'X-Draft-Token': z
    .string()
    .min(32)
    .openapi({
      param: { name: 'X-Draft-Token', in: 'header' },
    }),
});

export const uploadTokenRequestSchema = z
  .object({
    category: z.enum(['product_photo', 'proof_of_purchase', 'incident_evidence']),
    fileName: z.string().min(1).max(255),
    mimeType: z.string().min(3).max(120),
    sizeBytes: z.number().int().positive(),
  })
  .openapi('UploadTokenRequest');

export const uploadTokenResponseSchema = z
  .object({
    documentId: uuid,
    pathname: z
      .string()
      .min(1)
      .max(1024)
      .regex(/^drafts\/[^/]+\/[^/]+\//),
    clientToken: z.string(),
    expiresAt: isoDateTime,
  })
  .openapi('UploadTokenResponse');
