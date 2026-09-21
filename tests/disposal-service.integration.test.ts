// Opt-in integration test for the disposal service's hard gates.
// Runs only when RUN_DB_INTEGRATION=true AND DATABASE_URL is set.
import 'dotenv/config';

import { randomUUID } from 'node:crypto';

import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDatabase, type DatabaseHandle } from '../src/db/client.js';
import {
  campaignProducts,
  campaignVersions,
  claimDrafts,
  disposalAuthorizations,
  disposalEvidenceBatches,
  disposalHolds,
  disposalInstructionApprovals,
  disposalInstructionVersions,
  disposalTasks,
  disposalTaskProducts,
  documentUploads,
  staffUsers,
} from '../src/db/schema/index.js';
import { DrizzleDisposalService } from '../src/modules/disposal/drizzle-disposal-service.js';
import { evaluateDisposal } from '../src/modules/disposal/policy.js';

const enabled = process.env.RUN_DB_INTEGRATION === 'true' && Boolean(process.env.DATABASE_URL);
const handle: DatabaseHandle | null = enabled
  ? createDatabase(process.env.DATABASE_URL as string)
  : null;

const SEEDED_CAMPAIGN_ID = '2bdac8b0-73d8-4e38-a7e2-98fd5608788a';
const SEEDED_CAMPAIGN_VERSION_ID = '85eafab1-a5bd-4d57-a697-38bce973deab';

