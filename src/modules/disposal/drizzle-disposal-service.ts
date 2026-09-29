import { and, asc, desc, eq, gt, inArray, isNull, ne, sql } from 'drizzle-orm';

import type { CommunicationQueueService } from '../communications/queue-service.js';
import { getLatestTemplateVersionId } from '../communications/template-loader.js';

import {
  disposalReviewReasonCodeSchema,
  type DisposalInstructionView,
} from '../../contracts/disposal.js';
import type { DatabaseExecutor, DatabaseHandle } from '../../db/client.js';
import {
  disposalAuthorizationItems,
  disposalAuthorizations,
  disposalDeclarations,
  disposalEvidenceBatchDocuments,
  disposalEvidenceBatches,
  disposalHolds,
  disposalInstructionApprovals,
  disposalInstructionVersions,
  disposalReviews,
  disposalTasks,
  disposalTaskProducts,
  caseConsumers,
  documentUploads,
  appSettings,
  recallCases,
} from '../../db/schema/index.js';
import { consoleSafeLogger } from '../../platform/observability/logger.js';
import {
  ClaimValidationError,
  ClaimConflictError,
  DataIntegrityError,
  EmailTemplateMissingError,
  ResourceNotFoundError,
} from '../../shared/errors.js';
import {
  deriveDocumentStatus,
  LISTED_UPLOAD_STATUSES,
  type ListedUploadStatus,
} from '../documents/document-status.js';
import { notUnderEvidenceRetention } from './retention.js';
import {
  assertCanIssueAuthorization,
  approvalWindowIncludes,
  authorizesConsumerDisposal,
  evaluateDisposal,
  type DisposalPolicySnapshot,
  type DisposalPolicyState,
} from './policy.js';
import {
  generateTaskToken,
  hashTaskToken,
  type ConfirmEligibilityInput,
  type CreateInstructionVersionInput,
  type DisposalQueueRowView,
  type DisposalService,
  type DisposalBatchForAdmin,
  type DisposalHoldView,
  type DisposalInstructionChecklistView,
  type DisposalTaskAdminDetail,
  type EvidenceDocumentSummary,
  type InstructionVersionSummary,
  type RecordInstructionApprovalInput,
  type DisposalTaskDetail,
  type DisposalTaskProductRecord,
  type DisposalTaskRecord,
  type PlaceHoldInput,
  type RecordDeclarationInput,
  type ReleaseHoldInput,
  type ReviewBatchInput,
  type SubmitEvidenceBatchInput,
  type WithdrawInstructionInput,
} from './service.js';

/**
 * Upload statuses a consumer may clear off their disposal step. Every
 * listed status except a decided one: a photo that entered review is held by
 * the retention rule instead, so it is correctly absent here.
 */
const DISPOSAL_REMOVABLE_UPLOAD_STATUSES = [
  'authorized',
  'uploaded',
  'verified',
  'rejected',
] as const;

export interface DrizzleDisposalServiceOptions {
  handle: DatabaseHandle;
  /**
   * How long evidence is retained after review. `null` means "no configured
   * expiry", which is the conservative default until the business decides a
   * retention period — evidence under review is never on the 48-hour clock.
   */
  evidenceRetentionDays?: number | null;
  /**
   * Sends the consumer an update when a decision lands on their disposal step.
   * Optional so tests and any wiring without a queue still construct the service:
   * a notification is never the reason an operator's action fails.
   */
  notifications?: CommunicationQueueService | undefined;
}

/**
 * Consumer product-disposal service.
 *
 * The rule it exists to enforce: an authorization is issued only when
 * {@link assertCanIssueAuthorization} passes against state read inside the same
 * transaction that writes it. There is no bypass flag, no role exemption, and no
 * method that accepts a caller-supplied decision.
 */
export class DrizzleDisposalService implements DisposalService {
  private readonly handle: DatabaseHandle;
  private readonly evidenceRetentionDays: number | null;

  private readonly notifications: CommunicationQueueService | undefined;

  constructor(options: DrizzleDisposalServiceOptions) {
    this.handle = options.handle;
    this.evidenceRetentionDays = options.evidenceRetentionDays ?? null;
    this.notifications = options.notifications;
  }

  /**
   * Mails the consumer about their disposal step.
   *
   * No link goes in the message: the task credential is stored only as a hash, so
   * it cannot be rebuilt here, and rotating a fresh one would invalidate the link
   * the confirmation email already told the consumer to keep. The template points
   * back at that email instead. A task with no case has no consumer to write to,
   * and no queue means nobody asked for notifications.
   */
  private async notifyConsumer(
    tx: DatabaseExecutor,
    taskId: string,
    eventType: string,
    deduplicationKey: string,
    updateSection: string,
  ): Promise<void> {
    if (!this.notifications) return;
    const [row] = await tx
      .select({
        caseId: recallCases.id,
        caseReference: recallCases.publicReference,
        locale: recallCases.locale,
        recipientKeyVersion: caseConsumers.keyVersion,
        recipientEncrypted: caseConsumers.emailEncrypted,
      })
      .from(disposalTasks)
      .innerJoin(recallCases, eq(recallCases.id, disposalTasks.caseId))
      .innerJoin(caseConsumers, eq(caseConsumers.caseId, recallCases.id))
      .where(eq(disposalTasks.id, taskId))
      .limit(1);
    if (!row) return;

    let templateVersionId: string;
    try {
      templateVersionId = await getLatestTemplateVersionId(tx, 'disposal_update', row.locale);
    } catch (error) {
      // A content key with no version is a configuration gap an operator can see
      // and fix. It must not fail the decision that triggered it: this runs inside
      // the review's own transaction, so throwing would roll back the review, the
      // hold or the permission — the record of what a person decided — because a
      // message could not be composed.
      if (!(error instanceof EmailTemplateMissingError)) throw error;
      consoleSafeLogger.error('Disposal notification skipped: no template version', {
        caseId: row.caseId,
        errorCode: 'email_template_missing',
      });
      return;
    }

    await this.notifications.queue(tx, {
      caseId: row.caseId,
      templateVersionId,
      recipientKeyVersion: row.recipientKeyVersion,
      recipientEncrypted: row.recipientEncrypted,
      deduplicationKey,
      eventType,
      variables: { caseReference: row.caseReference, updateSection },
    });
  }

  /**
   * Opens a task at submission, or returns null when disposal does not apply.
   *
   * Null is the normal case and is what keeps the feature dark: a task exists
   * only when the pinned campaign version carries an instruction version that is
   * approved *and* backed by an approval whose authorizing algebra says consumer
   * disposal is permitted. No flag is consulted, so there is nothing to flip on
   * by accident.
   */
  async createTaskForSubmission(
    tx: DatabaseExecutor,
    input: {
      draftId: string;
      /** Null when no case exists yet; the task is always bound to a draft. */
      caseId: string | null;
      campaignVersionId: string;
      productIds: string[];
      hasIncident: boolean;
    },
  ): Promise<{ taskId: string; token: string } | null> {
    const now = new Date();
    const candidates = await tx
      .select({
        id: disposalInstructionVersions.id,
        effectiveFrom: disposalInstructionApprovals.effectiveFrom,
        effectiveUntil: disposalInstructionApprovals.effectiveUntil,
      })
      .from(disposalInstructionVersions)
      .innerJoin(
        disposalInstructionApprovals,
        eq(disposalInstructionApprovals.instructionVersionId, disposalInstructionVersions.id),
      )
      .where(
        and(
          eq(disposalInstructionVersions.campaignVersionId, input.campaignVersionId),
          eq(disposalInstructionVersions.status, 'approved'),
          eq(disposalInstructionApprovals.authorizesConsumerDisposal, true),
          isNull(disposalInstructionApprovals.withdrawnAt),
        ),
      )
      .orderBy(desc(disposalInstructionVersions.versionNumber));
    const version = candidates.find((candidate) => approvalWindowIncludes(candidate, now));
    if (!version) return null;

    const token = generateTaskToken();
    const [task] = await tx
      .insert(disposalTasks)
      .values({
        instructionVersionId: version.id,
        draftId: input.draftId,
        caseId: input.caseId,
        tokenHash: hashTaskToken(token),
        // Long enough to survive an asynchronous photo review, bounded so an
        // abandoned task cannot leak access to private photos forever.
        tokenExpiresAt: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000),
      })
      .returning({ id: disposalTasks.id });

