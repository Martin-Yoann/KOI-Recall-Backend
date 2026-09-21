import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';

import { campaignProducts, campaignVersions } from './campaigns.js';
import { claimDrafts, recallCases } from './claims.js';
import { documentUploads } from './documents.js';
import { staffUsers } from './staff.js';

/**
 * Consumer product-disposal workflow.
 *
 * Five facts are kept structurally distinct because collapsing any two of them
 * is the failure mode this domain exists to prevent:
 *
 *   1. product confirmed affected      -> `disposal_tasks.eligibility_status`
 *   2. instructions approved           -> `disposal_instruction_versions` + approvals
 *   3. photo technically verified      -> `document_uploads.upload_status` (existing)
 *   4. photo accepted by a human       -> `disposal_reviews`
 *   5. disposal permitted              -> `disposal_authorizations`
 *
 * A consumer declaration then records what actually happened. Two invariants are
 * enforced by CHECK constraints rather than by application code, so no role,
 * endpoint, or direct SQL statement can bypass them — see the comments on
 * `disposalInstructionApprovals` and `disposalDeclarations`.
 */

const timestamps = {
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
};

export const disposalInstructionStatusEnum = pgEnum('disposal_instruction_status', [
  'draft',
  'approved',
  'withdrawn',
]);

/**
 * The material a decision rests on. The non-authorizing members are real and
 * must be recordable — the point is that they are recorded *as* non-authorizing,
 * never converted into consumer-disposal permission.
 */
export const disposalApprovalMaterialEnum = pgEnum('disposal_approval_material', [
  'recall_expectation_letter',
  'cap_or_written_coordination',
  'nov',
  'laboratory_report',
  'form_332_inventory_procedure',
  'cbp_seizure_record',
  'other',
]);

export const disposalApprovalScopeEnum = pgEnum('disposal_approval_scope', [
  'consumer_held_product',
  'enterprise_inventory',
  'port_involved_goods',
  'not_determined',
]);

/** The corrective measure the approval actually selects. */
export const disposalMeasureEnum = pgEnum('disposal_measure', [
  'consumer_disposal',
  'consumer_return',
  'professional_recycling',
  'other_compensation',
  'not_determined',
]);

export const disposalEligibilityStatusEnum = pgEnum('disposal_eligibility_status', [
  'pending_confirmation',
  'confirmed_eligible',
  'not_applicable',
  'ineligible',
]);

export const disposalTaskStatusEnum = pgEnum('disposal_task_status', [
  'open',
  'completed',
  'cancelled',
  'expired',
]);

export const disposalBatchReviewStatusEnum = pgEnum('disposal_batch_review_status', [
  'pending',
  'accepted',
  'needs_resubmission',
  'superseded',
]);

export const disposalReviewDecisionEnum = pgEnum('disposal_review_decision', [
  'accepted',
  'needs_resubmission',
]);

export const disposalAuthorizationStatusEnum = pgEnum('disposal_authorization_status', [
  'active',
  'suspended',
  'revoked',
]);

export const disposalHoldReasonEnum = pgEnum('disposal_hold_reason', [
  'incident_evidence_retention',
  'compliance_investigation',
  'other',
]);

export const disposalDeclarationExceptionEnum = pgEnum('disposal_declaration_exception', [
  'already_disposed_before_authorization',
  'evidence_unavailable',
  'other',
]);

/** One approved step. `altText` is required with an image so the step is usable non-visually. */
export interface DisposalInstructionStep {
  order: number;
  text: string;
}

export interface DisposalReferenceImage {
  url: string;
  altText: string;
  caption?: string | undefined;
}

/**
 * Immutable, campaign-version-scoped instructions telling a consumer how to
 * dispose of a recalled product.
 *
 * Edits never mutate an approved row: a correction is a new version, so a task
 * pinned to version N keeps meaning what it meant when it was issued. Pinning
 * uses `onDelete: 'restrict'` for the same reason `claim_drafts` does — a
 * version referenced by a task must not be deletable out from under it.
 */
