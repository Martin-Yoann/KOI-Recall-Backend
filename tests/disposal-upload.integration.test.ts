// Opt-in integration test for the task-scoped evidence upload path.
// Runs only when RUN_DB_INTEGRATION=true AND DATABASE_URL is set.
//
// This suite exists because an earlier one inserted `document_uploads` rows
// directly and therefore proved nothing about the real path: a submitted claim
// cannot obtain a draft-scoped upload token, so the evidence for a disposal task
// had no way to become `verified` at all. Every document here is created through
// the upload-token step a browser would use.
import 'dotenv/config';

import { and, desc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDatabase, type DatabaseHandle } from '../src/db/client.js';
import {
  claimDrafts,
  disposalInstructionApprovals,
  disposalInstructionVersions,
  disposalTasks,
  documentUploads,
  campaignEvidenceRequirements,
  campaignProducts,
  recallCampaigns,
  staffUsers,
} from '../src/db/schema/index.js';
import { DrizzleDocumentService } from '../src/modules/documents/drizzle-document-service.js';
import { DrizzleDisposalService } from '../src/modules/disposal/drizzle-disposal-service.js';
import { VerificationRequiredBlob } from './helpers/verification-blob.js';

const enabled = process.env.RUN_DB_INTEGRATION === 'true' && Boolean(process.env.DATABASE_URL);
const handle: DatabaseHandle | null = enabled
  ? createDatabase(process.env.DATABASE_URL as string)
  : null;

const SEEDED_CAMPAIGN_ID = '2bdac8b0-73d8-4e38-a7e2-98fd5608788a';
const SEEDED_CAMPAIGN_VERSION_ID = '85eafab1-a5bd-4d57-a697-38bce973deab';