    if (input.productIds.length > 0) {
      await tx.insert(disposalTaskProducts).values(
        input.productIds.map((campaignProductId) => ({
          taskId: task!.id,
          campaignProductId,
          quantity: 1,
          // Never inferred from a match result: a potential match stays
          // unconfirmed until a person says otherwise.
          confirmedAffected: false,
        })),
      );
    }

    // Conservative default from the rollout: an incident pause is applied
    // automatically and can only be lifted by hand. Closing the reportability
    // review never lifts it.
    if (input.hasIncident) {
      await tx.insert(disposalHolds).values({
        taskId: task!.id,
        reason: 'incident_evidence_retention',
        note: 'Placed automatically because this claim reports a safety incident.',
        placedByStaffUserId: null,
      });
    }

    return { taskId: task!.id, token };
  }

  /** Visitor read. A wrong or expired token is indistinguishable from an unknown task. */
  async getTaskForVisitor(taskId: string, taskToken: string): Promise<DisposalTaskDetail | null> {
    const record = await this.loadTaskRecord(this.handle.db, taskId, hashTaskToken(taskToken));
    if (!record) return null;
    const snapshot = evaluateDisposal(record.policyState);
    const [products, instruction, expiresAt] = await Promise.all([
      this.loadProducts(this.handle.db, taskId),
      this.loadInstructionView(this.handle.db, record, snapshot),
      this.loadTokenExpiry(this.handle.db, taskId),
    ]);
    return { task: record, products, snapshot, instruction, expiresAt };
  }

  /**
   * Approved content, or nothing.
   *
   * Withheld unless the version is approved and still in force *and* an approval
   * behind it authorizes consumer disposal. The withholding is the feature: a
   * version published on the strength of a Notice of Violation must not render
   * instructions for a consumer to act on.
   */
  private async loadInstructionView(
    db: DatabaseExecutor,
    record: DisposalTaskRecord,
    snapshot: DisposalPolicySnapshot,
  ): Promise<DisposalInstructionView | null> {
    // The rule for showing instructions is the policy's, not this method's: a
    // conjunction written here would be a second opinion about the same state.
    if (!snapshot.maySeeInstructions) return null;
    const [row] = await db
      .select({
        id: disposalInstructionVersions.id,
        versionNumber: disposalInstructionVersions.versionNumber,
        locale: disposalInstructionVersions.locale,
        title: disposalInstructionVersions.title,
        steps: disposalInstructionVersions.steps,
        referenceImages: disposalInstructionVersions.referenceImages,
        videoUrl: disposalInstructionVersions.videoUrl,
        safetyWarnings: disposalInstructionVersions.safetyWarnings,
        recognitionRequirements: disposalInstructionVersions.recognitionRequirements,
        declarationTextVersion: disposalInstructionVersions.declarationTextVersion,
      })
      .from(disposalInstructionVersions)
      .where(eq(disposalInstructionVersions.id, record.instructionVersionId))
      .limit(1);
    if (!row) return null;
    return {
      versionId: row.id,
      versionNumber: row.versionNumber,
      locale: row.locale,
      title: row.title,
      steps: row.steps,
      referenceImages: row.referenceImages,
      videoUrl: row.videoUrl ?? null,
      safetyWarnings: row.safetyWarnings,
      recognitionRequirements: row.recognitionRequirements,
      declarationTextVersion: row.declarationTextVersion,
    };
  }

  private async loadTokenExpiry(db: DatabaseExecutor, taskId: string): Promise<string> {
    const [row] = await db
      .select({ tokenExpiresAt: disposalTasks.tokenExpiresAt })
      .from(disposalTasks)
      .where(eq(disposalTasks.id, taskId))
      .limit(1);
    return (row?.tokenExpiresAt ?? new Date()).toISOString();
  }

  /** Admin read: permission-authorised, no visitor token. */
  async getTaskForAdmin(taskId: string): Promise<DisposalTaskAdminDetail | null> {
    const record = await this.loadTaskRecord(this.handle.db, taskId);
    if (!record) return null;
    const snapshot = evaluateDisposal(record.policyState);
    const [products, instruction, expiresAt, instructionChecklist, activeHold] = await Promise.all([
      this.loadProducts(this.handle.db, taskId),
      this.loadInstructionView(this.handle.db, record, snapshot),
      this.loadTokenExpiry(this.handle.db, taskId),
      this.loadInstructionChecklistForAdmin(this.handle.db, record),
      this.loadActiveHold(this.handle.db, taskId),
    ]);
    return {
      task: record,
      products,
      snapshot,
      instruction,
      expiresAt,
      instructionChecklist,
      activeHold,
    };
  }

  /**
   * The reviewer's checklist, loaded unconditionally for the pinned version.
   *
   * The consumer view withholds content on purpose — showing steps a consumer
   * must not act on is the failure mode `maySeeInstructions` exists to prevent.
   * A reviewer is in the opposite position: photos still have to be decided
   * while a hold is in force or after a version was withdrawn, and a photo
   * cannot be checked against a checklist that is hidden. Only the checklist
   * and the version's identity are returned, never the consumer-executable
   * steps.
   */
  private async loadInstructionChecklistForAdmin(
    db: DatabaseExecutor,
    record: DisposalTaskRecord,
  ): Promise<DisposalInstructionChecklistView | null> {
    const [row] = await db
      .select({
        id: disposalInstructionVersions.id,
        versionNumber: disposalInstructionVersions.versionNumber,
        locale: disposalInstructionVersions.locale,
        title: disposalInstructionVersions.title,
        status: disposalInstructionVersions.status,
        recognitionRequirements: disposalInstructionVersions.recognitionRequirements,
      })
      .from(disposalInstructionVersions)
      .where(eq(disposalInstructionVersions.id, record.instructionVersionId))
      .limit(1);
    if (!row) return null;
    return {
      versionId: row.id,
      versionNumber: row.versionNumber,
      locale: row.locale,
      title: row.title,
      status: row.status,
      recognitionRequirements: row.recognitionRequirements,
    };
  }

  private async loadActiveHold(
    db: DatabaseExecutor,
    taskId: string,
  ): Promise<DisposalHoldView | null> {
    const [hold] = await db
      .select({
        reason: disposalHolds.reason,
        placedAt: disposalHolds.placedAt,
      })
      .from(disposalHolds)
      .where(and(eq(disposalHolds.taskId, taskId), isNull(disposalHolds.releasedAt)))
      .orderBy(desc(disposalHolds.placedAt))
      .limit(1);
    if (!hold) return null;
    return { reason: hold.reason, placedAt: hold.placedAt.toISOString() };
  }

  /**
   * Authorises one evidence upload for a task, or refuses with the policy reason.
   *
   * Reading the task through the token is the authorisation: staff never hold this
   * credential, and an unknown task and a wrong token are the same `null` here as
   * they are on the read path.
   */
  async assertCanUploadEvidence(taskId: string, taskToken: string): Promise<{ draftId: string }> {
    const record = await this.loadTaskRecord(this.handle.db, taskId, hashTaskToken(taskToken));
    if (!record) throw new ResourceNotFoundError('Disposal task was not found.');
    if (!record.draftId) {
      // Every task opens against a draft, so a task without one is a data fault
      // rather than a normal state.
      throw new ClaimValidationError('This disposal task is not bound to a claim draft.');
    }

    const snapshot = evaluateDisposal(record.policyState);
    if (!snapshot.maySubmitEvidence) {
      throw new ClaimValidationError(
        `Evidence cannot be uploaded for this task right now: ${snapshot.blockingReasons.join(', ') || 'the task is closed'}.`,
      );
    }
    return { draftId: record.draftId };
  }

  /**
   * The task's evidence photos with their derived technical status.
   *
   * Derivation is delegated to the shared helper rather than recomputed here, so the
   * upload shown on this page means the same thing as an upload shown on the claim
   * form.
   */
  async getLatestBatchForAdmin(taskId: string): Promise<DisposalBatchForAdmin | null> {
    const db = this.handle.db;
    const [batch] = await db
      .select({
        id: disposalEvidenceBatches.id,
        batchNumber: disposalEvidenceBatches.batchNumber,
        reviewStatus: disposalEvidenceBatches.reviewStatus,
        submittedAt: disposalEvidenceBatches.submittedAt,
      })
      .from(disposalEvidenceBatches)
      .where(eq(disposalEvidenceBatches.taskId, taskId))
      .orderBy(desc(disposalEvidenceBatches.batchNumber))
      .limit(1);
    if (!batch) return null;

    const rows = await db
      .select({
        documentId: disposalEvidenceBatchDocuments.documentId,
        fileName: documentUploads.originalFileName,
        uploadStatus: documentUploads.uploadStatus,
        scanStatus: documentUploads.scanStatus,
        expiresAt: documentUploads.expiresAt,
      })
      .from(disposalEvidenceBatchDocuments)
      .innerJoin(documentUploads, eq(documentUploads.id, disposalEvidenceBatchDocuments.documentId))
      .where(eq(disposalEvidenceBatchDocuments.batchId, batch.id));

    const now = new Date();
    return {
      id: batch.id,
      batchNumber: batch.batchNumber,
      reviewStatus: batch.reviewStatus,
      submittedAt: batch.submittedAt.toISOString(),
      documents: rows.map((row) => {
        const derived = deriveDocumentStatus(
          row.uploadStatus as ListedUploadStatus,
          row.scanStatus,
          row.expiresAt.getTime() <= now.getTime(),
        );
        return {
          documentId: row.documentId,
          fileName: row.fileName,
          status: derived.status,
          statusReason: derived.statusReason,
        };
      }),
    };
  }

  async listEvidenceDocuments(
    taskId: string,
    taskToken: string,
  ): Promise<EvidenceDocumentSummary[]> {
    const record = await this.loadTaskRecord(this.handle.db, taskId, hashTaskToken(taskToken));
    if (!record) throw new ResourceNotFoundError('Disposal task was not found.');
    if (!record.draftId) return [];

    const rows = await this.handle.db
      .select({
        id: documentUploads.id,
        originalFileName: documentUploads.originalFileName,
        uploadStatus: documentUploads.uploadStatus,
        scanStatus: documentUploads.scanStatus,
        uploadedAt: documentUploads.uploadedAt,
        updatedAt: documentUploads.updatedAt,
        expiresAt: documentUploads.expiresAt,
      })
      .from(documentUploads)
      .where(
        and(
          eq(documentUploads.draftId, record.draftId),
          eq(documentUploads.category, 'disposal_evidence'),
          inArray(documentUploads.uploadStatus, [...LISTED_UPLOAD_STATUSES]),
        ),
      )
      .orderBy(asc(documentUploads.createdAt));

    const now = new Date();
    return rows.map((row) => {
      const derived = deriveDocumentStatus(
        row.uploadStatus as ListedUploadStatus,
        row.scanStatus,
        row.expiresAt.getTime() <= now.getTime(),
      );
      return {
        documentId: row.id,
        fileName: row.originalFileName,
        status: derived.status,
        statusReason: derived.statusReason,
        uploadedAt: row.uploadedAt ? row.uploadedAt.toISOString() : null,
        lastStatusChangedAt: row.updatedAt.toISOString(),
      };
    });
  }

  /**
   * Schedules one evidence photo for deletion.
   *
   * The draft-scoped delete cannot serve this surface: it requires an *active*
   * draft and a document that never linked to a case, while a disposal task's
   * photos are uploaded after the claim was submitted. The guard is the same
   * rule the reaper honours — a photo that has entered a review batch is
   * evidence and stays. Unlike the draft path, a technically `rejected` photo
   * is removable here: that is precisely the row a consumer must be able to
   * clear for a new batch to become submittable.
   */
  async removeEvidenceDocument(
    taskId: string,
    taskToken: string,
    documentId: string,
  ): Promise<void> {
    await this.handle.transaction(async (tx) => {
      const record = await this.loadTaskRecord(tx, taskId, hashTaskToken(taskToken));
      if (!record) throw new ResourceNotFoundError('Disposal task was not found.');
      if (!record.draftId) {
        throw new ClaimValidationError('This disposal task is not bound to a claim draft.');
      }
      const snapshot = evaluateDisposal(record.policyState);
      if (!snapshot.maySubmitEvidence) {
        throw new ClaimValidationError(
          `Evidence cannot be removed for this task right now: ${snapshot.blockingReasons.join(', ') || 'the task is closed'}.`,
        );
      }

      // Both ownership and retention are conditions of the UPDATE itself: a
      // batch submitted concurrently with this delete either lands first (the
      // retention condition then refuses) or lands after (its usability check
      // then sees a photo no longer `verified`). No separate lock is needed.
      const updated = await tx
        .update(documentUploads)
        .set({ uploadStatus: 'deletion_pending', categorySlot: null, updatedAt: sql`now()` })
        .where(
          and(
            eq(documentUploads.id, documentId),
            eq(documentUploads.draftId, record.draftId),
            eq(documentUploads.category, 'disposal_evidence'),
            inArray(documentUploads.uploadStatus, DISPOSAL_REMOVABLE_UPLOAD_STATUSES),
            notUnderEvidenceRetention(tx, documentUploads.id),
          ),
        )
        .returning({ id: documentUploads.id });
      if (updated.length === 0) {
        throw new ClaimValidationError(
          'This photo cannot be removed: it either belongs to a review that is open, or it is not part of this disposal step.',
        );
      }
    });
  }

  async confirmEligibility(input: ConfirmEligibilityInput): Promise<void> {
    await this.handle.transaction(async (tx) => {
      const task = await this.lockTask(tx, input.taskId);
      if (task.version !== input.expectedVersion) {
        throw new ClaimValidationError(
          'This disposal task changed while you were reviewing it. Reload and try again.',
        );
      }
      if (
        input.eligibilityStatus === 'confirmed_eligible' &&
        !(await this.hasConfirmedProduct(tx, input.taskId))
      ) {
        throw new ClaimValidationError(
          'At least one product on this task must be marked confirmed affected before the task can be eligible.',
        );
      }
      await tx
        .update(disposalTasks)
        .set({
          eligibilityStatus: input.eligibilityStatus,
          eligibilityConfirmedByStaffUserId: input.actorStaffUserId,
          eligibilityConfirmedAt: new Date(),
          eligibilityNote: input.note,
          version: task.version + 1,
          updatedAt: new Date(),
        })
        .where(eq(disposalTasks.id, input.taskId));
    });
  }

  /** Marks a single product as confirmed affected. Human act, never inferred. */
  async confirmProductAffected(input: {
    taskId: string;
    campaignProductId: string;
    quantity: number;
  }): Promise<void> {
    await this.handle.transaction(async (tx) => {
      await this.lockTask(tx, input.taskId);
      const updated = await tx
        .update(disposalTaskProducts)
        .set({ confirmedAffected: true, quantity: input.quantity, updatedAt: new Date() })
        .where(
          and(
            eq(disposalTaskProducts.taskId, input.taskId),
            eq(disposalTaskProducts.campaignProductId, input.campaignProductId),
          ),
        )
        .returning({ id: disposalTaskProducts.id });
      if (updated.length === 0) {
        throw new ResourceNotFoundError('That product is not part of this disposal task.');
      }
    });
  }

  async submitEvidenceBatch(
    input: SubmitEvidenceBatchInput,
  ): Promise<{ batchId: string; reviewStatus: 'pending' }> {
    return this.handle.transaction(async (tx) => {
      const record = await this.loadTaskRecord(tx, input.taskId, hashTaskToken(input.taskToken));
      if (!record) throw new ResourceNotFoundError('Disposal task was not found.');
      const snapshot = evaluateDisposal(record.policyState);
      if (!snapshot.maySubmitEvidence) {
        throw new ClaimValidationError(
          `Evidence cannot be submitted for this task right now: ${snapshot.blockingReasons.join(', ') || 'the task is closed'}.`,
        );
      }

      // Replay of the same submission returns the batch that was created.
      const keyHash = hashTaskToken(input.idempotencyKey);
      const [existing] = await tx
        .select({
          id: disposalEvidenceBatches.id,
          reviewStatus: disposalEvidenceBatches.reviewStatus,
        })
        .from(disposalEvidenceBatches)
        .where(eq(disposalEvidenceBatches.idempotencyKeyHash, keyHash))
        .limit(1);
      if (existing) {
        if (existing.reviewStatus === 'pending') {
          return { batchId: existing.id, reviewStatus: 'pending' as const };
        }
        throw new ClaimConflictForBatchError(existing.id);
      }

      const documents = await this.assertUsableEvidence(tx, input, record);
      const [last] = await tx
        .select({ batchNumber: disposalEvidenceBatches.batchNumber })
        .from(disposalEvidenceBatches)
        .where(eq(disposalEvidenceBatches.taskId, input.taskId))
        .orderBy(desc(disposalEvidenceBatches.batchNumber))
        .limit(1);

      const [batch] = await tx
        .insert(disposalEvidenceBatches)
        .values({
          taskId: input.taskId,
          batchNumber: (last?.batchNumber ?? 0) + 1,
          retentionUntil: this.retentionDeadline(input.retentionUntil),
          idempotencyKeyHash: keyHash,
        })
        .returning({ id: disposalEvidenceBatches.id });

      await tx.insert(disposalEvidenceBatchDocuments).values(
        documents.map((document) => ({
          batchId: batch!.id,
          documentId: document.documentId,
          campaignProductId: document.campaignProductId ?? null,
          quantityCovered: document.quantityCovered ?? null,
        })),
      );

      // A new batch replaces the evidence an earlier permission rested on, so
      // that permission must not stay live while the new photos are reviewed.
      // The new batch is excluded from this update — without that it would
      // supersede itself and could never be reviewed.
      await tx
        .update(disposalEvidenceBatches)
        .set({ reviewStatus: 'superseded', updatedAt: new Date() })
        .where(
          and(
            eq(disposalEvidenceBatches.taskId, input.taskId),
            ne(disposalEvidenceBatches.id, batch!.id),
            inArray(disposalEvidenceBatches.reviewStatus, ['pending', 'needs_resubmission']),
          ),
        );
      await tx
        .update(disposalAuthorizations)
        .set({
          status: 'suspended',
          revokedAt: new Date(),
          revokeReason: 'Superseded by a new evidence batch.',
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(disposalAuthorizations.taskId, input.taskId),
            eq(disposalAuthorizations.status, 'active'),
          ),
        );

      return { batchId: batch!.id, reviewStatus: 'pending' as const };
    });
  }

  async reviewBatch(input: ReviewBatchInput): Promise<void> {
    await this.handle.transaction(async (tx) => {
      const [batch] = await tx
        .select({
          id: disposalEvidenceBatches.id,
          taskId: disposalEvidenceBatches.taskId,
          reviewStatus: disposalEvidenceBatches.reviewStatus,
        })
        .from(disposalEvidenceBatches)
        .where(eq(disposalEvidenceBatches.id, input.batchId))
        .for('update');
      if (!batch) throw new ResourceNotFoundError('Evidence batch was not found.');
      if (batch.reviewStatus !== 'pending') {
        throw new ClaimValidationError(
          'This evidence batch has already been decided; a resubmission arrives as a new batch.',
        );
      }
      await this.lockTask(tx, batch.taskId);

      if (input.decision === 'needs_resubmission' && !input.reasonCode) {
        throw new ClaimValidationError(
          'A resubmission request must give the consumer a reason code.',
        );
      }

      await tx.insert(disposalReviews).values({
        batchId: batch.id,
        decision: input.decision,
        reasonCode: input.reasonCode ?? null,
        rationale: input.rationale,
        reviewerStaffUserId: input.actorStaffUserId,
        reviewerRole: input.actorRole,
      });
      await tx
        .update(disposalEvidenceBatches)
        .set({ reviewStatus: input.decision, updatedAt: new Date() })
        .where(eq(disposalEvidenceBatches.id, batch.id));

      await this.notifyConsumer(
        tx,
        batch.taskId,
        'disposal.review.decided',
        `disposal-review:${batch.id}`,
        input.decision === 'accepted'
          ? 'Your photos passed review. Nothing else is needed from you for that step.'
          : 'We need different photos. Open the step, check the instructions, and send new ones.',
      );
    });
  }

  async placeHold(input: PlaceHoldInput): Promise<void> {
    await this.handle.transaction(async (tx) => {
      await this.lockTask(tx, input.taskId);
      const [live] = await tx
        .select({ id: disposalHolds.id })
        .from(disposalHolds)
        .where(and(eq(disposalHolds.taskId, input.taskId), isNull(disposalHolds.releasedAt)))
        .limit(1);
      if (live) return; // Idempotent: one live hold at a time.
      await tx.insert(disposalHolds).values({
        taskId: input.taskId,
        reason: input.reason,
        note: input.note,
        placedByStaffUserId: input.actorStaffUserId,
      });
    });
  }

  async releaseHold(input: ReleaseHoldInput): Promise<void> {
    await this.handle.transaction(async (tx) => {
      await this.lockTask(tx, input.taskId);
      const released = await tx
        .update(disposalHolds)
        .set({
          releasedAt: new Date(),
          releasedByStaffUserId: input.actorStaffUserId,
          releaseNote: input.note,
          updatedAt: new Date(),
        })
        .where(and(eq(disposalHolds.taskId, input.taskId), isNull(disposalHolds.releasedAt)))
        .returning({ id: disposalHolds.id });
      if (released.length === 0) {
        throw new ClaimValidationError('This task has no hold in force to release.');
      }
    });
  }

  /**
   * The products and quantities one permission covers, taken from the accepted
   * batch and capped by what a person confirmed.
   *
   * A batch document may name the product it shows; when it does not, it stands for
   * every confirmed product, which is what the column comment on
   * `disposal_evidence_batch_documents.campaign_product_id` says. Either way the
   * result is capped by `disposal_task_products`: a permission never covers more of
   * a product than a person confirmed was affected.
   */
  private async coverageFor(
    tx: DatabaseExecutor,
    taskId: string,
    batchId: string,
  ): Promise<Array<{ campaignProductId: string; quantity: number }>> {
    const confirmed = await tx
      .select({
        campaignProductId: disposalTaskProducts.campaignProductId,
        quantity: disposalTaskProducts.quantity,
      })
      .from(disposalTaskProducts)
      .where(
        and(
          eq(disposalTaskProducts.taskId, taskId),
          eq(disposalTaskProducts.confirmedAffected, true),
        ),
      );
    if (confirmed.length === 0) return [];

    const documents = await tx
      .select({
        campaignProductId: disposalEvidenceBatchDocuments.campaignProductId,
        quantityCovered: disposalEvidenceBatchDocuments.quantityCovered,
      })
      .from(disposalEvidenceBatchDocuments)
      .where(eq(disposalEvidenceBatchDocuments.batchId, batchId));

    const covered = new Map<string, number>();
    for (const document of documents) {
      if (document.campaignProductId) {
        const confirmedQuantity =
          confirmed.find((row) => row.campaignProductId === document.campaignProductId)?.quantity ??
          0;
        if (confirmedQuantity === 0) continue; // not confirmed, so not covered
        const requested = document.quantityCovered ?? confirmedQuantity;
        covered.set(
          document.campaignProductId,
          Math.min(
            confirmedQuantity,
            Math.max(covered.get(document.campaignProductId) ?? 0, requested),
          ),
        );
      } else {
        // Covers everything confirmed, at full confirmed quantity.
        for (const row of confirmed) {
          covered.set(row.campaignProductId, row.quantity);
        }
      }
    }

    return [...covered.entries()].map(([campaignProductId, quantity]) => ({
      campaignProductId,
      quantity,
    }));
  }

  /**
   * Issues the permission.
   *
   * The state is read inside this transaction and the gate is asserted against
   * it, so a stale page cannot obtain a permission the current state does not
   * support, and no role can skip the check.
   */
  async issueAuthorization(input: {
    taskId: string;
    actorStaffUserId: string;
  }): Promise<{ authorizationId: string }> {
    return this.handle.transaction(async (tx) => {
      const task = await this.lockTask(tx, input.taskId);
      const record = await this.loadTaskRecord(tx, input.taskId, undefined, task);
      if (!record) throw new ResourceNotFoundError('Disposal task was not found.');

      assertCanIssueAuthorization(record.policyState);
      if (!record.latestBatchId) {
        // Unreachable while the gate holds; kept so a future policy edit cannot
        // silently issue a permission with no accepted evidence behind it.
        throw new ClaimValidationError('No accepted evidence batch was found for this task.');
      }

      // A permission that covers nothing is not a permission. Refusing here is the
      // same rule as the rest of the gate: it holds at the moment of issue, against
      // state read in this transaction.
      const coverage = await this.coverageFor(tx, input.taskId, record.latestBatchId);
      if (coverage.length === 0) {
        throw new ClaimValidationError(
          'No confirmed product is covered by the accepted evidence, so there is nothing this permission could permit.',
        );
      }

      const [authorization] = await tx
        .insert(disposalAuthorizations)
        .values({
          taskId: input.taskId,
          batchId: record.latestBatchId,
          instructionVersionId: record.instructionVersionId,
        })
        .returning({ id: disposalAuthorizations.id });

      // Snapshotted, not derived on read: a later batch or a product un-confirmed
      // must not silently widen or narrow a permission that was already given.
      await tx.insert(disposalAuthorizationItems).values(
        coverage.map((item) => ({
          authorizationId: authorization!.id,
          campaignProductId: item.campaignProductId,
          quantity: item.quantity,
        })),
      );

      await this.notifyConsumer(
        tx,
        input.taskId,
        'disposal.permission.granted',
        `disposal-permission:${authorization!.id}`,
        'You may now dispose of the product. Follow the instructions exactly as they were written, including the safety warnings.',
      );

      return { authorizationId: authorization!.id };
    });
  }

  /**
   * Retires the task's live permission.
   *
   * A revocation is terminal for the permission, not for the history: the
   * row, its coverage snapshot and any declaration already made all stay. The
   * consumer is told the permission no longer applies, because the worst state
   * is one where they act on a permission the operator believes was withdrawn.
   */
  async revokeAuthorization(input: {
    taskId: string;
    reason: string;
    actorStaffUserId: string;
  }): Promise<{ authorizationId: string; changed: boolean }> {
    return this.handle.transaction(async (tx) => {
      const task = await this.lockTask(tx, input.taskId);
      const record = await this.loadTaskRecord(tx, input.taskId, undefined, task);
      if (!record) throw new ResourceNotFoundError('Disposal task was not found.');
      if (!record.authorizationId) {
        throw new ClaimValidationError('This task has no permission to revoke.');
      }
      if (record.authorizationStatus === 'revoked') {
        // Idempotent: the retry of an already-performed revocation is the same
        // business fact, so it reports unchanged and the caller audits once.
        return { authorizationId: record.authorizationId, changed: false };
      }

      const now = new Date();
      const revoked = await tx
        .update(disposalAuthorizations)
        .set({
          status: 'revoked',
          revokedAt: now,
          revokedByStaffUserId: input.actorStaffUserId,
          revokeReason: input.reason,
          updatedAt: now,
        })
        .where(
          and(
            eq(disposalAuthorizations.id, record.authorizationId),
            ne(disposalAuthorizations.status, 'revoked'),
          ),
        )
        .returning({ id: disposalAuthorizations.id });
      if (revoked.length === 0) {
        return { authorizationId: record.authorizationId, changed: false };
      }

      await this.notifyConsumer(
        tx,
        input.taskId,
        'disposal.permission.revoked',
        `disposal-permission-revoked:${record.authorizationId}`,
        'The permission for this disposal step no longer applies. Please do not dispose of the product; our team will follow up with what to do next.',
      );

      return { authorizationId: record.authorizationId, changed: true };
    });
  }

  async recordDeclaration(input: RecordDeclarationInput): Promise<void> {
    await this.handle.transaction(async (tx) => {
      const tokenHash = hashTaskToken(input.taskToken);
      const lockedTask = await this.lockTask(tx, input.taskId, tokenHash);
      const record = await this.loadTaskRecord(tx, input.taskId, tokenHash, lockedTask);
      if (!record) throw new ResourceNotFoundError('Disposal task was not found.');

      const hasException = Boolean(input.exceptionType);
      if (hasException && input.authorizationId) {
        throw new ClaimValidationError(
          'A declaration cannot cite both an authorization and an exception.',
        );
      }
      const existing = await tx
        .select({
          authorizationId: disposalDeclarations.authorizationId,
          exceptionType: disposalDeclarations.exceptionType,
          exceptionNote: disposalDeclarations.exceptionNote,
          declarationTextVersion: disposalDeclarations.declarationTextVersion,
        })
        .from(disposalDeclarations)
        .where(eq(disposalDeclarations.taskId, input.taskId))
        .limit(2);
      if (existing.length > 1) {
        throw new DataIntegrityError('This disposal task has more than one declaration.');
      }
      if (existing[0]) {
        const sameRequest =
          existing[0].declarationTextVersion === input.declarationTextVersion &&
          existing[0].exceptionType === (input.exceptionType ?? null) &&
          existing[0].exceptionNote === (input.exceptionNote ?? null) &&
          (input.authorizationId === undefined ||
            input.authorizationId === existing[0].authorizationId);
        if (sameRequest) return;
        throw new ClaimConflictError('This disposal task already has a different declaration.');
      }
      if (record.status !== 'open') {
        throw new ClaimConflictError('This disposal task is already closed.');
      }
      if (input.declarationTextVersion !== record.declarationTextVersion) {
        throw new ClaimValidationError('The declaration text version does not match this task.');
      }

      // A declaration cites exactly one basis, and the *authorization* branch is
      // resolved by the server. The client is not asked to name an authorization:
      // the task holds at most one active one, the server can find it, and a page
      // left open across a re-issue would otherwise cite a stale id.
      const citedAuthorization = hasException
        ? undefined
        : (input.authorizationId ?? record.authorizationId ?? undefined);
      const hasAuthorization = Boolean(citedAuthorization);
      if (!hasException && !hasAuthorization) {
        throw new ClaimValidationError(
          'This task has no active authorization to declare against. Use the exception path if you disposed of the product some other way.',
        );
      }

      const snapshot = evaluateDisposal(record.policyState);
      if (hasAuthorization) {
        if (
          citedAuthorization !== record.authorizationId ||
          record.authorizationStatus !== 'active' ||
          !snapshot.allowedActions.includes('disposal.declare_completion')
        ) {
          throw new ClaimValidationError(
            'This task has no active authorization to declare against.',
          );
        }
      } else {
        if (!hasException || !snapshot.allowedActions.includes('disposal.declare_exception')) {
          throw new ClaimValidationError(
            'An exception declaration is not available for this task.',
          );
        }
        if (!input.exceptionNote) {
          throw new ClaimValidationError(
            'An exception declaration must explain the circumstances.',
          );
        }
      }

      await tx.insert(disposalDeclarations).values({
        taskId: input.taskId,
        authorizationId: hasAuthorization ? (citedAuthorization ?? null) : null,
        exceptionType: input.exceptionType ?? null,
        exceptionNote: input.exceptionNote ?? null,
        declarationTextVersion: input.declarationTextVersion,
      });

      await this.notifyConsumer(
        tx,
        record.id,
        hasException ? 'disposal.exception.recorded' : 'disposal.completion.recorded',
        `disposal-declaration:${record.id}`,
        input.exceptionType
          ? 'We recorded your statement that the product was already disposed of, or that the photos could not be taken. Your note has reached our team, who will follow up if anything else is needed.'
          : 'We recorded that you disposed of the product. Our team will follow up if anything else is needed.',
      );
      await tx
        .update(disposalTasks)
        .set({ status: 'completed', version: record.version + 1, updatedAt: new Date() })
        .where(eq(disposalTasks.id, input.taskId));
    });
  }

  /**
   * Withdraws an instruction version and suspends every permission resting on
   * it. A consumer with the old page still open is stopped by the API, which
   * re-reads this state rather than trusting the cached page.
   */
  async withdrawInstruction(input: WithdrawInstructionInput): Promise<number> {
    return this.handle.transaction(async (tx) => {
      const [version] = await tx
        .select({ id: disposalInstructionVersions.id, status: disposalInstructionVersions.status })
        .from(disposalInstructionVersions)
        .where(eq(disposalInstructionVersions.id, input.instructionVersionId))
        .for('update');
      if (!version) throw new ResourceNotFoundError('Instruction version was not found.');
      if (version.status === 'withdrawn') return 0;

      const now = new Date();
      await tx
        .update(disposalInstructionVersions)
        .set({
          status: 'withdrawn',
          withdrawnAt: now,
          withdrawnByStaffUserId: input.actorStaffUserId,
          withdrawalReason: input.reason,
          updatedAt: now,
        })
        .where(eq(disposalInstructionVersions.id, input.instructionVersionId));

      const suspended = await tx
        .update(disposalAuthorizations)
        .set({
          status: 'suspended',
          revokedAt: now,
          revokedByStaffUserId: input.actorStaffUserId,
          revokeReason: input.reason,
          updatedAt: now,
        })
        .where(
          and(
            eq(disposalAuthorizations.instructionVersionId, input.instructionVersionId),
            eq(disposalAuthorizations.status, 'active'),
          ),
        )
        .returning({ id: disposalAuthorizations.id });

      await tx
        .update(disposalEvidenceBatches)
        .set({ reviewStatus: 'superseded', updatedAt: now })
        .where(
          and(
            eq(disposalEvidenceBatches.reviewStatus, 'pending'),
            sql`exists (
              select 1 from ${disposalTasks}
              where ${disposalTasks.id} = ${disposalEvidenceBatches.taskId}
                and ${disposalTasks.instructionVersionId} = ${input.instructionVersionId}
            )`,
          ),
        );

      return suspended.length;
    });
  }

  // ---- content authoring --------------------------------------------------

  /**
   * Creates a draft instruction version. The next version number is derived from
   * the existing maximum, so a correction becomes a new version instead of
   * silently overwriting an approved one in place.
   */
  async createInstructionVersion(
    input: CreateInstructionVersionInput,
  ): Promise<{ instructionVersionId: string; versionNumber: number }> {
    return this.handle.transaction(async (tx) => {
      const [last] = await tx
        .select({ versionNumber: disposalInstructionVersions.versionNumber })
        .from(disposalInstructionVersions)
        .where(eq(disposalInstructionVersions.campaignVersionId, input.campaignVersionId))
        .orderBy(desc(disposalInstructionVersions.versionNumber))
        .limit(1);
      const versionNumber = (last?.versionNumber ?? 0) + 1;

      const [created] = await tx
        .insert(disposalInstructionVersions)
        .values({
          campaignVersionId: input.campaignVersionId,
          versionNumber,
          locale: input.locale,
          title: input.title,
          steps: input.steps,
          referenceImages: input.referenceImages,
          videoUrl: input.videoUrl ?? null,
          safetyWarnings: input.safetyWarnings,
          recognitionRequirements: input.recognitionRequirements,
          declarationTextVersion: input.declarationTextVersion,
        })
        .returning({ id: disposalInstructionVersions.id });

      return { instructionVersionId: created!.id, versionNumber };
    });
  }

  /**
   * Records approval material.
   *
   * The authorizing boolean is computed here from the material's identity; the
   * caller cannot supply it. That is what keeps the database CHECK a backstop
   * rather than the only line of defence.
   */
  async recordInstructionApproval(input: RecordInstructionApprovalInput): Promise<{
    approvalId: string;
    authorizesConsumerDisposal: boolean;
  }> {
    const authorizes = authorizesConsumerDisposal({
      materialType: input.materialType,
      scope: input.scope,
      measure: input.measure,
    });

    return this.handle.transaction(async (tx) => {
      const [version] = await tx
        .select({ id: disposalInstructionVersions.id })
        .from(disposalInstructionVersions)
        .where(eq(disposalInstructionVersions.id, input.instructionVersionId))
        .limit(1);
      if (!version) throw new ResourceNotFoundError('Instruction version was not found.');

      const [created] = await tx
        .insert(disposalInstructionApprovals)
        .values({
          instructionVersionId: input.instructionVersionId,
          materialType: input.materialType,
          scope: input.scope,
          measure: input.measure,
          authorizesConsumerDisposal: authorizes,
          referenceText: input.referenceText ?? null,
          effectiveFrom: input.effectiveFrom ?? null,
          effectiveUntil: input.effectiveUntil ?? null,
          recordedByStaffUserId: input.actorStaffUserId,
        })
        .returning({ id: disposalInstructionApprovals.id });

      return { approvalId: created!.id, authorizesConsumerDisposal: authorizes };
    });
  }

  async publishInstructionVersion(input: {
    instructionVersionId: string;
    actorStaffUserId: string;
  }): Promise<void> {
    await this.handle.transaction(async (tx) => {
      const [version] = await tx
        .select({ id: disposalInstructionVersions.id, status: disposalInstructionVersions.status })
        .from(disposalInstructionVersions)
        .where(eq(disposalInstructionVersions.id, input.instructionVersionId))
        .for('update');
      if (!version) throw new ResourceNotFoundError('Instruction version was not found.');
      if (version.status !== 'draft') {
        throw new ClaimValidationError(
          'Only a draft instruction version can be published; a correction is a new version.',
        );
      }
      await tx
        .update(disposalInstructionVersions)
        .set({
          status: 'approved',
          approvedAt: new Date(),
          approvedByStaffUserId: input.actorStaffUserId,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(disposalInstructionVersions.id, input.instructionVersionId),
            eq(disposalInstructionVersions.status, 'draft'),
          ),
        );
    });
  }

  async listInstructionVersions(campaignVersionId?: string): Promise<InstructionVersionSummary[]> {
    const now = new Date();
    // Correlated subqueries must qualify their columns explicitly. Drizzle's
    // column interpolation renders bare names here, and a bare `"id"` binds to
    // the subquery's OWN table (`disposal_instruction_approvals.id`), turning
    // the correlation into a always-false self-comparison — production showed
    // approvalCount 0 with approvals committed. Table names are stable across
    // the feature's migrations, so the qualification is written out.
    const authorizingCount = sql<number>`(
      select count(*)::int from disposal_instruction_approvals
      where disposal_instruction_approvals.instruction_version_id = disposal_instruction_versions.id
        and disposal_instruction_approvals.authorizes_consumer_disposal = true
        and disposal_instruction_approvals.withdrawn_at is null
        and (disposal_instruction_approvals.effective_from is null or disposal_instruction_approvals.effective_from <= ${now})
        and (disposal_instruction_approvals.effective_until is null or disposal_instruction_approvals.effective_until > ${now})
    )`;
    const rows = await this.handle.db
      .select({
        id: disposalInstructionVersions.id,
        campaignVersionId: disposalInstructionVersions.campaignVersionId,
        versionNumber: disposalInstructionVersions.versionNumber,
        locale: disposalInstructionVersions.locale,
        status: disposalInstructionVersions.status,
        title: disposalInstructionVersions.title,
        authorizingCount,
        approvalCount: sql<number>`(
          select count(*)::int from disposal_instruction_approvals
          where disposal_instruction_approvals.instruction_version_id = disposal_instruction_versions.id
        )`,
      })
      .from(disposalInstructionVersions)
      .where(
        campaignVersionId
          ? eq(disposalInstructionVersions.campaignVersionId, campaignVersionId)
          : undefined,
      )
      .orderBy(desc(disposalInstructionVersions.createdAt))
      .limit(200);

    return rows.map((row) => ({
      id: row.id,
      campaignVersionId: row.campaignVersionId,
      versionNumber: row.versionNumber,
      locale: row.locale,
      status: row.status,
      title: row.title,
      approvalCount: Number(row.approvalCount),
      authorizesConsumerDisposal: Number(row.authorizingCount) > 0,
    }));
  }

  /**
   * The admin queue. Blocking reasons come from the same policy the consumer
   * surface uses, so the two can never disagree about what is stuck.
   */
  async listQueue(filter: { limit?: number } = {}): Promise<DisposalQueueRowView[]> {
    const db = this.handle.db;
    const now = new Date();
    const rows = await db
      .select({
        taskId: disposalTasks.id,
        status: disposalTasks.status,
        caseReference: recallCases.publicReference,
        eligibilityStatus: disposalTasks.eligibilityStatus,
        createdAt: disposalTasks.createdAt,
        instructionVersionNumber: disposalInstructionVersions.versionNumber,
        instructionStatus: disposalInstructionVersions.status,
        exceptionType: disposalDeclarations.exceptionType,
        exceptionNote: disposalDeclarations.exceptionNote,
        authorizingCount: sql<number>`(
          select count(*)::int from disposal_instruction_approvals
          where disposal_instruction_approvals.instruction_version_id = disposal_tasks.instruction_version_id
            and disposal_instruction_approvals.authorizes_consumer_disposal = true
            and disposal_instruction_approvals.withdrawn_at is null
            and (disposal_instruction_approvals.effective_from is null or disposal_instruction_approvals.effective_from <= ${now})
            and (disposal_instruction_approvals.effective_until is null or disposal_instruction_approvals.effective_until > ${now})
        )`,
      })
      .from(disposalTasks)
      .leftJoin(
        disposalInstructionVersions,
        eq(disposalInstructionVersions.id, disposalTasks.instructionVersionId),
      )
      .leftJoin(recallCases, eq(recallCases.id, disposalTasks.caseId))
      .leftJoin(disposalDeclarations, eq(disposalDeclarations.taskId, disposalTasks.id))
      .orderBy(desc(disposalTasks.createdAt))
      .limit(filter.limit ?? 100);
    if (rows.length === 0) return [];

    const taskIds = rows.map((row) => row.taskId);
    const [productCounts, batchRows, holdRows, authRows] = await Promise.all([
      db
        .select({ taskId: disposalTaskProducts.taskId, count: sql<number>`count(*)::int` })
        .from(disposalTaskProducts)
        .where(inArray(disposalTaskProducts.taskId, taskIds))
        .groupBy(disposalTaskProducts.taskId),
      db
        .select({
          taskId: disposalEvidenceBatches.taskId,
          batchNumber: disposalEvidenceBatches.batchNumber,
          reviewStatus: disposalEvidenceBatches.reviewStatus,
        })
        .from(disposalEvidenceBatches)
        .where(inArray(disposalEvidenceBatches.taskId, taskIds))
        .orderBy(asc(disposalEvidenceBatches.batchNumber)),
      db
        .select({ taskId: disposalHolds.taskId, reason: disposalHolds.reason })
        .from(disposalHolds)
        .where(and(inArray(disposalHolds.taskId, taskIds), isNull(disposalHolds.releasedAt))),
      db
        .select({
          taskId: disposalAuthorizations.taskId,
          status: disposalAuthorizations.status,
          issuedAt: disposalAuthorizations.issuedAt,
        })
        .from(disposalAuthorizations)
        .where(inArray(disposalAuthorizations.taskId, taskIds))
        .orderBy(asc(disposalAuthorizations.issuedAt)),
    ]);

    const productCountByTask = new Map(productCounts.map((r) => [r.taskId, Number(r.count)]));
    const latestBatchByTask = new Map<string, (typeof batchRows)[number]>();
    for (const batch of batchRows) latestBatchByTask.set(batch.taskId, batch);
    const holdReasonByTask = new Map(holdRows.map((r) => [r.taskId, r.reason]));
    const latestAuthByTask = new Map<string, (typeof authRows)[number]>();
    for (const auth of authRows) latestAuthByTask.set(auth.taskId, auth);

    return rows.map((row) => {
      const latestBatch = latestBatchByTask.get(row.taskId) ?? null;
      const holdReason = holdReasonByTask.get(row.taskId) ?? null;
      const holdActive = holdReason !== null;
      const authorizationStatus = latestAuthByTask.get(row.taskId)?.status ?? null;
      const policyState: DisposalPolicyState = {
        taskStatus: row.status,
        eligibilityStatus: row.eligibilityStatus,
        instructionStatus: row.instructionStatus ?? null,
        approvalAuthorizesDisposal: Number(row.authorizingCount) > 0,
        latestBatchReviewStatus: latestBatch?.reviewStatus ?? null,
        holdActive,
        authorizationStatus,
      };
      return {
        taskId: row.taskId,
        caseReference: row.caseReference ?? null,
        eligibilityStatus: row.eligibilityStatus,
        instructionVersionNumber: row.instructionVersionNumber ?? null,
        evidenceReviewStatus: latestBatch?.reviewStatus ?? null,
        authorizationStatus,
        holdActive,
        holdReason,
        blockingReasons: evaluateDisposal(policyState).blockingReasons,
        productCount: productCountByTask.get(row.taskId) ?? 0,
        exceptionType: row.exceptionType ?? null,
        exceptionNote: row.exceptionNote ?? null,
        createdAt: row.createdAt.toISOString(),
      };
    });
  }

  // ---- internals ----------------------------------------------------------

  private retentionDeadline(provided: Date | null): Date | null {
    if (provided) return provided;
    if (this.evidenceRetentionDays === null) return null;
    return new Date(Date.now() + this.evidenceRetentionDays * 24 * 60 * 60 * 1000);
  }

  private async lockTask(tx: DatabaseExecutor, taskId: string, tokenHash?: string) {
    const [task] = await tx
      .select({
        id: disposalTasks.id,
        status: disposalTasks.status,
        version: disposalTasks.version,
      })
      .from(disposalTasks)
      .where(
        and(
          eq(disposalTasks.id, taskId),
          ...(tokenHash
            ? [eq(disposalTasks.tokenHash, tokenHash), gt(disposalTasks.tokenExpiresAt, new Date())]
            : []),
        ),
      )
      .for('update');
    if (!task) throw new ResourceNotFoundError('Disposal task was not found.');
    return task;
  }

  private async hasConfirmedProduct(tx: DatabaseExecutor, taskId: string): Promise<boolean> {
    const rows = await tx
      .select({ id: disposalTaskProducts.id })
      .from(disposalTaskProducts)
      .where(
        and(
          eq(disposalTaskProducts.taskId, taskId),
          eq(disposalTaskProducts.confirmedAffected, true),
        ),
      )
      .limit(1);
    return rows.length > 0;
  }

  /**
   * Evidence must be this consumer's own, technically verified, and of the
   * disposal category. A `verified` document is not accepted evidence — that
   * word is reserved for the human review — it is merely usable as evidence.
   */
  private async assertUsableEvidence(
    tx: DatabaseExecutor,
    input: SubmitEvidenceBatchInput,
    record: DisposalTaskRecord & { draftId: string | null },
  ) {
    const documentIds = input.documents.map((document) => document.documentId);
    const rows = await tx
      .select({
        id: documentUploads.id,
        draftId: documentUploads.draftId,
        caseId: documentUploads.caseId,
        category: documentUploads.category,
        uploadStatus: documentUploads.uploadStatus,
        scanStatus: documentUploads.scanStatus,
      })
      .from(documentUploads)
      .where(inArray(documentUploads.id, documentIds));

    const byId = new Map(rows.map((row) => [row.id, row]));
    for (const document of input.documents) {
      const row = byId.get(document.documentId);
      if (!row) throw new ResourceNotFoundError('An uploaded document was not found.');
      if (row.category !== 'disposal_evidence') {
        throw new ClaimValidationError(
          'Only disposal evidence photos can be submitted for disposal review.',
        );
      }
      if (row.uploadStatus !== 'verified') {
        throw new ClaimValidationError(
          'Every submitted document must finish technical verification first.',
        );
      }
      const ownedByTask =
        (record.draftId !== null && row.draftId === record.draftId) ||
        (record.caseId !== null && row.caseId === record.caseId);
      if (!ownedByTask) {
        throw new ClaimValidationError('A document does not belong to this disposal task.');
      }
    }
    return input.documents;
  }

  private async loadProducts(
    db: DatabaseExecutor,
    taskId: string,
  ): Promise<DisposalTaskProductRecord[]> {
    const rows = await db
      .select({
        campaignProductId: disposalTaskProducts.campaignProductId,
        quantity: disposalTaskProducts.quantity,
        confirmedAffected: disposalTaskProducts.confirmedAffected,
      })
      .from(disposalTaskProducts)
      .where(eq(disposalTaskProducts.taskId, taskId))
      .orderBy(asc(disposalTaskProducts.createdAt));
    return rows;
  }

  /**
   * Reads everything the policy needs in one place. `tokenHash` is optional so
   * the admin path can load a task without holding the visitor's token.
   */
  private async loadTaskRecord(
    db: DatabaseExecutor,
    taskId: string,
    tokenHash?: string,
    lockedTask?: { id: string; status: string; version: number },
  ): Promise<(DisposalTaskRecord & { draftId: string | null; caseId: string | null }) | null> {
    const [row] = await db
      .select({
        id: disposalTasks.id,
        status: disposalTasks.status,
        version: disposalTasks.version,
        eligibilityStatus: disposalTasks.eligibilityStatus,
        draftId: disposalTasks.draftId,
        caseId: disposalTasks.caseId,
        tokenHash: disposalTasks.tokenHash,
        tokenExpiresAt: disposalTasks.tokenExpiresAt,
        instructionVersionId: disposalTasks.instructionVersionId,
        instructionStatus: disposalInstructionVersions.status,
        instructionVersionNumber: disposalInstructionVersions.versionNumber,
        instructionTitle: disposalInstructionVersions.title,
        declarationTextVersion: disposalInstructionVersions.declarationTextVersion,
      })
      .from(disposalTasks)
      .leftJoin(
        disposalInstructionVersions,
        eq(disposalInstructionVersions.id, disposalTasks.instructionVersionId),
      )
      .where(eq(disposalTasks.id, taskId))
      .limit(1);
    if (!row) return null;
    if (tokenHash !== undefined) {
      if (row.tokenHash !== tokenHash) return null;
      if (row.tokenExpiresAt.getTime() <= Date.now()) return null;
    }

    const approvals = await db
      .select({
        effectiveFrom: disposalInstructionApprovals.effectiveFrom,
        effectiveUntil: disposalInstructionApprovals.effectiveUntil,
      })
      .from(disposalInstructionApprovals)
      .where(
        and(
          eq(disposalInstructionApprovals.instructionVersionId, row.instructionVersionId),
          eq(disposalInstructionApprovals.authorizesConsumerDisposal, true),
          isNull(disposalInstructionApprovals.withdrawnAt),
        ),
      );
    const approval = approvals.find((candidate) => approvalWindowIncludes(candidate, new Date()));

    const [batch] = await db
      .select({
        id: disposalEvidenceBatches.id,
        reviewStatus: disposalEvidenceBatches.reviewStatus,
      })
      .from(disposalEvidenceBatches)
      .where(eq(disposalEvidenceBatches.taskId, taskId))
      .orderBy(desc(disposalEvidenceBatches.batchNumber))
      .limit(1);
    const [review] =
      batch?.reviewStatus === 'needs_resubmission'
        ? await db
            .select({ reasonCode: disposalReviews.reasonCode })
            .from(disposalReviews)
            .where(eq(disposalReviews.batchId, batch.id))
            .limit(1)
        : [];
    const parsedReason = disposalReviewReasonCodeSchema.safeParse(review?.reasonCode);
    const reviewReasonCode =
      batch?.reviewStatus === 'needs_resubmission'
        ? parsedReason.success
          ? parsedReason.data
          : 'other'
        : null;

    const [hold] = await db
      .select({ id: disposalHolds.id })
      .from(disposalHolds)
      .where(and(eq(disposalHolds.taskId, taskId), isNull(disposalHolds.releasedAt)))
      .limit(1);

    const [authorization] = await db
      .select({
        id: disposalAuthorizations.id,
        status: disposalAuthorizations.status,
      })
      .from(disposalAuthorizations)
      .where(eq(disposalAuthorizations.taskId, taskId))
      .orderBy(desc(disposalAuthorizations.issuedAt))
      .limit(1);

    const policyState: DisposalPolicyState = {
      taskStatus: row.status,
      eligibilityStatus: row.eligibilityStatus,
      instructionStatus: row.instructionStatus ?? null,
      approvalAuthorizesDisposal: Boolean(approval),
      approvalEffectiveFrom: approval?.effectiveFrom ?? null,
      approvalEffectiveUntil: approval?.effectiveUntil ?? null,
      latestBatchReviewStatus: batch?.reviewStatus ?? null,
      holdActive: Boolean(hold),
      authorizationStatus: authorization?.status ?? null,
    };

    return {
      id: row.id,
      status: row.status,
      version: lockedTask?.version ?? row.version,
      eligibilityStatus: row.eligibilityStatus,
      instructionVersionId: row.instructionVersionId,
      instructionStatus: row.instructionStatus ?? null,
      instructionVersionNumber: row.instructionVersionNumber ?? null,
      instructionTitle: row.instructionTitle ?? null,
      declarationTextVersion: row.declarationTextVersion ?? null,
      approvalAuthorizesDisposal: Boolean(approval),
      latestBatchId: batch?.id ?? null,
      latestBatchReviewStatus: batch?.reviewStatus ?? null,
      latestBatchReviewReasonCode: reviewReasonCode,
      holdActive: Boolean(hold),
      authorizationId: authorization?.id ?? null,
      authorizationStatus: authorization?.status ?? null,
      draftId: row.draftId,
      caseId: row.caseId,
      policyState,
    };
  }

  async getRetentionDays(): Promise<number | null> {
    const [row] = await this.handle.db
      .select({ value: appSettings.value })
      .from(appSettings)
      .where(eq(appSettings.key, 'evidence_retention_days'))
      .limit(1);
    if (!row) return this.evidenceRetentionDays;
    const parsed = Number.parseInt(row.value, 10);
    return Number.isFinite(parsed) ? parsed : null;
  }

  async setRetentionDays(days: number | null): Promise<void> {
    const db = this.handle.db;
    if (days === null || isNaN(days)) {
      await db.delete(appSettings).where(eq(appSettings.key, 'evidence_retention_days'));
    } else {
      await db
        .insert(appSettings)
        .values({ key: 'evidence_retention_days', value: String(days) })
        .onConflictDoUpdate({
          target: appSettings.key,
          set: { value: String(days), updatedAt: new Date() },
        });
    }
  }
}

/** Raised when a batch submission replays a key that already produced a decision. */
export class ClaimConflictForBatchError extends ClaimValidationError {
  constructor(public readonly batchId: string) {
    super('This evidence submission was already reviewed and cannot be replayed.');
    this.name = 'ClaimConflictForBatchError';
  }
}

export type { WithdrawInstructionInput };
