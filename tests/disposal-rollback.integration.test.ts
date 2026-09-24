// Opt-in integration test for the E3 Rollback Rehearsal.
// Runs only when RUN_DB_INTEGRATION=true AND DATABASE_URL is set.
import 'dotenv/config';

import { randomUUID } from 'node:crypto';

import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDatabase, type DatabaseHandle } from '../src/db/client.js';
import {
  caseConsents,
  caseConsumers,
  caseEvents,
  caseResolutions,
  campaignEvidenceRequirements,
  claimedProducts,
  campaignProducts,
  claimDrafts,
  disposalAuthorizations,
  disposalEvidenceBatches,
  disposalInstructionApprovals,
  disposalInstructionVersions,
  communications,
  documentUploads,
  disposalReviews,
  idempotencyRecords,
  incidents,
  disposalTasks,
  outboxEvents,
  recallCases,
  reportabilityReviews,
  submissionSnapshots,
  staffUsers,
} from '../src/db/schema/index.js';
import { DrizzleCaseService } from '../src/modules/cases/drizzle-case-service.js';
import { DrizzleClaimDraftService } from '../src/modules/claim-drafts/drizzle-claim-draft-service.js';
import { DrizzleCommunicationQueueService } from '../src/modules/communications/queue-service.js';
import { DrizzleDisposalService } from '../src/modules/disposal/drizzle-disposal-service.js';
import { NodeSensitiveDataCrypto } from '../src/platform/crypto/node-sensitive-data-crypto.js';
import { assertLocalIntegrationDatabase } from './helpers/db-guard.js';

assertLocalIntegrationDatabase(process.env.DATABASE_URL);

const enabled = process.env.RUN_DB_INTEGRATION === 'true' && Boolean(process.env.DATABASE_URL);
const handle: DatabaseHandle | null = enabled
  ? createDatabase(process.env.DATABASE_URL as string)
  : null;

const SLUG = 'music-lollipop-demo-2026';
const crypto = new NodeSensitiveDataCrypto(
  Buffer.alloc(32, 1).toString('base64'),
  Buffer.alloc(32, 2).toString('base64'),
);
const queue = new DrizzleCommunicationQueueService();