export const disposalInstructionVersions = pgTable(
  'disposal_instruction_versions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    campaignVersionId: uuid('campaign_version_id')
      .notNull()
      .references(() => campaignVersions.id, { onDelete: 'restrict' }),
    versionNumber: integer('version_number').notNull(),
    locale: varchar('locale', { length: 16 }).notNull(),
    status: disposalInstructionStatusEnum('status').notNull().default('draft'),
    title: varchar('title', { length: 240 }).notNull(),
    steps: jsonb('steps').$type<DisposalInstructionStep[]>().notNull(),
    referenceImages: jsonb('reference_images').$type<DisposalReferenceImage[]>().notNull(),
    /** Optional, and only useful with captions or a transcript (accessibility). */
    videoUrl: text('video_url'),
    safetyWarnings: jsonb('safety_warnings').$type<string[]>().notNull(),
    /** What the photo must make identifiable; the reviewer's checklist. */
    recognitionRequirements: jsonb('recognition_requirements').$type<string[]>().notNull(),
    /** Version of the consumer statement text this instruction is paired with. */
    declarationTextVersion: varchar('declaration_text_version', { length: 80 }).notNull(),
    approvedAt: timestamp('approved_at', { withTimezone: true, mode: 'date' }),
    approvedByStaffUserId: uuid('approved_by_staff_user_id').references(() => staffUsers.id, {
      onDelete: 'set null',
    }),
    withdrawnAt: timestamp('withdrawn_at', { withTimezone: true, mode: 'date' }),
    withdrawnByStaffUserId: uuid('withdrawn_by_staff_user_id').references(() => staffUsers.id, {
      onDelete: 'set null',
    }),
    withdrawalReason: text('withdrawal_reason'),
    ...timestamps,
  },
  (table) => [
    uniqueIndex('disposal_instruction_versions_identity_uidx').on(
      table.campaignVersionId,
      table.locale,
      table.versionNumber,
    ),
    index('disposal_instruction_versions_status_idx').on(table.campaignVersionId, table.status),
    check('disposal_instruction_versions_number_chk', sql`${table.versionNumber} > 0`),
    check('disposal_instruction_versions_steps_chk', sql`jsonb_array_length(${table.steps}) > 0`),
    check(
      'disposal_instruction_versions_warnings_chk',
      sql`jsonb_array_length(${table.safetyWarnings}) > 0`,
    ),
    check(
      'disposal_instruction_versions_approved_chk',
      sql`${table.status} <> 'approved' or (${table.approvedAt} is not null and ${table.approvedByStaffUserId} is not null)`,
    ),
    check(
      'disposal_instruction_versions_withdrawn_chk',
      sql`(${table.status} = 'withdrawn') = (${table.withdrawnAt} is not null)`,
    ),
  ],
);

/**
 * Why we are allowed to tell a consumer to dispose of the product.
 *
 * `authorizesConsumerDisposal` is denormalized on purpose, and the CHECK pins it
 * to a pure function of (material, scope, measure). A Notice of Violation, a lab
 * report, a Form 332 inventory procedure, or a CBP seizure record can be stored
 * — the history matters — but the algebra makes it impossible to store any of
 * them as a consumer-disposal permission. That closes the requirement at the
 * data layer instead of hoping every caller checks first.
 */
export const disposalInstructionApprovals = pgTable(
  'disposal_instruction_approvals',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    instructionVersionId: uuid('instruction_version_id')
      .notNull()
      .references(() => disposalInstructionVersions.id, { onDelete: 'restrict' }),
    materialType: disposalApprovalMaterialEnum('material_type').notNull(),
    scope: disposalApprovalScopeEnum('scope').notNull(),
    measure: disposalMeasureEnum('measure').notNull(),
    authorizesConsumerDisposal: boolean('authorizes_consumer_disposal').notNull(),
    /** Letter/CAP/report reference; never a credential. */
    referenceText: varchar('reference_text', { length: 200 }),
    effectiveFrom: timestamp('effective_from', { withTimezone: true, mode: 'date' }),
    effectiveUntil: timestamp('effective_until', { withTimezone: true, mode: 'date' }),
    recordedByStaffUserId: uuid('recorded_by_staff_user_id').references(() => staffUsers.id, {
      onDelete: 'set null',
    }),
    recordedAt: timestamp('recorded_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
    withdrawnAt: timestamp('withdrawn_at', { withTimezone: true, mode: 'date' }),
    withdrawalReason: text('withdrawal_reason'),
    ...timestamps,
  },
  (table) => [
    index('disposal_instruction_approvals_version_idx').on(
      table.instructionVersionId,
      table.authorizesConsumerDisposal,
    ),
    check(
      'disposal_instruction_approvals_authorizing_chk',
      sql`${table.authorizesConsumerDisposal} = (
            ${table.measure} = 'consumer_disposal'
            and ${table.scope} = 'consumer_held_product'
            and ${table.materialType} in ('recall_expectation_letter', 'cap_or_written_coordination')
          )`,
    ),
    check(
      'disposal_instruction_approvals_effective_chk',
      sql`${table.effectiveUntil} is null or ${table.effectiveFrom} is null or ${table.effectiveUntil} > ${table.effectiveFrom}`,
    ),
    check(
      'disposal_instruction_approvals_withdrawn_chk',
      sql`${table.withdrawnAt} is null or ${table.withdrawalReason} is not null`,
    ),
  ],
);