// Each case drives the real service through ten or more round trips, and this
// suite also runs against a remote database where a round trip costs seconds.
// The default 5s per-test budget is sized for a local Postgres.
describe.skipIf(!enabled)(
  'DrizzleDisposalService (database integration)',
  { timeout: 90_000 },
  () => {
    let service: DrizzleDisposalService;
    let staffUserId: string;
    let productId: string;

    beforeAll(async () => {
      service = new DrizzleDisposalService({ handle: handle! });
      const [staff] = await handle!.db.select({ id: staffUsers.id }).from(staffUsers).limit(1);
      const [product] = await handle!.db
        .select({ id: campaignProducts.id })
        .from(campaignProducts)
        .where(eq(campaignProducts.campaignVersionId, SEEDED_CAMPAIGN_VERSION_ID))
        .limit(1);
      if (!staff || !product) throw new Error('Seed data is required.');
      staffUserId = staff.id;
      productId = product.id;
    });

    afterAll(async () => {
      await handle?.close();
    });

    /**
     * Builds a self-contained world: its own campaign version, draft, and
     * instruction version.
     *
     * A dedicated campaign version per case is what keeps these tests
     * independent. Sharing the seeded version meant an interrupted run could
     * leave an approved instruction version behind and turn "no approved version
     * exists" into a false negative.
     */
    async function fixture(options: { authorizes: boolean; approved: boolean }) {
      const db = handle!.db;
      const [campaignVersion] = await db
        .insert(campaignVersions)
        .values({
          campaignId: SEEDED_CAMPAIGN_ID,
          versionNumber: 700_000 + Math.floor(Math.random() * 90_000),
          status: 'draft',
        })
        .returning({ id: campaignVersions.id });

      const draftId = randomUUID();
      await db.insert(claimDrafts).values({
        id: draftId,
        campaignId: SEEDED_CAMPAIGN_ID,
        campaignVersionId: campaignVersion!.id,
        tokenHash: randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, ''),
        expiresAt: new Date(Date.now() + 3_600_000),
      });

      const [version] = await db
        .insert(disposalInstructionVersions)
        .values({
          campaignVersionId: campaignVersion!.id,
          versionNumber: 1,
          locale: 'en-US',
          status: options.approved ? 'approved' : 'draft',
          title: 'Integration test disposal instructions',
          steps: [{ order: 1, text: 'Follow the recall instructions.' }],
          referenceImages: [],
          safetyWarnings: ['Do not open or damage the battery.'],
          recognitionRequirements: ['The full product label must be readable.'],
          declarationTextVersion: 'integration-v1',
          ...(options.approved
            ? { approvedAt: new Date(), approvedByStaffUserId: staffUserId }
            : {}),
        })
        .returning({ id: disposalInstructionVersions.id });

      await db.insert(disposalInstructionApprovals).values({
        instructionVersionId: version!.id,
        materialType: 'recall_expectation_letter',
        scope: 'consumer_held_product',
        measure: options.authorizes ? 'consumer_disposal' : 'consumer_return',
        authorizesConsumerDisposal: options.authorizes,
        recordedByStaffUserId: staffUserId,
      });

      return { draftId, campaignVersionId: campaignVersion!.id, versionId: version!.id };
    }

    async function verifiedEvidence(draftId: string, category = 'disposal_evidence') {
      const [document] = await handle!.db
        .insert(documentUploads)
        .values({
          draftId,
          caseId: null,
          category: category as 'disposal_evidence',
          categorySlot: null,
          storagePathname: `tests/disposal/${Date.now()}/${randomUUID()}.jpg`,
          originalFileName: 'before.jpg',
          declaredMimeType: 'image/jpeg',
          detectedMimeType: 'image/jpeg',
          sizeBytes: 1024,
          uploadStatus: 'verified',
          scanStatus: 'clean',
          expiresAt: new Date(Date.now() + 86_400_000),
        })
        .returning({ id: documentUploads.id });
      return document!.id;
    }

    type Fixture = Awaited<ReturnType<typeof fixture>>;

    /** Removes everything a case created, in foreign-key order. */
    async function cleanup(
      built: Fixture,
      extra: { taskId?: string; documentIds?: string[] } = {},
    ) {
      const db = handle!.db;
      if (extra.taskId) {
        // disposal_* children cascade from the task.
        await db.delete(disposalTasks).where(eq(disposalTasks.id, extra.taskId));
      }
      await db
        .delete(disposalInstructionApprovals)
        .where(eq(disposalInstructionApprovals.instructionVersionId, built.versionId));
      await db
        .delete(disposalInstructionVersions)
        .where(eq(disposalInstructionVersions.id, built.versionId));
      for (const id of extra.documentIds ?? []) {
        await db.delete(documentUploads).where(eq(documentUploads.id, id));
      }
      await db.delete(claimDrafts).where(eq(claimDrafts.id, built.draftId));
      await db.delete(campaignVersions).where(eq(campaignVersions.id, built.campaignVersionId));
    }

    /** Opens a task through the real service, as claim submission would. */
    async function openTask(options: {
      authorizes: boolean;
      approved: boolean;
      hasIncident?: boolean;
    }) {
      const built = await fixture(options);
      const created = await handle!.transaction((tx) =>
        service.createTaskForSubmission(tx, {
          draftId: built.draftId,
          caseId: null,
          campaignVersionId: built.campaignVersionId,
          productIds: [productId],
          hasIncident: options.hasIncident ?? false,
        }),
      );
      return { ...built, created };
    }

    /** Takes a task all the way to accepted evidence, the way a real run would. */
    async function readyForAuthorization() {
      const opened = await openTask({ authorizes: true, approved: true });
      const taskId = opened.created!.taskId;
      const documentId = await verifiedEvidence(opened.draftId);
      await service.confirmProductAffected({ taskId, campaignProductId: productId, quantity: 1 });
      await service.confirmEligibility({
        taskId,
        eligibilityStatus: 'confirmed_eligible',
        note: 'Confirmed against the recall notice.',
        actorStaffUserId: staffUserId,
        expectedVersion: 1,
      });
      const batch = await service.submitEvidenceBatch({
        taskId,
        taskToken: opened.created!.token,
        idempotencyKey: randomUUID(),
        documents: [{ documentId }],
        retentionUntil: null,
      });
      return { ...opened, taskId, documentId, batch };
    }

    // ---- dark ship ---------------------------------------------------------

    it('creates no task when no approved instruction version exists', async () => {
      const built = await fixture({ authorizes: true, approved: false });
      const created = await handle!.transaction((tx) =>
        service.createTaskForSubmission(tx, {
          draftId: built.draftId,
          caseId: null,
          campaignVersionId: built.campaignVersionId,
          productIds: [productId],
          hasIncident: false,
        }),
      );
      expect(created).toBeNull();
      await cleanup(built);
    });

    // D25: the version is approved, but the only material behind it selects a
    // measure that is not consumer disposal — so no task may exist at all.
    it('creates no task when the approval does not authorize consumer disposal', async () => {
      const built = await fixture({ authorizes: false, approved: true });
      const created = await handle!.transaction((tx) =>
        service.createTaskForSubmission(tx, {
          draftId: built.draftId,
          caseId: null,
          campaignVersionId: built.campaignVersionId,
          productIds: [productId],
          hasIncident: false,
        }),
      );
      expect(created).toBeNull();
      await cleanup(built);
    });

    it('seeds a new task with every product unconfirmed', async () => {
      const opened = await openTask({ authorizes: true, approved: true });
      expect(opened.created).not.toBeNull();
      const products = await handle!.db
        .select()
        .from(disposalTaskProducts)
        .where(eq(disposalTaskProducts.taskId, opened.created!.taskId));
      expect(products).toHaveLength(1);
      // A potential match is never recorded as confirmed.
      expect(products[0]?.confirmedAffected).toBe(false);

      const detail = await service.getTaskForVisitor(opened.created!.taskId, opened.created!.token);
      expect(detail?.task.eligibilityStatus).toBe('pending_confirmation');
      expect(evaluateDisposal(detail!.task.policyState).blockingReasons).toContain(
        'ELIGIBILITY_NOT_CONFIRMED',
      );
      await cleanup(opened, { taskId: opened.created!.taskId });
    });

    it('hides a task from a wrong token', async () => {
      const opened = await openTask({ authorizes: true, approved: true });
      await expect(
        service.getTaskForVisitor(opened.created!.taskId, 'not-the-real-token'),
      ).resolves.toBeNull();
      await cleanup(opened, { taskId: opened.created!.taskId });
    });

    // ---- the gate ----------------------------------------------------------

    it('refuses an authorization before eligibility is confirmed', async () => {
      const opened = await openTask({ authorizes: true, approved: true });
      await expect(
        service.issueAuthorization({
          taskId: opened.created!.taskId,
          actorStaffUserId: staffUserId,
        }),
      ).rejects.toThrow(/ELIGIBILITY_NOT_CONFIRMED|refused/i);
      await cleanup(opened, { taskId: opened.created!.taskId });
    });

    it('refuses an authorization while the photo review is only pending', async () => {
      const opened = await readyForAuthorization();
      expect(opened.batch.reviewStatus).toBe('pending');

      // Uploaded and technically verified is not acceptance.
      await expect(
        service.issueAuthorization({ taskId: opened.taskId, actorStaffUserId: staffUserId }),
      ).rejects.toThrow(/EVIDENCE_PENDING_REVIEW|refused/i);

      // D07: a rejection asks for a resubmission rather than ending the task.
      await service.reviewBatch({
        batchId: opened.batch.batchId,
        decision: 'needs_resubmission',
        rationale: 'The product label is not readable in the photo.',
        reasonCode: 'photo_unreadable',
        actorStaffUserId: staffUserId,
        actorRole: 'COMPLIANCE',
      });
      const afterRejection = await service.getTaskForVisitor(opened.taskId, opened.created!.token);
      expect(afterRejection!.task.latestBatchReviewStatus).toBe('needs_resubmission');
      expect(evaluateDisposal(afterRejection!.task.policyState).maySubmitEvidence).toBe(true);
      await expect(
        service.issueAuthorization({ taskId: opened.taskId, actorStaffUserId: staffUserId }),
      ).rejects.toThrow();

      await cleanup(opened, { taskId: opened.taskId, documentIds: [opened.documentId] });
    });

    // D08 plus D12/D13: acceptance is necessary but not sufficient.
    it('issues an authorization only after acceptance, and never while a hold stands', async () => {
      const opened = await readyForAuthorization();
      await service.reviewBatch({
        batchId: opened.batch.batchId,
        decision: 'accepted',
        rationale: 'Label and hazard are both clearly visible.',
        actorStaffUserId: staffUserId,
        actorRole: 'COMPLIANCE',
      });

      // D12: a hold refuses even with accepted photos.
      await service.placeHold({
        taskId: opened.taskId,
        reason: 'compliance_investigation',
        note: 'Investigating a related report before disposal proceeds.',
        actorStaffUserId: staffUserId,
      });
      await expect(
        service.issueAuthorization({ taskId: opened.taskId, actorStaffUserId: staffUserId }),
      ).rejects.toThrow(/DISPOSAL_ON_HOLD|refused/i);

      // D13: releasing the hold is a separate, deliberate act.
      await service.releaseHold({
        taskId: opened.taskId,
        note: 'Investigation closed with no further action.',
        actorStaffUserId: staffUserId,
      });
      const issued = await service.issueAuthorization({
        taskId: opened.taskId,
        actorStaffUserId: staffUserId,
      });
      expect(issued.authorizationId).toBeTruthy();

      const detail = await service.getTaskForVisitor(opened.taskId, opened.created!.token);
      expect(detail!.task.authorizationStatus).toBe('active');

      await cleanup(opened, { taskId: opened.taskId, documentIds: [opened.documentId] });
    });

    // D15: a withdrawal stops a permission that is already issued.
    it('suspends live authorizations when the instruction version is withdrawn', async () => {
      const opened = await readyForAuthorization();
      await service.reviewBatch({
        batchId: opened.batch.batchId,
        decision: 'accepted',
        rationale: 'Evidence covers the recognised hazard.',
        actorStaffUserId: staffUserId,
        actorRole: 'COMPLIANCE',
      });
      await service.issueAuthorization({ taskId: opened.taskId, actorStaffUserId: staffUserId });

      const suspended = await service.withdrawInstruction({
        instructionVersionId: opened.versionId,
        reason: 'CPSC coordination changed the required method.',
        actorStaffUserId: staffUserId,
      });
      expect(suspended).toBe(1);

      const detail = await service.getTaskForVisitor(opened.taskId, opened.created!.token);
      expect(detail!.task.instructionStatus).toBe('withdrawn');
      expect(detail!.task.authorizationStatus).toBe('suspended');

      await cleanup(opened, { taskId: opened.taskId, documentIds: [opened.documentId] });
    });

    // D17: one terminal decision per batch.
    it('refuses to decide the same batch twice', async () => {
      const opened = await readyForAuthorization();
      await service.reviewBatch({
        batchId: opened.batch.batchId,
        decision: 'accepted',
        rationale: 'Evidence is sufficient for this product.',
        actorStaffUserId: staffUserId,
        actorRole: 'COMPLIANCE',
      });
      await expect(
        service.reviewBatch({
          batchId: opened.batch.batchId,
          decision: 'needs_resubmission',
          rationale: 'Changing my mind about the earlier decision.',
          reasonCode: 'other',
          actorStaffUserId: staffUserId,
          actorRole: 'COMPLIANCE',
        }),
      ).rejects.toThrow();
      await cleanup(opened, { taskId: opened.taskId, documentIds: [opened.documentId] });
    });

    // A document verified for another purpose is not disposal evidence.
    it('does not accept documents that are not disposal evidence', async () => {
      const opened = await openTask({ authorizes: true, approved: true });
      const taskId = opened.created!.taskId;
      const wrongCategory = await verifiedEvidence(opened.draftId, 'product_photo');

      await service.confirmProductAffected({ taskId, campaignProductId: productId, quantity: 1 });
      await service.confirmEligibility({
        taskId,
        eligibilityStatus: 'confirmed_eligible',
        note: 'Confirmed against the recall notice.',
        actorStaffUserId: staffUserId,
        expectedVersion: 1,
      });
      await expect(
        service.submitEvidenceBatch({
          taskId,
          taskToken: opened.created!.token,
          idempotencyKey: randomUUID(),
          documents: [{ documentId: wrongCategory }],
          retentionUntil: null,
        }),
      ).rejects.toThrow(/disposal evidence/i);

      await cleanup(opened, { taskId, documentIds: [wrongCategory] });
    });

    // D19/D20: no fake completion, and a truthful exception is recordable.
    it('refuses a declaration with neither an authorization nor an exception', async () => {
      const opened = await openTask({ authorizes: true, approved: true });
      await expect(
        service.recordDeclaration({
          taskId: opened.created!.taskId,
          taskToken: opened.created!.token,
          declarationTextVersion: 'integration-v1',
        }),
      ).rejects.toThrow(/either an authorization or an exception/i);
      await cleanup(opened, { taskId: opened.created!.taskId });
    });

    it('accepts a truthful already-disposed exception without inventing a permission', async () => {
      const opened = await openTask({ authorizes: true, approved: true });
      const taskId = opened.created!.taskId;
      await service.recordDeclaration({
        taskId,
        taskToken: opened.created!.token,
        declarationTextVersion: 'integration-v1',
        exceptionType: 'already_disposed_before_authorization',
        exceptionNote: 'The consumer had already discarded the unit before this task was opened.',
      });
      const [task] = await handle!.db
        .select({ status: disposalTasks.status })
        .from(disposalTasks)
        .where(eq(disposalTasks.id, taskId));
      expect(task?.status).toBe('completed');

      // No permission was manufactured to make the timeline look authorised.
      const authorizations = await handle!.db
        .select({ id: disposalAuthorizations.id })
        .from(disposalAuthorizations)
        .where(eq(disposalAuthorizations.taskId, taskId));
      expect(authorizations).toHaveLength(0);

      await cleanup(opened, { taskId });
    });

    // The automatic incident pause, and the fact that nothing else lifts it.
    it('places an incident hold automatically, attributed to no person', async () => {
      const opened = await openTask({ authorizes: true, approved: true, hasIncident: true });
      const holds = await handle!.db
        .select()
        .from(disposalHolds)
        .where(eq(disposalHolds.taskId, opened.created!.taskId));
      expect(holds).toHaveLength(1);
      expect(holds[0]?.reason).toBe('incident_evidence_retention');
      expect(holds[0]?.releasedAt).toBeNull();
      // Nobody pressed anything: a system-placed hold has no staff actor.
      expect(holds[0]?.placedByStaffUserId).toBeNull();

      const detail = await service.getTaskForVisitor(opened.created!.taskId, opened.created!.token);
      expect(detail!.task.holdActive).toBe(true);
      await cleanup(opened, { taskId: opened.created!.taskId });
    });

    // D22: a batch's retention protects its evidence from the reaper.
    it('records a retention deadline on submitted evidence', async () => {
      const opened = await openTask({ authorizes: true, approved: true });
      const taskId = opened.created!.taskId;
      const documentId = await verifiedEvidence(opened.draftId);
      await service.confirmProductAffected({ taskId, campaignProductId: productId, quantity: 1 });
      await service.confirmEligibility({
        taskId,
        eligibilityStatus: 'confirmed_eligible',
        note: 'Confirmed against the recall notice.',
        actorStaffUserId: staffUserId,
        expectedVersion: 1,
      });
      const deadline = new Date(Date.now() + 30 * 86_400_000);
      const batch = await service.submitEvidenceBatch({
        taskId,
        taskToken: opened.created!.token,
        idempotencyKey: randomUUID(),
        documents: [{ documentId }],
        retentionUntil: deadline,
      });
      const [row] = await handle!.db
        .select({ retentionUntil: disposalEvidenceBatches.retentionUntil })
        .from(disposalEvidenceBatches)
        .where(eq(disposalEvidenceBatches.id, batch.batchId));
      expect(row?.retentionUntil?.getTime()).toBe(deadline.getTime());
      await cleanup(opened, { taskId, documentIds: [documentId] });
    });
  },
);
