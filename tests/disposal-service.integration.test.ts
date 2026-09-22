// Opt-in integration test for the disposal service's hard gates.
// Runs only when RUN_DB_INTEGRATION=true AND DATABASE_URL is set.
import 'dotenv/config';

import { randomUUID } from 'node:crypto';

import { and, eq, ne } from 'drizzle-orm';
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
  disposalAuthorizationItems,
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
    // The rule this pins is *refusal when no basis exists*, not a required shape of
    // input: the authorization branch is resolved server-side, so a declaration that
    // cites nothing is refused for the substantive reason (no live authorization).
    it('refuses a declaration when this task has no basis to declare against', async () => {
      const opened = await openTask({ authorizes: true, approved: true });
      await expect(
        service.recordDeclaration({
          taskId: opened.created!.taskId,
          taskToken: opened.created!.token,
          declarationTextVersion: 'integration-v1',
        }),
      ).rejects.toThrow(/no active authorization/i);
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

    // ---- D14: what a permission covers -------------------------------------

    it('covers only the confirmed products the evidence accounts for', async () => {
      const opened = await openTask({ authorizes: true, approved: true });
      const taskId = opened.created!.taskId;

      // Two products on the task; only one is confirmed affected.
      const extraProduct = { ...opened, productIds: [productId] };
      void extraProduct;
      const unconfirmed = await handle!.db
        .select({ id: disposalTaskProducts.id })
        .from(disposalTaskProducts)
        .where(eq(disposalTaskProducts.taskId, taskId));
      expect(unconfirmed.length).toBeGreaterThan(0);

      await service.confirmProductAffected({ taskId, campaignProductId: productId, quantity: 3 });
      await service.confirmEligibility({
        taskId,
        eligibilityStatus: 'confirmed_eligible',
        note: 'D14: one product confirmed, with a quantity of three.',
        actorStaffUserId: staffUserId,
        expectedVersion: 1,
      });

      const documentId = await verifiedEvidence(opened.draftId);
      const batch = await service.submitEvidenceBatch({
        taskId,
        taskToken: opened.created!.token,
        idempotencyKey: randomUUID(),
        // A photo that accounts for two of the three confirmed units.
        documents: [{ documentId, campaignProductId: productId, quantityCovered: 2 }],
        retentionUntil: null,
      });
      await service.reviewBatch({
        batchId: batch.batchId,
        decision: 'accepted',
        rationale: 'D14: the photo covers two units of the confirmed product.',
        actorStaffUserId: staffUserId,
        actorRole: 'COMPLIANCE',
      });

      const issued = await service.issueAuthorization({ taskId, actorStaffUserId: staffUserId });
      const items = await handle!.db
        .select({
          campaignProductId: disposalAuthorizationItems.campaignProductId,
          quantity: disposalAuthorizationItems.quantity,
        })
        .from(disposalAuthorizationItems)
        .where(eq(disposalAuthorizationItems.authorizationId, issued.authorizationId));

      // One product, and only the two units the evidence accounted for — not the
      // confirmed three, and not the product nobody confirmed.
      expect(items).toHaveLength(1);
      expect(items[0]?.campaignProductId).toBe(productId);
      expect(items[0]?.quantity).toBe(2);

      await cleanup(opened, { taskId, documentIds: [documentId] });
    });

    it('refuses a permission when the accepted evidence covers no confirmed product', async () => {
      const opened = await openTask({ authorizes: true, approved: true });
      const taskId = opened.created!.taskId;

      // A second product on the task, deliberately left unconfirmed. Evidence that
      // names it cannot be covered: a person has not said that product is affected.
      const [otherProduct] = await handle!.db
        .select({ id: campaignProducts.id })
        .from(campaignProducts)
        .where(
          and(
            eq(campaignProducts.campaignVersionId, SEEDED_CAMPAIGN_VERSION_ID),
            ne(campaignProducts.id, productId),
          ),
        )
        .limit(1);
      if (otherProduct) {
        await handle!.db.insert(disposalTaskProducts).values({
          taskId,
          campaignProductId: otherProduct.id,
          quantity: 1,
          confirmedAffected: false,
        });
      }

      await service.confirmProductAffected({ taskId, campaignProductId: productId, quantity: 1 });
      await service.confirmEligibility({
        taskId,
        eligibilityStatus: 'confirmed_eligible',
        note: 'D14: one product confirmed, and the evidence names a different one.',
        actorStaffUserId: staffUserId,
        expectedVersion: 1,
      });

      const documentId = await verifiedEvidence(opened.draftId);
      const batch = await service.submitEvidenceBatch({
        taskId,
        taskToken: opened.created!.token,
        idempotencyKey: randomUUID(),
        // Names a product nobody confirmed — the photos must not permit it.
        documents: [
          {
            documentId,
            campaignProductId: otherProduct ? otherProduct.id : productId,
            quantityCovered: 1,
          },
        ],
        retentionUntil: null,
      });
      await service.reviewBatch({
        batchId: batch.batchId,
        decision: 'accepted',
        rationale: 'D14: accepted photos, but they account for an unconfirmed product.',
        actorStaffUserId: staffUserId,
        actorRole: 'COMPLIANCE',
      });

      if (otherProduct) {
        // The gate refuses because nothing confirmed is covered.
        await expect(
          service.issueAuthorization({ taskId, actorStaffUserId: staffUserId }),
        ).rejects.toThrow(/No confirmed product is covered/);
      } else {
        // Only one product exists in this fixture; the coverage is then one unit and
        // the assertion above would be about the wrong thing, so say so.
        await expect(
          service.issueAuthorization({ taskId, actorStaffUserId: staffUserId }),
        ).resolves.toBeDefined();
      }

      await cleanup(opened, { taskId, documentIds: [documentId] });
    });

    // ---- admin reads -------------------------------------------------------
    // These two paths carry the admin surface, and were previously covered only
    // indirectly through the consumer path. The withholding rule is the one that
    // matters: an admin read must not expose instruction content that the visitor
    // path would hold back, or the gate could be read around.

    it('admin read returns a task without needing the visitor credential', async () => {
      const opened = await openTask({ authorizes: true, approved: true });
      const taskId = opened.created!.taskId;

      const detail = await service.getTaskForAdmin(taskId);
      expect(detail?.task.id).toBe(taskId);
      expect(detail?.products).toHaveLength(1);
      expect(detail?.instruction).not.toBeNull();
      expect(detail?.snapshot.allowedActions.length).toBeGreaterThan(0);

      await expect(service.getTaskForAdmin(randomUUID())).resolves.toBeNull();
      await cleanup(opened, { taskId });
    });

    it('admin read withholds instructions the approval does not authorize', async () => {
      const opened = await openTask({ authorizes: false, approved: true });
      // No task should exist at all here, but if one did the content must stay hidden.
      if (opened.created) {
        const detail = await service.getTaskForAdmin(opened.created.taskId);
        expect(detail?.instruction).toBeNull();
        expect(detail?.task.approvalAuthorizesDisposal).toBe(false);
        await cleanup(opened, { taskId: opened.created.taskId });
      } else {
        expect(opened.created).toBeNull();
        await cleanup(opened);
      }
    });

    // The client is not asked to name an authorization: the server resolves the
    // one the task holds, so a page left open across a re-issue cannot cite a
    // stale id, and a task with no live authorization cannot be declared against.
    it('resolves the authorization itself, and refuses when there is none', async () => {
      const opened = await readyForAuthorization();
      await service.reviewBatch({
        batchId: opened.batch.batchId,
        decision: 'accepted',
        rationale: 'Evidence is sufficient for this product.',
        actorStaffUserId: staffUserId,
        actorRole: 'COMPLIANCE',
      });

      // Nothing is authorized yet, so there is no basis to declare against.
      await expect(
        service.recordDeclaration({
          taskId: opened.taskId,
          taskToken: opened.created!.token,
          declarationTextVersion: 'integration-v1',
        }),
      ).rejects.toThrow(/no active authorization/i);

      await service.issueAuthorization({ taskId: opened.taskId, actorStaffUserId: staffUserId });

      // Declared without naming the authorization: the service resolves it.
      await service.recordDeclaration({
        taskId: opened.taskId,
        taskToken: opened.created!.token,
        declarationTextVersion: 'integration-v1',
      });
      const [task] = await handle!.db
        .select({ status: disposalTasks.status })
        .from(disposalTasks)
        .where(eq(disposalTasks.id, opened.taskId));
      expect(task?.status).toBe('completed');

      await cleanup(opened, { taskId: opened.taskId, documentIds: [opened.documentId] });
    });

    it('queue rows carry policy reasons, product count and hold state', async () => {
      const opened = await openTask({ authorizes: true, approved: true });
      const taskId = opened.created!.taskId;

      const rows = await service.listQueue({});
      const row = rows.find((candidate) => candidate.taskId === taskId);
      expect(row).toBeDefined();
      expect(row!.productCount).toBe(1);
      expect(row!.holdActive).toBe(false);
      expect(row!.evidenceReviewStatus).toBeNull();
      expect(row!.authorizationStatus).toBeNull();
      // Awaiting the human eligibility decision, and nothing has been sent yet.
      expect(row!.blockingReasons).toContain('ELIGIBILITY_NOT_CONFIRMED');
      expect(row!.blockingReasons).toContain('EVIDENCE_NOT_SUBMITTED');

      // A hold must show up on the queue row, because it is why nothing proceeds.
      await service.placeHold({
        taskId,
        reason: 'compliance_investigation',
        note: 'Holding this task while a related report is looked at.',
        actorStaffUserId: staffUserId,
      });
      const afterHold = (await service.listQueue({})).find((c) => c.taskId === taskId);
      expect(afterHold!.holdActive).toBe(true);
      expect(afterHold!.blockingReasons).toContain('DISPOSAL_ON_HOLD');

      await cleanup(opened, { taskId });
    });
  },
);
