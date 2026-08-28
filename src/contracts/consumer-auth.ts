import { z } from '@hono/zod-openapi';

/**
 * Legacy consumer claim lookup (`GET /v1/consumer-auth/lookup/{claimNumber}`).
 * Contract-complete definition added so the endpoint can be formally marked
 * `deprecated` in the published OpenAPI document; consumers of this shape must
 * migrate to `POST /v1/case-status-lookups`, which returns a PII-free
 * whitelist instead. The response schema documents what the handler returns
 * today — sensitive fields are part of why it is being retired.
 */

export const legacyConsumerClaimStatusSchema = z
  .enum([
    'submitted',
    'under_review',
    'action_required',
    // `verified` is no longer produced (need_info now maps to action_required);
    // it stays in the published enum so older cached clients keep validating.
    'verified',
    'remedy_issued',
    'resolved',
    'rejected',
  ])
  .openapi('LegacyConsumerClaimStatus');

export const legacyConsumerClaimSchema = z
  .object({
    id: z.string().uuid(),
    claimNumber: z.string(),
    caseRef: z.string(),
    campaignId: z.string().uuid(),
    campaignTitle: z.string(),
    campaignSlug: z.string(),
    consumerName: z.string(),
    consumerEmail: z.string(),
    consumerPhone: z.string(),
    productName: z.string(),
    shape: z.string().optional(),
    flavor: z.string().optional(),
    lotCode: z.string().optional(),
    dateCode: z.string().optional(),
    remedyId: z.string(),
    remedyTitle: z.string(),
    remedyType: z.string(),
    refundAmount: z.number().optional(),
    status: legacyConsumerClaimStatusSchema,
    infoRequest: z.string().optional(),
    evidenceCount: z.number().int(),
    submittedAt: z.string(),
    updatedAt: z.string(),
    resolutionDate: z.string().optional(),
  })
  .openapi('LegacyConsumerClaim');

export const legacyConsumerClaimLookupResponseSchema = z
  .object({
    claim: legacyConsumerClaimSchema,
    campaignTitle: z.string(),
    productName: z.string(),
    remedyTitle: z.string(),
    remedyType: z.string(),
    refundAmount: z.number().optional(),
  })
  .openapi('LegacyConsumerClaimLookupResponse');