describe.skipIf(!enabled)('disposal evidence upload path', { timeout: 120_000 }, () => {
  let disposal: DrizzleDisposalService;
  let documents: DrizzleDocumentService;
  let staffUserId: string;
  let productId: string;
  let campaignVersionId: string;
  const createdVersionIds: string[] = [];
  const createdTaskIds: string[] = [];
  const createdDraftIds: string[] = [];

  beforeAll(async () => {
    const db = handle!.db;
    const [staff] = await db.select({ id: staffUsers.id }).from(staffUsers).limit(1);
    if (!staff) throw new Error('Seed data is required.');
    staffUserId = staff.id;

    // Use the campaign a real claim flow uses, and its pinned version.
    const [campaign] = await db
      .select({ versionId: recallCampaigns.publishedVersionId })
      .from(recallCampaigns)
      .where(eq(recallCampaigns.id, SEEDED_CAMPAIGN_ID));
    campaignVersionId = campaign!.versionId ?? SEEDED_CAMPAIGN_VERSION_ID;

    const [product] = await db
      .select({ id: campaignProducts.id })
      .from(campaignProducts)
      .where(eq(campaignProducts.campaignVersionId, campaignVersionId))
      .limit(1);
    productId = product!.id;

    disposal = new DrizzleDisposalService({ handle: handle! });
    documents = new DrizzleDocumentService(
      handle!.db,
      new VerificationRequiredBlob(() => `drafts/${crypto.randomUUID()}/photo.jpg`),
      (work) => handle!.transaction(work),
      false,
    );

    // A campaign only accepts the disposal_evidence category if it declares a
    // rule for it. Add one for the test and remove it afterwards, so the
    // environment is left as it was found — the feature ships dark.
    const [existing] = await db
      .select({ id: campaignEvidenceRequirements.id })
      .from(campaignEvidenceRequirements)
      .where(
        and(
          eq(campaignEvidenceRequirements.campaignVersionId, campaignVersionId),
          eq(campaignEvidenceRequirements.category, 'disposal_evidence'),
        ),
      );
    if (!existing) {
      await db.insert(campaignEvidenceRequirements).values({
        campaignVersionId,
        category: 'disposal_evidence',
        required: false,
        minimumFiles: 0,
        maximumFiles: 5,
        allowedMimeTypes: ['image/jpeg', 'image/png'],
        maximumFileSizeBytes: 10 * 1024 * 1024,
        instructions: 'Temporary fixture rule; removed after the test.',
      });
    }
  });

  afterAll(async () => {
    if (!handle) return;
    const db = handle.db;
    for (const taskId of createdTaskIds) {
      await db.delete(disposalTasks).where(eq(disposalTasks.id, taskId));
    }
    for (const versionId of createdVersionIds) {
      await db
        .delete(disposalInstructionApprovals)
        .where(eq(disposalInstructionApprovals.instructionVersionId, versionId));
      await db
        .delete(disposalInstructionVersions)
        .where(eq(disposalInstructionVersions.id, versionId));
    }
    for (const draftId of createdDraftIds) {
      await db.delete(documentUploads).where(eq(documentUploads.draftId, draftId));
      await db.delete(claimDrafts).where(eq(claimDrafts.id, draftId));
    }
    await db
      .delete(campaignEvidenceRequirements)
      .where(
        and(
          eq(campaignEvidenceRequirements.campaignVersionId, campaignVersionId),
          eq(campaignEvidenceRequirements.category, 'disposal_evidence'),
        ),
      );
    await handle.close();
    // Cleanup is many sequential deletes; the 10s default assumes a local database.
  }, 120_000);

  /** A draft that has already been submitted, as a real task's draft would be. */
  async function submittedDraft(): Promise<string> {
    const draftId = crypto.randomUUID();
    await handle!.db.insert(claimDrafts).values({
      id: draftId,
      campaignId: SEEDED_CAMPAIGN_ID,
      campaignVersionId,
      tokenHash: crypto.randomUUID().replace(/-/g, '').repeat(2).slice(0, 64),
      expiresAt: new Date(Date.now() + 86_400_000),
      // This is the state the draft is in once a claim is submitted, and the
      // reason the draft-scoped upload route cannot serve disposal evidence.
      status: 'submitted',
    });
    createdDraftIds.push(draftId);
    return draftId;
  }

  /**
   * Leaves no approved instruction version on the shared campaign version, so an
   * assertion about absence is about absent content rather than test ordering:
   * earlier cases in this file create approved versions on the same version.
   */
  async function demoteApprovedVersions(): Promise<void> {
    await handle!.db
      .update(disposalInstructionVersions)
      .set({ status: 'draft' })
      .where(
        and(
          eq(disposalInstructionVersions.campaignVersionId, campaignVersionId),
          eq(disposalInstructionVersions.status, 'approved'),
        ),
      );
  }

  async function openTask(options: { approved?: boolean; authorizes?: boolean } = {}) {
    const db = handle!.db;
    const draftId = await submittedDraft();
    const [highest] = await db
      .select({ versionNumber: disposalInstructionVersions.versionNumber })
      .from(disposalInstructionVersions)
      .where(eq(disposalInstructionVersions.campaignVersionId, campaignVersionId))
      .orderBy(desc(disposalInstructionVersions.versionNumber))
      .limit(1);

    const [version] = await db
      .insert(disposalInstructionVersions)
      .values({
        campaignVersionId,
        versionNumber: (highest?.versionNumber ?? 0) + 1,
        locale: 'en-US',
        status: options.approved === false ? 'draft' : 'approved',
        title: 'Upload-path integration instructions',
        steps: [{ order: 1, text: 'Follow the recall instructions.' }],
        referenceImages: [],
        safetyWarnings: ['Do not open or damage the battery.'],
        recognitionRequirements: ['The product label must be readable.'],
        declarationTextVersion: 'upload-integration-v1',
        ...(options.approved === false
          ? {}
          : { approvedAt: new Date(), approvedByStaffUserId: staffUserId }),
      })
      .returning({ id: disposalInstructionVersions.id });
    createdVersionIds.push(version!.id);

    await db.insert(disposalInstructionApprovals).values({
      instructionVersionId: version!.id,
      materialType: 'recall_expectation_letter',
      scope: 'consumer_held_product',
      measure: options.authorizes === false ? 'consumer_return' : 'consumer_disposal',
      authorizesConsumerDisposal: options.authorizes !== false,
      recordedByStaffUserId: staffUserId,
    });

    const opened = await handle!.transaction((tx) =>
      disposal.createTaskForSubmission(tx, {
        draftId,
        caseId: null,
        campaignVersionId,
        productIds: [productId],
        hasIncident: false,
      }),
    );
    if (!opened) return null;
    createdTaskIds.push(opened.taskId);
    return { ...opened, draftId, versionId: version!.id };
  }

  /** Drives the task to `confirmed_eligible`, which the upload gate requires. */
  async function confirmEligibility(taskId: string) {
    await disposal.confirmProductAffected({ taskId, campaignProductId: productId, quantity: 1 });
    await disposal.confirmEligibility({
      taskId,
      eligibilityStatus: 'confirmed_eligible',
      note: 'Confirmed against the recall notice.',
      actorStaffUserId: staffUserId,
      expectedVersion: 1,
    });
  }

  it('authorises an upload for a submitted draft, which the draft route cannot', async () => {
    const opened = await openTask();
    expect(opened).not.toBeNull();
    const taskId = opened!.taskId;
    await confirmEligibility(taskId);

    const { draftId } = await disposal.assertCanUploadEvidence(taskId, opened!.token);
    expect(draftId).toBe(opened!.draftId);

    // The real authorisation the browser would receive.
    const authorization = await documents.authorizeUpload({
      draftId,
      category: 'disposal_evidence',
      fileName: 'before.jpg',
      mimeType: 'image/jpeg',
      sizeBytes: 2048,
    });
    expect(authorization.documentId).toBeTruthy();

    // The row exists in the state the upload flow starts from.
    const [row] = await handle!.db
      .select({ uploadStatus: documentUploads.uploadStatus, category: documentUploads.category })
      .from(documentUploads)
      .where(eq(documentUploads.id, authorization.documentId));
    expect(row?.uploadStatus).toBe('authorized');
    expect(row?.category).toBe('disposal_evidence');
  });

  it('refuses an upload before eligibility is confirmed', async () => {
    const opened = await openTask();
    await expect(disposal.assertCanUploadEvidence(opened!.taskId, opened!.token)).rejects.toThrow(
      /ELIGIBILITY_NOT_CONFIRMED|Evidence cannot be uploaded/i,
    );
  });

  it('refuses an upload while a retention hold is in force', async () => {
    const opened = await openTask();
    await confirmEligibility(opened!.taskId);
    await disposal.placeHold({
      taskId: opened!.taskId,
      reason: 'compliance_investigation',
      note: 'Investigating a related report before evidence is collected.',
      actorStaffUserId: staffUserId,
    });
    await expect(disposal.assertCanUploadEvidence(opened!.taskId, opened!.token)).rejects.toThrow(
      /DISPOSAL_ON_HOLD|Evidence cannot be uploaded/i,
    );
  });

  it('refuses an upload with a wrong credential', async () => {
    const opened = await openTask();
    await confirmEligibility(opened!.taskId);
    await expect(
      disposal.assertCanUploadEvidence(opened!.taskId, 'not-the-real-token'),
    ).rejects.toThrow();
  });

  it('lists the task documents with the shared six-state vocabulary', async () => {
    const opened = await openTask();
    await confirmEligibility(opened!.taskId);
    const authorization = await documents.authorizeUpload({
      draftId: opened!.draftId,
      category: 'disposal_evidence',
      fileName: 'label.jpg',
      mimeType: 'image/jpeg',
      sizeBytes: 1024,
    });

    const list = await disposal.listEvidenceDocuments(opened!.taskId, opened!.token);
    expect(list).toHaveLength(1);
    expect(list[0]?.documentId).toBe(authorization.documentId);
    expect(list[0]?.fileName).toBe('label.jpg');
    // Freshly authorised with no bytes yet. Technical only — never "accepted".
    expect(list[0]?.status).toBe('uploading');
  });

  it('never opens a task when the instruction is not approved', async () => {
    await demoteApprovedVersions();
    const opened = await openTask({ approved: false });
    expect(opened).toBeNull();
  });

  // The gate that D25 turns on: approved content, non-authorizing material.
  it('never opens a task when the approval does not authorize disposal', async () => {
    await demoteApprovedVersions();
    const opened = await openTask({ authorizes: false });
    expect(opened).toBeNull();
  });
});
