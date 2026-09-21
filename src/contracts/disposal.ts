import { z } from '@hono/zod-openapi';

import { isoDateTime, uuid } from './common.js';

/**
 * The disposal task as a consumer or an operator sees it.
 *
 * `allowedActions` and `blockingReasons` come from the server's policy
 * evaluation. There is deliberately no `canDispose` boolean: a client that could
 * read one would be a client that could derive a permission locally, and the
 * whole point of this domain is that permission is only ever issued by the
 * server after every precondition holds.
 */

export const disposalEligibilityStatusSchema = z
  .enum(['pending_confirmation', 'confirmed_eligible', 'not_applicable', 'ineligible'])
  .openapi('DisposalEligibilityStatus');

export const disposalBatchReviewStatusSchema = z
  .enum(['pending', 'accepted', 'needs_resubmission', 'superseded'])
  .openapi('DisposalBatchReviewStatus');

export const disposalAuthorizationStatusSchema = z
  .enum(['active', 'suspended', 'revoked'])
  .openapi('DisposalAuthorizationStatus');

export const disposalTaskStatusSchema = z
  .enum(['open', 'completed', 'cancelled', 'expired'])
  .openapi('DisposalTaskStatus');

export const disposalInstructionStepSchema = z
  .object({
    order: z.number().int().positive(),
    text: z.string().min(1).max(2000),
  })
  .openapi('DisposalInstructionStep');

export const disposalReferenceImageSchema = z
  .object({
    url: z.string().max(1024),
    /** Required: a step that cannot be described is not accessible. */
    altText: z.string().min(1).max(500),
    caption: z.string().max(500).optional(),
  })
  .openapi('DisposalReferenceImage');

/**
 * The approved content a consumer needs in order to act. Present only when the
 * task may legitimately proceed; withheld while the instruction is unapproved,
 * withdrawn, or not backed by an authorizing approval, so no improvised
 * destruction method can be shown in its place.
 */
export const disposalInstructionViewSchema = z
  .object({
    versionId: uuid,
    versionNumber: z.number().int().positive(),
    locale: z.string().min(2).max(16),
    title: z.string().min(1).max(240),
    steps: z.array(disposalInstructionStepSchema).min(1),
    referenceImages: z.array(disposalReferenceImageSchema),
    videoUrl: z.string().max(1024).nullable(),
    safetyWarnings: z.array(z.string().min(1)).min(1),
    /** What the photo must make identifiable — the reviewer's checklist. */
    recognitionRequirements: z.array(z.string().min(1)),
    declarationTextVersion: z.string().min(1).max(80),
  })
  .openapi('DisposalInstructionView');

export const disposalTaskProductViewSchema = z
  .object({
    campaignProductId: uuid,
    quantity: z.number().int().positive(),
    confirmedAffected: z.boolean(),
  })
  .openapi('DisposalTaskProductView');

export const disposalTaskViewSchema = z
  .object({
    taskId: uuid,
    status: disposalTaskStatusSchema,
    eligibilityStatus: disposalEligibilityStatusSchema,
    /** Action ids the server will accept right now. */
    allowedActions: z.array(z.string()),
    /** Stable codes explaining what is currently blocked. */
    blockingReasons: z.array(z.string()),
    evidenceReviewStatus: disposalBatchReviewStatusSchema.nullable(),
    authorizationStatus: disposalAuthorizationStatusSchema.nullable(),
    holdActive: z.boolean(),
    /** Optimistic token; a stale page cannot decide an old state. */
    version: z.number().int().positive(),
    products: z.array(disposalTaskProductViewSchema),
    instruction: disposalInstructionViewSchema.nullable(),
    expiresAt: isoDateTime,
  })
  .openapi('DisposalTaskView');

export type DisposalTaskView = z.infer<typeof disposalTaskViewSchema>;
export type DisposalInstructionView = z.infer<typeof disposalInstructionViewSchema>;

