import { and, asc, desc, eq, inArray, isNull, ne, sql } from 'drizzle-orm';

import type { CommunicationQueueService } from '../communications/queue-service.js';
import { getLatestTemplateVersionId } from '../communications/template-loader.js';

import type { DisposalInstructionView } from '../../contracts/disposal.js';
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
import { ClaimValidationError, ResourceNotFoundError } from '../../shared/errors.js';
import {
  deriveDocumentStatus,
  LISTED_UPLOAD_STATUSES,
  type ListedUploadStatus,
} from '../documents/document-status.js';
import {
  assertCanIssueAuthorization,
  authorizesConsumerDisposal,
  evaluateDisposal,
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

    const templateVersionId = await getLatestTemplateVersionId(tx, 'disposal_update', row.locale);
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
    const [version] = await tx
      .select({
        id: disposalInstructionVersions.id,
        tokenExpiryLocale: disposalInstructionVersions.locale,
      })
      .from(disposalInstructionVersions)
      .where(
        and(
          eq(disposalInstructionVersions.campaignVersionId, input.campaignVersionId),
          eq(disposalInstructionVersions.status, 'approved'),
          sql`exists (
            select 1 from ${disposalInstructionApprovals}
            where ${disposalInstructionApprovals.instructionVersionId} = ${disposalInstructionVersions.id}
              and ${disposalInstructionApprovals.authorizesConsumerDisposal} = true
              and ${disposalInstructionApprovals.withdrawnAt} is null
          )`,
        ),
      )
      .limit(1);
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
    const [products, instruction, expiresAt] = await Promise.all([
      this.loadProducts(this.handle.db, taskId),
      this.loadInstructionView(this.handle.db, record),
      this.loadTokenExpiry(this.handle.db, taskId),
    ]);
    return {
      task: record,
      products,
      snapshot: evaluateDisposal(record.policyState),
      instruction,
      expiresAt,
    };
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
  ): Promise<DisposalInstructionView | null> {
    if (record.instructionStatus !== 'approved' || !record.approvalAuthorizesDisposal) return null;
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
  async getTaskForAdmin(taskId: string): Promise<DisposalTaskDetail | null> {
    const record = await this.loadTaskRecord(this.handle.db, taskId);
    if (!record) return null;
    const [products, instruction, expiresAt] = await Promise.all([
      this.loadProducts(this.handle.db, taskId),
      this.loadInstructionView(this.handle.db, record),
      this.loadTokenExpiry(this.handle.db, taskId),
    ]);
    return {
      task: record,
      products,
      snapshot: evaluateDisposal(record.policyState),
      instruction,
      expiresAt,
    };
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

  async recordDeclaration(input: RecordDeclarationInput): Promise<void> {
    await this.handle.transaction(async (tx) => {
      const record = await this.loadTaskRecord(tx, input.taskId, hashTaskToken(input.taskToken));
      if (!record) throw new ResourceNotFoundError('Disposal task was not found.');

      const hasException = Boolean(input.exceptionType);

      // A declaration cites exactly one basis, and the *authorization* branch is
      // resolved by the server. The client is not asked to name an authorization:
      // the task holds at most one active one, the server can find it, and a page
      // left open across a re-issue would otherwise cite a stale id.
      const citedAuthorization = input.authorizationId ?? record.authorizationId ?? undefined;
      const hasAuthorization = Boolean(citedAuthorization);
      if (hasException && hasAuthorization) {
        throw new ClaimValidationError(
          'A declaration must cite either an authorization or an exception, and not both.',
        );
      }
      if (!hasException && !hasAuthorization) {
        throw new ClaimValidationError(
          'This task has no active authorization to declare against. Use the exception path if you disposed of the product some other way.',
        );
      }

      if (hasAuthorization) {
        if (
          citedAuthorization !== record.authorizationId ||
          record.authorizationStatus !== 'active'
        ) {
          throw new ClaimValidationError(
            'The authorization for this task is no longer active, so the disposal cannot be declared.',
          );
        }
      } else if (!input.exceptionNote) {
        throw new ClaimValidationError('An exception declaration must explain the circumstances.');
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
        'disposal.exception.recorded',
        `disposal-exception:${record.id}`,
        input.exceptionType
          ? 'We recorded your statement that the product was already disposed of, or that the photos could not be taken. Your note has reached our team, who will follow up if anything else is needed.'
          : 'We recorded that you disposed of the product. Your note has reached our team, who will follow up if anything else is needed.',
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
    const authorizingCount = sql<number>`(
      select count(*)::int from ${disposalInstructionApprovals}
      where ${disposalInstructionApprovals.instructionVersionId} = ${disposalInstructionVersions.id}
        and ${disposalInstructionApprovals.authorizesConsumerDisposal} = true
        and ${disposalInstructionApprovals.withdrawnAt} is null
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
          select count(*)::int from ${disposalInstructionApprovals}
          where ${disposalInstructionApprovals.instructionVersionId} = ${disposalInstructionVersions.id}
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
          select count(*)::int from ${disposalInstructionApprovals}
          where ${disposalInstructionApprovals.instructionVersionId} = ${disposalTasks.instructionVersionId}
            and ${disposalInstructionApprovals.authorizesConsumerDisposal} = true
            and ${disposalInstructionApprovals.withdrawnAt} is null
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
        .select({ taskId: disposalHolds.taskId })
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
    const heldTasks = new Set(holdRows.map((r) => r.taskId));
    const latestAuthByTask = new Map<string, (typeof authRows)[number]>();
    for (const auth of authRows) latestAuthByTask.set(auth.taskId, auth);

    return rows.map((row) => {
      const latestBatch = latestBatchByTask.get(row.taskId) ?? null;
      const holdActive = heldTasks.has(row.taskId);
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

  private async lockTask(tx: DatabaseExecutor, taskId: string) {
    const [task] = await tx
      .select({
        id: disposalTasks.id,
        status: disposalTasks.status,
        version: disposalTasks.version,
      })
      .from(disposalTasks)
      .where(eq(disposalTasks.id, taskId))
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

    const [approval] = await db
      .select({ authorizes: disposalInstructionApprovals.authorizesConsumerDisposal })
      .from(disposalInstructionApprovals)
      .where(
        and(
          eq(disposalInstructionApprovals.instructionVersionId, row.instructionVersionId),
          eq(disposalInstructionApprovals.authorizesConsumerDisposal, true),
          isNull(disposalInstructionApprovals.withdrawnAt),
        ),
      )
      .limit(1);

    const [batch] = await db
      .select({
        id: disposalEvidenceBatches.id,
        reviewStatus: disposalEvidenceBatches.reviewStatus,
      })
      .from(disposalEvidenceBatches)
      .where(eq(disposalEvidenceBatches.taskId, taskId))
      .orderBy(desc(disposalEvidenceBatches.batchNumber))
      .limit(1);

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
      approvalAuthorizesDisposal: Boolean(approval?.authorizes),
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
      approvalAuthorizesDisposal: Boolean(approval?.authorizes),
      latestBatchId: batch?.id ?? null,
      latestBatchReviewStatus: batch?.reviewStatus ?? null,
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
