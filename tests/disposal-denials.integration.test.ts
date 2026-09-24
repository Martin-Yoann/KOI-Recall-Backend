// Opt-in integration test for the four preconditions under which a consumer must be
// told nothing about disposal.
//
// These are the negative cases P0-A names, and they are written against the required
// behaviour rather than the current one: with the product unconfirmed, or with an
// incident hold in force, the visitor must receive no instructions and no permission.
// The point is that a stale page cannot help itself either — every assertion here is
// made through the same calls that page would make.
import 'dotenv/config';

import { randomUUID } from 'node:crypto';

import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDatabase, type DatabaseHandle } from '../src/db/client.js';
import {
  campaignProducts,
  campaignVersions,
  claimDrafts,
  disposalInstructionApprovals,
  disposalInstructionVersions,
  disposalTasks,
  documentUploads,
  staffUsers,
} from '../src/db/schema/index.js';
import { DrizzleDisposalService } from '../src/modules/disposal/drizzle-disposal-service.js';
import { assertLocalIntegrationDatabase } from './helpers/db-guard.js';

assertLocalIntegrationDatabase(process.env.DATABASE_URL);

const enabled = process.env.RUN_DB_INTEGRATION === 'true' && Boolean(process.env.DATABASE_URL);
const handle: DatabaseHandle | null = enabled
  ? createDatabase(process.env.DATABASE_URL as string)
  : null;

const SEEDED_CAMPAIGN_ID = '2bdac8b0-73d8-4e38-a7e2-98fd5608788a';
const SEEDED_CAMPAIGN_VERSION_ID = '85eafab1-a5bd-4d57-a697-38bce973deab';

/** Actions that would let a consumer act on disposal. None may appear. */
const DISPOSAL_ACTIONS = [
  'disposal.submit_evidence',
  'disposal.resubmit_evidence',
  'disposal.declare_completion',
];