/**
 * A consumer's disposal work item. Always bound to a draft (the pre-submission
 * work item, which survives submission), with `caseId` filled in once a case
 * exists — hence nullable.
 */
export const disposalTasks = pgTable(
  'disposal_tasks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    instructionVersionId: uuid('instruction_version_id')
      .notNull()
      .references(() => disposalInstructionVersions.id, { onDelete: 'restrict' }),
    draftId: uuid('draft_id').references(() => claimDrafts.id, { onDelete: 'set null' }),
    caseId: uuid('case_id').references(() => recallCases.id, { onDelete: 'set null' }),
    /**
     * Visitor access credential. Only the hash is stored: a leaked database row
     * must not hand anyone the ability to read another person's private photos.
     */
    tokenHash: varchar('token_hash', { length: 64 }).notNull(),
    tokenExpiresAt: timestamp('token_expires_at', { withTimezone: true, mode: 'date' }).notNull(),
    eligibilityStatus: disposalEligibilityStatusEnum('eligibility_status')
      .notNull()
      .default('pending_confirmation'),
    eligibilityConfirmedByStaffUserId: uuid('eligibility_confirmed_by_staff_user_id').references(
      () => staffUsers.id,
      { onDelete: 'set null' },
    ),
    eligibilityConfirmedAt: timestamp('eligibility_confirmed_at', {
      withTimezone: true,
      mode: 'date',
    }),
    eligibilityNote: text('eligibility_note'),
    status: disposalTaskStatusEnum('status').notNull().default('open'),
    /** Optimistic concurrency token, mirroring `case_resolutions.version`. */
    version: integer('version').notNull().default(1),
    ...timestamps,
  },
  (table) => [
    index('disposal_tasks_draft_idx').on(table.draftId),
    index('disposal_tasks_case_idx').on(table.caseId),
    index('disposal_tasks_token_idx').on(table.tokenHash),
    // A duplicate request must not open a second effective task for the same
    // draft at the same instruction version. Terminal tasks are excluded so the
    // history of a completed or cancelled task never blocks a legitimate retry.
    uniqueIndex('disposal_tasks_open_uidx')
      .on(table.draftId, table.instructionVersionId)
      .where(sql`${table.status} = 'open'`),
    check(
      'disposal_tasks_owner_chk',
      sql`${table.draftId} is not null or ${table.caseId} is not null`,
    ),
    check(
      'disposal_tasks_eligibility_confirmed_chk',
      sql`${table.eligibilityStatus} <> 'confirmed_eligible' or (${table.eligibilityConfirmedAt} is not null and ${table.eligibilityConfirmedByStaffUserId} is not null)`,
    ),
    // "Ineligible" and "not applicable" are findings about a product, so they
    // carry the same confirmation evidence as eligibility itself.
    check(
      'disposal_tasks_eligibility_decided_chk',
      sql`${table.eligibilityStatus} = 'pending_confirmation' or (${table.eligibilityConfirmedAt} is not null and ${table.eligibilityConfirmedByStaffUserId} is not null)`,
    ),
  ],
);

/** Which products, lots, and quantities a task covers, and whether each is confirmed. */
export const disposalTaskProducts = pgTable(
  'disposal_task_products',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    taskId: uuid('task_id')
      .notNull()
      .references(() => disposalTasks.id, { onDelete: 'cascade' }),
    campaignProductId: uuid('campaign_product_id')
      .notNull()
      .references(() => campaignProducts.id, { onDelete: 'restrict' }),
    lotCode: varchar('lot_code', { length: 80 }),
    dateCode: varchar('date_code', { length: 40 }),
    quantity: integer('quantity').notNull().default(1),
    confirmedAffected: boolean('confirmed_affected').notNull().default(false),
    ...timestamps,
  },
  (table) => [
    // coalesce() because Postgres treats NULLs as distinct in a unique index,
    // which would otherwise let the same product be added twice when no lot is
    // recorded.
    uniqueIndex('disposal_task_products_identity_uidx').on(
      table.taskId,
      table.campaignProductId,
      sql`coalesce(${table.lotCode}, '')`,
      sql`coalesce(${table.dateCode}, '')`,
    ),
    check('disposal_task_products_quantity_chk', sql`${table.quantity} > 0`),
  ],
);

