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

/**
 * The six upload states the frontend's document UI renders (consumer-front
 * contract §7). Derived server-side from `document_uploads`; `verifying` is
 * observable because reconciliation writes an intermediate row state before
 * verification completes.
 */
export const draftDocumentStatusSchema = z
  .enum(['uploading', 'verifying', 'verified', 'scan_pending', 'rejected', 'expired'])
  .openapi('DraftDocumentStatus');

/** Sanitized rejection reasons — never scan-engine details. */
export const draftDocumentStatusReasonSchema = z
  .enum(['mime_mismatch', 'malware_detected'])
  .openapi('DraftDocumentStatusReason');

export type DraftDocumentStatus = z.infer<typeof draftDocumentStatusSchema>;
export type DraftDocumentStatusReason = z.infer<typeof draftDocumentStatusReasonSchema>;

export const draftDocumentSchema = z
  .object({
    documentId: uuid,
    category: z.enum(['product_photo', 'proof_of_purchase', 'incident_evidence']),
    fileName: z.string().min(1).max(255),
    status: draftDocumentStatusSchema,
    statusReason: draftDocumentStatusReasonSchema.nullable(),
    uploadedAt: isoDateTime.nullable().openapi({
      description: 'When the bytes landed in Private Blob; null until reconciliation.',
    }),
    lastStatusChangedAt: isoDateTime.openapi({
      description: 'Last lifecycle transition of this document (ISO 8601 UTC).',
    }),
  })
  .openapi('DraftDocument');

export const draftDocumentListResponseSchema = z
  .object({
    documents: z.array(draftDocumentSchema).max(32),
  })
  .openapi('DraftDocumentListResponse');

export type DraftDocument = z.infer<typeof draftDocumentSchema>;
export type DraftDocumentListResponse = z.infer<typeof draftDocumentListResponseSchema>;