describe.skipIf(!enabled)('disposal denials (database integration)', { timeout: 120_000 }, () => {
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

  /** Its own campaign version and draft, so nothing is borrowed from the database. */
  async function fixture(options: { authorizes: boolean; approved: boolean }) {
    const db = handle!.db;
    const [campaignVersion] = await db
      .insert(campaignVersions)
      .values({
        campaignId: SEEDED_CAMPAIGN_ID,
        versionNumber: 500_000 + Math.floor(Math.random() * 90_000),
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
        title: 'Denial test instructions',
        steps: [{ order: 1, text: 'Follow the recall instructions.' }],
        referenceImages: [],
        safetyWarnings: ['Do not open the battery.'],
        recognitionRequirements: ['The label must be readable.'],
        declarationTextVersion: 'denial-v1',
        ...(options.approved ? { approvedAt: new Date(), approvedByStaffUserId: staffUserId } : {}),
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

  type Fixture = Awaited<ReturnType<typeof fixture>>;

  async function cleanup(built: Fixture, extra: { taskId?: string; documentIds?: string[] } = {}) {
    const db = handle!.db;
    if (extra.taskId) await db.delete(disposalTasks).where(eq(disposalTasks.id, extra.taskId));
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

  // ---- 1. the product is not yet confirmed ---------------------------------
  it('shows an unconfirmed consumer no instructions and no way to act', async () => {
    const opened = await openTask({ authorizes: true, approved: true });
    const detail = await service.getTaskForVisitor(opened.created!.taskId, opened.created!.token);

    expect(detail!.task.eligibilityStatus).toBe('pending_confirmation');
    expect(detail!.instruction).toBeNull();
    for (const action of DISPOSAL_ACTIONS) {
      expect(detail!.snapshot.allowedActions).not.toContain(action);
    }

    await cleanup(opened, { taskId: opened.created!.taskId });
  });

  // ---- 2. an incident hold is in force ------------------------------------
  it('shows nothing while the incident hold stands, and says why', async () => {
    const opened = await openTask({ authorizes: true, approved: true, hasIncident: true });
    const detail = await service.getTaskForVisitor(opened.created!.taskId, opened.created!.token);

    expect(detail!.snapshot.blockingReasons).toContain('DISPOSAL_ON_HOLD');
    expect(detail!.instruction).toBeNull();
    for (const action of DISPOSAL_ACTIONS) {
      expect(detail!.snapshot.allowedActions).not.toContain(action);
    }

    await cleanup(opened, { taskId: opened.created!.taskId });
  });

  // ---- 3. the approval is not in force ------------------------------------
  it('opens no task at all when no approved, authorizing version exists', async () => {
    for (const options of [
      { authorizes: true, approved: false },
      { authorizes: false, approved: true },
    ]) {
      const built = await fixture(options);
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
    }
  });

  it('stops showing instructions once the version is withdrawn', async () => {
    const opened = await openTask({ authorizes: true, approved: true });
    // Instructions are shown only once the product is confirmed, so the state has to
    // reach that point before a withdrawal can be observed removing them.
    await service.confirmProductAffected({
      taskId: opened.created!.taskId,
      campaignProductId: productId,
      quantity: 1,
    });
    await service.confirmEligibility({
      taskId: opened.created!.taskId,
      eligibilityStatus: 'confirmed_eligible',
      note: 'Confirmed so the withdrawal has something to remove.',
      actorStaffUserId: staffUserId,
      expectedVersion: 1,
    });

    const before = await service.getTaskForVisitor(opened.created!.taskId, opened.created!.token);
    expect(before!.instruction).not.toBeNull();

    await service.withdrawInstruction({
      instructionVersionId: opened.versionId,
      reason: 'Withdrawn during a denial test.',
      actorStaffUserId: staffUserId,
    });

    const after = await service.getTaskForVisitor(opened.created!.taskId, opened.created!.token);
    expect(after!.instruction).toBeNull();
    for (const action of DISPOSAL_ACTIONS) {
      expect(after!.snapshot.allowedActions).not.toContain(action);
    }

    await cleanup(opened, { taskId: opened.created!.taskId });
  });

  // ---- 4. only the technical scan passed -----------------------------------
  it('treats a technically verified file as nothing more than that', async () => {
    const opened = await openTask({ authorizes: true, approved: true });
    const taskId = opened.created!.taskId;

    await service.confirmProductAffected({ taskId, campaignProductId: productId, quantity: 1 });
    await service.confirmEligibility({
      taskId,
      eligibilityStatus: 'confirmed_eligible',
      note: 'Confirmed during a denial test.',
      actorStaffUserId: staffUserId,
      expectedVersion: 1,
    });

    const [document] = await handle!.db
      .insert(documentUploads)
      .values({
        draftId: opened.draftId,
        caseId: null,
        category: 'disposal_evidence',
        categorySlot: null,
        storagePathname: `denial-test/${opened.draftId}/${randomUUID()}.jpg`,
        originalFileName: 'before.jpg',
        declaredMimeType: 'image/jpeg',
        detectedMimeType: 'image/jpeg',
        sizeBytes: 1024,
        uploadStatus: 'verified',
        scanStatus: 'clean',
        expiresAt: new Date(Date.now() + 86_400_000),
      })
      .returning({ id: documentUploads.id });

    const batch = await service.submitEvidenceBatch({
      taskId,
      taskToken: opened.created!.token,
      idempotencyKey: randomUUID(),
      documents: [{ documentId: document!.id }],
      retentionUntil: null,
    });
    expect(batch.reviewStatus).toBe('pending');

    const detail = await service.getTaskForVisitor(taskId, opened.created!.token);
    // The file passed its checks; that is a statement about the file, not about the
    // product. Nothing may be declared and no permission exists.
    expect(detail!.snapshot.blockingReasons).toContain('EVIDENCE_PENDING_REVIEW');
    expect(detail!.snapshot.maySubmitEvidence).toBe(false);
    expect(detail!.snapshot.allowedActions).not.toContain('disposal.declare_completion');
    expect(detail!.snapshot.allowedActions).not.toContain('disposal.submit_evidence');

    // A second batch while the first awaits review is refused through the same call
    // the page would make.
    await expect(
      service.submitEvidenceBatch({
        taskId,
        taskToken: opened.created!.token,
        idempotencyKey: randomUUID(),
        documents: [{ documentId: document!.id }],
        retentionUntil: null,
      }),
    ).rejects.toThrow();

    await cleanup(opened, { taskId, documentIds: [document!.id] });
  });
});