/**
 * One photo submission for human review.
 *
 * `retentionUntil` is what keeps the draft-cleanup worker off evidence that is
 * under review: the worker has no other way to tell a disposable temporary
 * upload from evidence a person still needs to look at.
 */
export const disposalEvidenceBatches = pgTable(
  'disposal_evidence_batches',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    taskId: uuid('task_id')
      .notNull()
      .references(() => disposalTasks.id, { onDelete: 'cascade' }),
    batchNumber: integer('batch_number').notNull(),
    reviewStatus: disposalBatchReviewStatusEnum('review_status').notNull().default('pending'),
    retentionUntil: timestamp('retention_until', { withTimezone: true, mode: 'date' }),
    idempotencyKeyHash: varchar('idempotency_key_hash', { length: 64 }).notNull(),
    submittedAt: timestamp('submitted_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
    ...timestamps,
  },
  (table) => [
    uniqueIndex('disposal_evidence_batches_number_uidx').on(table.taskId, table.batchNumber),
    uniqueIndex('disposal_evidence_batches_idempotency_uidx').on(table.idempotencyKeyHash),
    index('disposal_evidence_batches_status_idx').on(table.reviewStatus, table.submittedAt),
    check('disposal_evidence_batches_number_chk', sql`${table.batchNumber} > 0`),
  ],
);

/**
 * The attachments a batch covers.
 *
 * `documentId` is globally unique: one uploaded file belongs to exactly one
 * batch, which structurally prevents a photo from one person or campaign being
 * re-used to satisfy another's review.
 */
export const disposalEvidenceBatchDocuments = pgTable(
  'disposal_evidence_batch_documents',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    batchId: uuid('batch_id')
      .notNull()
      .references(() => disposalEvidenceBatches.id, { onDelete: 'cascade' }),
    documentId: uuid('document_id')
      .notNull()
      .references(() => documentUploads.id, { onDelete: 'restrict' }),
    /** Null means the photo covers every confirmed product on the task. */
    campaignProductId: uuid('campaign_product_id').references(() => campaignProducts.id, {
      onDelete: 'restrict',
    }),
    quantityCovered: integer('quantity_covered'),
    ...timestamps,
  },
  (table) => [
    uniqueIndex('disposal_evidence_batch_documents_document_uidx').on(table.documentId),
    index('disposal_evidence_batch_documents_batch_idx').on(table.batchId),
    check(
      'disposal_evidence_batch_documents_quantity_chk',
      sql`${table.quantityCovered} is null or ${table.quantityCovered} > 0`,
    ),
  ],
);

/**
 * The human business decision on a batch. One terminal decision per batch
 * (`uniqueIndex` on batchId), so a resubmission cannot overwrite the earlier
 * verdict — it arrives as a new batch with its own review.
 */
export const disposalReviews = pgTable(
  'disposal_reviews',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    batchId: uuid('batch_id')
      .notNull()
      .references(() => disposalEvidenceBatches.id, { onDelete: 'cascade' }),
    decision: disposalReviewDecisionEnum('decision').notNull(),
    reasonCode: varchar('reason_code', { length: 40 }),
    rationale: text('rationale').notNull(),
    reviewerStaffUserId: uuid('reviewer_staff_user_id').references(() => staffUsers.id, {
      onDelete: 'set null',
    }),
    /** Snapshot so history survives a later role change, as in admin_audit_events. */
    reviewerRole: varchar('reviewer_role', { length: 24 }),
    decidedAt: timestamp('decided_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    ...timestamps,
  },
  (table) => [
    uniqueIndex('disposal_reviews_batch_uidx').on(table.batchId),
    check('disposal_reviews_rationale_chk', sql`length(${table.rationale}) >= 10`),
  ],
);