/** Admin queue row. Carries no raw image bytes and no access tokens. */
export const disposalQueueRowSchema = z
  .object({
    taskId: uuid,
    caseReference: z.string().nullable(),
    eligibilityStatus: disposalEligibilityStatusSchema,
    instructionVersionNumber: z.number().int().positive().nullable(),
    evidenceReviewStatus: disposalBatchReviewStatusSchema.nullable(),
    authorizationStatus: disposalAuthorizationStatusSchema.nullable(),
    holdActive: z.boolean(),
    blockingReasons: z.array(z.string()),
    productCount: z.number().int().nonnegative(),
    createdAt: isoDateTime,
  })
  .openapi('DisposalQueueRow');

export const disposalQueueResponseSchema = z
  .object({
    tasks: z.array(disposalQueueRowSchema),
    total: z.number().int().nonnegative(),
  })
  .openapi('DisposalQueueResponse');

export const confirmDisposalEligibilityRequestSchema = z
  .object({
    eligibilityStatus: z.enum(['confirmed_eligible', 'not_applicable', 'ineligible']),
    note: z.string().min(10).max(2000),
    expectedVersion: z.number().int().positive(),
  })
  .openapi('ConfirmDisposalEligibilityRequest');

export const submitDisposalEvidenceRequestSchema = z
  .object({
    documents: z
      .array(
        z.object({
          documentId: uuid,
          campaignProductId: uuid.optional(),
          quantityCovered: z.number().int().positive().optional(),
        }),
      )
      .min(1)
      .max(20),
  })
  .openapi('SubmitDisposalEvidenceRequest');

export const reviewDisposalBatchRequestSchema = z
  .object({
    decision: z.enum(['accepted', 'needs_resubmission']),
    rationale: z.string().min(10).max(2000),
    /** Required when asking for a resubmission; the consumer needs a reason. */
    reasonCode: z
      .enum([
        'recognition_unclear',
        'coverage_insufficient',
        'photo_unreadable',
        'wrong_product',
        'safety_step_not_visible',
        'other',
      ])
      .optional(),
  })
  .openapi('ReviewDisposalBatchRequest');

export const disposalEvidenceBatchResponseSchema = z
  .object({
    batchId: uuid,
    reviewStatus: disposalBatchReviewStatusSchema,
  })
  .openapi('DisposalEvidenceBatchResponse');

export const disposalAuthorizationResponseSchema = z
  .object({
    authorizationId: uuid,
    status: disposalAuthorizationStatusSchema,
  })
  .openapi('DisposalAuthorizationResponse');

export const recordDisposalDeclarationRequestSchema = z
  .object({
    declarationTextVersion: z.string().min(1).max(80),
    authorizationId: uuid.optional(),
    exceptionType: z
      .enum(['already_disposed_before_authorization', 'evidence_unavailable', 'other'])
      .optional(),
    exceptionNote: z.string().min(1).max(2000).optional(),
  })
  .openapi('RecordDisposalDeclarationRequest');

export const disposalHoldRequestSchema = z
  .object({
    reason: z.enum(['incident_evidence_retention', 'compliance_investigation', 'other']),
    note: z.string().min(10).max(2000),
  })
  .openapi('DisposalHoldRequest');

export const releaseDisposalHoldRequestSchema = z
  .object({
    note: z.string().min(10).max(2000),
  })
  .openapi('ReleaseDisposalHoldRequest');

export const disposalInstructionSummarySchema = z
  .object({
    id: uuid,
    campaignVersionId: uuid,
    versionNumber: z.number().int().positive(),
    locale: z.string().min(2).max(16),
    status: z.enum(['draft', 'approved', 'withdrawn']),
    title: z.string().min(1).max(240),
    /** True only when a live approval authorizes consumer disposal. */
    authorizesConsumerDisposal: z.boolean(),
    approvalCount: z.number().int().nonnegative(),
  })
  .openapi('DisposalInstructionSummary');

export const disposalInstructionListResponseSchema = z
  .object({ versions: z.array(disposalInstructionSummarySchema) })
  .openapi('DisposalInstructionListResponse');

export type DisposalQueueRow = z.infer<typeof disposalQueueRowSchema>;