describe.skipIf(!enabled)(
  'E3 Rollback Rehearsal (database integration)',
  { timeout: 90_000 },
  () => {
    let service: DrizzleDisposalService;
    let casesService: DrizzleCaseService;
    let staffUserId: string;
    let productId: string;

    beforeAll(async () => {
      service = new DrizzleDisposalService({ handle: handle!, notifications: queue });
      casesService = new DrizzleCaseService(
        handle!,
        crypto,
        undefined,
        undefined,
        undefined,
        false,
        queue,
        false,
        service,
        'http://localhost:3313',
      );
      const [staff] = await handle!.db.select({ id: staffUsers.id }).from(staffUsers).limit(1);
      const draft = await new DrizzleClaimDraftService(handle!.db).create(SLUG);
      const [draftRow] = await handle!.db
        .select({ campaignVersionId: claimDrafts.campaignVersionId })
        .from(claimDrafts)
        .where(eq(claimDrafts.id, draft!.draftId))
        .limit(1);
      const [product] = await handle!.db
        .select({ id: campaignProducts.id })
        .from(campaignProducts)
        .where(eq(campaignProducts.campaignVersionId, draftRow!.campaignVersionId))
        .limit(1);
      await handle!.db.delete(claimDrafts).where(eq(claimDrafts.id, draft!.draftId));

      staffUserId = staff!.id;
      productId = product!.id;
    });

    afterAll(async () => {
      await handle?.close();
    });

    it('withdraws an instruction version, suspends active authorizations, and preserves history', async () => {
      const db = handle!.db;
      const draft = await new DrizzleClaimDraftService(db).create(SLUG);
      const [draftRow] = await db
        .select({ campaignVersionId: claimDrafts.campaignVersionId })
        .from(claimDrafts)
        .where(eq(claimDrafts.id, draft!.draftId))
        .limit(1);
      const campaignVersionId = draftRow!.campaignVersionId;

      const [version] = await db
        .insert(disposalInstructionVersions)
        .values({
          campaignVersionId,
          versionNumber: 1_000_000 + Math.floor(Math.random() * 900_000),
          locale: 'en-US',
          status: 'approved',
          title: 'Rollback integration test instructions',
          steps: [{ order: 1, text: 'Do it.' }],
          referenceImages: [],
          safetyWarnings: ['Warning.'],
          recognitionRequirements: ['Label.'],
          declarationTextVersion: 'v1',
          approvedAt: new Date(),
          approvedByStaffUserId: staffUserId,
        })
        .returning({ id: disposalInstructionVersions.id });
      const versionId = version!.id;

      await db.insert(disposalInstructionApprovals).values({
        instructionVersionId: versionId,
        materialType: 'recall_expectation_letter',
        scope: 'consumer_held_product',
        measure: 'consumer_disposal',
        authorizesConsumerDisposal: true,
        recordedByStaffUserId: staffUserId,
      });

      // Every requirement the pinned campaign version asks for, or the submission
      // is refused before any disposal task can exist.
      const requirements = await db
        .select({
          category: campaignEvidenceRequirements.category,
          minimumFiles: campaignEvidenceRequirements.minimumFiles,
          required: campaignEvidenceRequirements.required,
        })
        .from(campaignEvidenceRequirements)
        .where(eq(campaignEvidenceRequirements.campaignVersionId, campaignVersionId));

      const claimDocumentIds: string[] = [];
      for (const requirement of requirements) {
        const needed = Math.max(requirement.minimumFiles, requirement.required ? 1 : 0);
        for (let slot = 1; slot <= needed; slot += 1) {
          const [uploaded] = await db
            .insert(documentUploads)
            .values({
              draftId: draft!.draftId,
              caseId: null,
              category: requirement.category,
              categorySlot: slot,
              storagePathname: `rollback-test/${draft!.draftId}/${randomUUID()}.jpg`,
              originalFileName: `${requirement.category}-${slot}.jpg`,
              declaredMimeType: 'image/jpeg',
              detectedMimeType: 'image/jpeg',
              sizeBytes: 1024,
              uploadStatus: 'verified',
              scanStatus: 'clean',
              expiresAt: new Date(Date.now() + 86400000),
            })
            .returning({ id: documentUploads.id });
          claimDocumentIds.push(uploaded!.id);
        }
      }

      const submitted = await casesService.submit({
        campaignSlug: SLUG,
        idempotencyKey: randomUUID(),
        body: {
          draftId: draft!.draftId,
          draftToken: draft!.draftToken,
          locale: 'en-US',
          remedyCode: 'replacement',
          consumer: {
            firstName: 'RB',
            lastName: 'Test',
            email: `rb-${Date.now()}@example.com`,
            phone: '+1-555-0199',
            currentDeliveryAddress: {
              line1: '1 W',
              city: 'Austin',
              state: 'TX',
              postalCode: '78701',
              countryCode: 'US',
            },
          },
          products: [
            {
              campaignProductId: productId,
              quantity: 1,
              shape: 'Bear',
              flavor: 'Peach',
              lotCode: 'ML',
              dateCode: '06/2024',
              identificationMode: 'product_identifiers',
              purchaseChannel: 'amazon',
              purchaseDate: '2026-07-15',
              orderNumber: 'ORD-999',
            },
          ],
          documentIds: claimDocumentIds,
          consents: [
            { type: 'privacy_notice', textVersion: '2026-08-04', accepted: true },
            { type: 'information_accuracy', textVersion: '2026-08-04', accepted: true },
          ],
          incidentAnswer: 'no',
        } as never,
      });

      const [caseRow] = await db
        .select({ id: recallCases.id })
        .from(recallCases)
        .where(eq(recallCases.publicReference, submitted.caseReference))
        .limit(1);
      const caseId = caseRow!.id;

      // Extract task credential from outbox
      const events = await db
        .select({ payload: outboxEvents.payload })
        .from(outboxEvents)
        .where(eq(outboxEvents.aggregateId, caseId))
        .limit(1);
      const resumeUrl = /https?:\/\/[^"\\]*\/disposal\/[0-9a-f-]{36}#token=[A-Za-z0-9_-]+/.exec(
        JSON.stringify(events),
      )?.[0];
      const taskId = /\/disposal\/([0-9a-f-]{36})#/.exec(resumeUrl ?? '')?.[1];
      const taskToken = /#token=([A-Za-z0-9_-]+)/.exec(resumeUrl ?? '')?.[1];
      const tId = taskId!;
      const tTok = taskToken!;

      await service.confirmProductAffected({
        taskId: tId,
        campaignProductId: productId,
        quantity: 1,
      });
      await service.confirmEligibility({
        taskId: tId,
        eligibilityStatus: 'confirmed_eligible',
        note: 'OK',
        expectedVersion: 1,
        actorStaffUserId: staffUserId,
      });

      const [evidence] = await db
        .insert(documentUploads)
        .values({
          draftId: draft!.draftId,
          caseId: null,
          category: 'disposal_evidence',
          categorySlot: null,
          storagePathname: `rollback-test/${draft!.draftId}/${randomUUID()}-d.jpg`,
          originalFileName: 'd.jpg',
          declaredMimeType: 'image/jpeg',
          detectedMimeType: 'image/jpeg',
          sizeBytes: 1024,
          uploadStatus: 'verified',
          scanStatus: 'clean',
          expiresAt: new Date(Date.now() + 86400000),
        })
        .returning({ id: documentUploads.id });

      const batch = await service.submitEvidenceBatch({
        taskId: tId,
        taskToken: tTok,
        idempotencyKey: randomUUID(),
        documents: [{ documentId: evidence!.id }],
        retentionUntil: null,
      });
      await service.reviewBatch({
        batchId: batch.batchId,
        decision: 'accepted',
        rationale: 'Accepted for the rollback rehearsal.',
        actorStaffUserId: staffUserId,
        actorRole: 'COMPLIANCE',
      });
      const issued = await service.issueAuthorization({
        taskId: tId,
        actorStaffUserId: staffUserId,
      });

      // --- EXECUTE E3 ROLLBACK ---
      // Withdraw the version the task actually pinned rather than the one this
      // test inserted: resolution picks among the campaign's approved versions,
      // and assuming which one it chose made the assertion depend on residue.
      const [pinnedTask] = await db
        .select({ instructionVersionId: disposalTasks.instructionVersionId })
        .from(disposalTasks)
        .where(eq(disposalTasks.id, tId))
        .limit(1);
      const pinnedVersionId = pinnedTask!.instructionVersionId;
      const suspendedCount = await service.withdrawInstruction({
        instructionVersionId: pinnedVersionId,
        reason: 'Emergency rollback rehearsal.',
        actorStaffUserId: staffUserId,
      });
      expect(suspendedCount).toBeGreaterThanOrEqual(1);

      // --- VERIFY INVARIANTS ---
      const [authRow] = await db
        .select({ status: disposalAuthorizations.status })
        .from(disposalAuthorizations)
        .where(eq(disposalAuthorizations.id, issued.authorizationId));
      expect(authRow?.status).toBe('suspended');

      const [batchRow] = await db
        .select({ reviewStatus: disposalEvidenceBatches.reviewStatus })
        .from(disposalEvidenceBatches)
        .where(eq(disposalEvidenceBatches.id, batch.batchId));
      // History survives: the batch review status is untouched (still 'accepted'), only the permission is suspended.
      expect(batchRow?.reviewStatus).toBe('accepted');

      const visitorDetail = await service.getTaskForVisitor(taskId!, taskToken!);
      expect(visitorDetail?.instruction).toBeNull();

      // Cleanup
      await db.delete(disposalAuthorizations).where(eq(disposalAuthorizations.taskId, taskId!));
      const batches = await db
        .select({ id: disposalEvidenceBatches.id })
        .from(disposalEvidenceBatches)
        .where(eq(disposalEvidenceBatches.taskId, taskId!));
      for (const b of batches) {
        await db.delete(disposalReviews).where(eq(disposalReviews.batchId, b.id));
      }
      await db.delete(disposalEvidenceBatches).where(eq(disposalEvidenceBatches.taskId, taskId!));
      await db.delete(disposalTasks).where(eq(disposalTasks.id, taskId!));
      await db.delete(documentUploads).where(eq(documentUploads.draftId, draft!.draftId));
      // The case subtree is restrict-heavy, so each dependent row is named.
      const incidentsForCase = await db
        .select({ id: incidents.id })
        .from(incidents)
        .where(eq(incidents.caseId, caseId));
      await db.delete(idempotencyRecords).where(eq(idempotencyRecords.caseId, caseId));
      await db.delete(communications).where(eq(communications.caseId, caseId));
      await db.delete(outboxEvents).where(eq(outboxEvents.aggregateId, caseId));
      await db.delete(caseEvents).where(eq(caseEvents.caseId, caseId));
      for (const incident of incidentsForCase) {
        await db
          .delete(reportabilityReviews)
          .where(eq(reportabilityReviews.incidentId, incident.id));
      }
      await db.delete(incidents).where(eq(incidents.caseId, caseId));
      await db.delete(submissionSnapshots).where(eq(submissionSnapshots.caseId, caseId));
      await db.delete(caseConsents).where(eq(caseConsents.caseId, caseId));
      await db.delete(caseResolutions).where(eq(caseResolutions.caseId, caseId));
      await db.delete(claimedProducts).where(eq(claimedProducts.caseId, caseId));
      await db.delete(caseConsumers).where(eq(caseConsumers.caseId, caseId));
      await db.delete(recallCases).where(eq(recallCases.id, caseId));
      await db.delete(claimDrafts).where(eq(claimDrafts.id, draft!.draftId));
      await db
        .delete(disposalInstructionApprovals)
        .where(eq(disposalInstructionApprovals.instructionVersionId, versionId));
      await db
        .delete(disposalInstructionVersions)
        .where(eq(disposalInstructionVersions.id, versionId));
    });
  },
);