/** Server-issued permission to dispose, resting on one accepted batch. */
export const disposalAuthorizations = pgTable(
  'disposal_authorizations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    taskId: uuid('task_id')
      .notNull()
      .references(() => disposalTasks.id, { onDelete: 'cascade' }),
    batchId: uuid('batch_id')
      .notNull()
      .references(() => disposalEvidenceBatches.id, { onDelete: 'cascade' }),
    /** Pinned so a withdrawal can find exactly which authorizations to suspend. */
    instructionVersionId: uuid('instruction_version_id')
      .notNull()
      .references(() => disposalInstructionVersions.id, { onDelete: 'restrict' }),
    status: disposalAuthorizationStatusEnum('status').notNull().default('active'),
    issuedAt: timestamp('issued_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    revokedAt: timestamp('revoked_at', { withTimezone: true, mode: 'date' }),
    revokedByStaffUserId: uuid('revoked_by_staff_user_id').references(() => staffUsers.id, {
      onDelete: 'set null',
    }),
    revokeReason: text('revoke_reason'),
    ...timestamps,
  },
  (table) => [
    index('disposal_authorizations_task_idx').on(table.taskId),
    index('disposal_authorizations_version_idx').on(table.instructionVersionId, table.status),
    // Re-reviewing the same batch must not mint a second live permission.
    uniqueIndex('disposal_authorizations_active_uidx')
      .on(table.taskId, table.batchId)
      .where(sql`${table.status} = 'active'`),
    check(
      'disposal_authorizations_revoked_chk',
      sql`${table.status} <> 'revoked' or (${table.revokedAt} is not null and ${table.revokeReason} is not null)`,
    ),
  ],
);

/**
 * What the consumer says happened.
 *
 * The CHECK requires exactly one of an authorization or an exception. That makes
 * "declared complete" without either impossible to store, and gives a consumer
 * who already disposed of the product before authorization a way to report the
 * truth instead of forcing a back-dated permission into existence.
 */
export const disposalDeclarations = pgTable(
  'disposal_declarations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    taskId: uuid('task_id')
      .notNull()
      .references(() => disposalTasks.id, { onDelete: 'cascade' }),
    authorizationId: uuid('authorization_id').references(() => disposalAuthorizations.id, {
      onDelete: 'cascade',
    }),
    exceptionType: disposalDeclarationExceptionEnum('exception_type'),
    exceptionNote: text('exception_note'),
    declarationTextVersion: varchar('declaration_text_version', { length: 80 }).notNull(),
    /** Server clock; the client cannot supply a time. */
    recordedAt: timestamp('recorded_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
    ...timestamps,
  },
  (table) => [
    uniqueIndex('disposal_declarations_authorization_uidx').on(table.authorizationId),
    index('disposal_declarations_task_idx').on(table.taskId),
    check(
      'disposal_declarations_basis_chk',
      sql`(${table.authorizationId} is not null) <> (${table.exceptionType} is not null)`,
    ),
    check(
      'disposal_declarations_exception_note_chk',
      sql`${table.exceptionType} is null or ${table.exceptionNote} is not null`,
    ),
  ],
);

/**
 * Append-only evidence-retention holds. Current hold state is "an unreleased
 * row exists"; releasing sets `releasedAt` and never deletes, so the fact that a
 * pause was once in force survives.
 *
 * Deliberately independent of `reportability_reviews.status`: an open safety
 * review is a reason to *place* a hold, never a reason to lift one.
 *
 * Cascade rule for this whole file: every reference *inside* a task's subtree
 * cascades from the task, so removing a task can never half-succeed. `restrict`
 * is reserved for references pointing *out* of the subtree — instruction
 * versions, campaign products, uploaded documents, staff accounts — because
 * those are content an accidental delete must fail loudly on. Deleting a task is
 * not a product operation (tasks are cancelled, never removed); the cascade
 * exists so test and maintenance cleanup stays coherent.
 */
export const disposalHolds = pgTable(
  'disposal_holds',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    taskId: uuid('task_id')
      .notNull()
      .references(() => disposalTasks.id, { onDelete: 'cascade' }),
    reason: disposalHoldReasonEnum('reason').notNull(),
    note: text('note'),
    /** Null for a system-placed hold (e.g. the automatic incident retention pause). */
    placedByStaffUserId: uuid('placed_by_staff_user_id').references(() => staffUsers.id, {
      onDelete: 'set null',
    }),
    placedAt: timestamp('placed_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    releasedByStaffUserId: uuid('released_by_staff_user_id').references(() => staffUsers.id, {
      onDelete: 'set null',
    }),
    releasedAt: timestamp('released_at', { withTimezone: true, mode: 'date' }),
    releaseNote: text('release_note'),
    ...timestamps,
  },
  (table) => [
    index('disposal_holds_task_idx').on(table.taskId, table.releasedAt),
    check(
      'disposal_holds_release_chk',
      sql`${table.releasedAt} is null or ${table.releasedByStaffUserId} is not null`,
    ),
  ],
);
