import { assertLocalIntegrationDatabase } from './helpers/db-guard.js';
// Opt-in integration test for the draft cleanup path.
// Runs only when RUN_DB_INTEGRATION=true AND DATABASE_URL is set.
import 'dotenv/config';

import { randomUUID } from 'node:crypto';

import { eq } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';

import type { DatabaseHandle } from '../src/db/client.js';
import { createDatabase } from '../src/db/client.js';
import {
  claimDrafts,
  disposalEvidenceBatchDocuments,
  disposalEvidenceBatches,
  disposalInstructionVersions,
  disposalTasks,
  documentUploads,
} from '../src/db/schema/index.js';
import { DrizzleDraftCleanupWorker } from '../src/jobs/draft-cleanup-worker.js';
import type {
  BlobAccessUrl,
  PrivateBlobPort,
  UploadAuthorization,
  UploadCompletion,
} from '../src/platform/blob/port.js';

const enabled = process.env.RUN_DB_INTEGRATION === 'true' && Boolean(process.env.DATABASE_URL);

assertLocalIntegrationDatabase(process.env.DATABASE_URL);
const handle: DatabaseHandle | null = enabled
  ? createDatabase(process.env.DATABASE_URL as string)
  : null;

class RecordingBlob implements PrivateBlobPort {
  deleted: string[] = [];
  constructor(private readonly fail = false) {}
  authorizeClientUpload(): Promise<UploadAuthorization> {
    return Promise.reject(new Error('not used in cleanup'));
  }
  handleUploadCallback(): Promise<UploadCompletion | null> {
    return Promise.resolve(null);
  }
  delete(pathname: string): Promise<void> {
    if (this.fail) return Promise.reject(new Error('blob down'));
    this.deleted.push(pathname);
    return Promise.resolve();
  }
  createAccessUrl(): Promise<BlobAccessUrl> {
    return Promise.reject(new Error('not used in cleanup'));
  }
}

async function createDocumentOwner(): Promise<string> {
  const draftId = randomUUID();
  await handle!.db.insert(claimDrafts).values({
    id: draftId,
    campaignId: '2bdac8b0-73d8-4e38-a7e2-98fd5608788a',
    campaignVersionId: '85eafab1-a5bd-4d57-a697-38bce973deab',
    tokenHash: randomUUID(),
    expiresAt: new Date(Date.now() + 60_000),
  });
  return draftId;
}

describe.skipIf(!enabled)('DrizzleDraftCleanupWorker (database integration)', () => {
  afterAll(async () => {
    await handle?.close();
  });

  it('returns zeros when nothing is due', async () => {
    const worker = new DrizzleDraftCleanupWorker(handle!.db, new RecordingBlob());
    await expect(worker.runBatch()).resolves.toEqual({ deleted: 0, pending: 0 });
  });

  it('deletes an expired document and its blob object', async () => {
    const db = handle!.db;
    const blob = new RecordingBlob();
    const draftId = await createDocumentOwner();
    const [inserted] = await db
      .insert(documentUploads)
      .values({
        draftId,
        caseId: null,
        category: 'product_photo',
        categorySlot: null,
        storagePathname: `tests/cleanup/${Date.now()}/photo.jpg`,
        originalFileName: 'photo.jpg',
        declaredMimeType: 'image/jpeg',
        detectedMimeType: 'image/jpeg',
        sizeBytes: 100,
        uploadStatus: 'deletion_pending',
        scanStatus: 'clean',
        expiresAt: new Date(Date.now() - 1000),
      })
      .returning({ id: documentUploads.id, storagePathname: documentUploads.storagePathname });

    const worker = new DrizzleDraftCleanupWorker(db, blob);
    const result = await worker.runBatch();
    expect(result.deleted).toBeGreaterThanOrEqual(1);
    expect(blob.deleted).toContain(inserted!.storagePathname);

    const [row] = await db
      .select()
      .from(documentUploads)
      .where(eq(documentUploads.id, inserted!.id));
    expect(row?.uploadStatus).toBe('deleted');

    await db.delete(documentUploads).where(eq(documentUploads.id, inserted!.id));
    await db.delete(claimDrafts).where(eq(claimDrafts.id, draftId));
  });

  it('keeps deletion_pending when the blob deletion fails', async () => {
    const db = handle!.db;
    const blob = new RecordingBlob(true);
    const draftId = await createDocumentOwner();
    const [inserted] = await db
      .insert(documentUploads)
      .values({
        draftId,
        caseId: null,
        category: 'proof_of_purchase',
        categorySlot: null,
        storagePathname: `tests/cleanup-fail/${Date.now()}/receipt.pdf`,
        originalFileName: 'receipt.pdf',
        declaredMimeType: 'application/pdf',
        detectedMimeType: 'application/pdf',
        sizeBytes: 200,
        uploadStatus: 'deletion_pending',
        scanStatus: 'clean',
        expiresAt: new Date(Date.now() - 1000),
      })
      .returning({ id: documentUploads.id });

    const worker = new DrizzleDraftCleanupWorker(db, blob);
    const result = await worker.runBatch();
    expect(result.pending).toBeGreaterThanOrEqual(1);

    const [row] = await db
      .select()
      .from(documentUploads)
      .where(eq(documentUploads.id, inserted!.id));
    expect(row?.uploadStatus).toBe('deletion_pending');

    await db.delete(documentUploads).where(eq(documentUploads.id, inserted!.id));
    await db.delete(claimDrafts).where(eq(claimDrafts.id, draftId));
  });

  /**
   * The regression this whole guard exists for: photo evidence awaiting a human
   * review is technically `verified` and carries the ordinary 48-hour upload
   * expiry, so without the retention rule the reaper silently destroys the
   * evidence an operator still has to look at.
   */
  describe('disposal evidence retention', () => {
    async function createRetainedEvidence(retentionUntil: Date | null) {
      const db = handle!.db;
      const draftId = await createDocumentOwner();
      const [document] = await db
        .insert(documentUploads)
        .values({
          draftId,
          caseId: null,
          category: 'disposal_evidence',
          categorySlot: null,
          storagePathname: `tests/retention/${Date.now()}/${randomUUID()}.jpg`,
          originalFileName: 'disposal.jpg',
          declaredMimeType: 'image/jpeg',
          detectedMimeType: 'image/jpeg',
          sizeBytes: 512,
          uploadStatus: 'verified',
          scanStatus: 'clean',
          // Long past: without retention this is a ripe candidate.
          expiresAt: new Date(Date.now() - 3_600_000),
        })
        .returning({ id: documentUploads.id });

      const [version] = await db
        .insert(disposalInstructionVersions)
        .values({
          campaignVersionId: '85eafab1-a5bd-4d57-a697-38bce973deab',
          versionNumber: 900_001 + Math.floor(Math.random() * 90_000),
          locale: 'en-US',
          title: 'Retention test instructions (temporary)',
          steps: [{ order: 1, text: 'Temporary.' }],
          referenceImages: [],
          safetyWarnings: ['Temporary.'],
          recognitionRequirements: ['Temporary.'],
          declarationTextVersion: 'retention-test-v1',
        })
        .returning({ id: disposalInstructionVersions.id });

      const [task] = await db
        .insert(disposalTasks)
        .values({
          instructionVersionId: version!.id,
          draftId,
          tokenHash: randomUUID().replace(/-/g, ''),
          tokenExpiresAt: new Date(Date.now() + 86_400_000),
        })
        .returning({ id: disposalTasks.id });

      const [batch] = await db
        .insert(disposalEvidenceBatches)
        .values({
          taskId: task!.id,
          batchNumber: 1,
          retentionUntil,
          idempotencyKeyHash: randomUUID().replace(/-/g, ''),
        })
        .returning({ id: disposalEvidenceBatches.id });

      await db.insert(disposalEvidenceBatchDocuments).values({
        batchId: batch!.id,
        documentId: document!.id,
        campaignProductId: null,
        quantityCovered: 1,
      });

      return {
        draftId,
        documentId: document!.id,
        taskId: task!.id,
        versionId: version!.id,
        batchId: batch!.id,
      };
    }

    async function cleanup(fixture: Awaited<ReturnType<typeof createRetainedEvidence>>) {
      const db = handle!.db;
      await db
        .delete(disposalEvidenceBatchDocuments)
        .where(eq(disposalEvidenceBatchDocuments.batchId, fixture.batchId));
      await db
        .delete(disposalEvidenceBatches)
        .where(eq(disposalEvidenceBatches.id, fixture.batchId));
      await db.delete(disposalTasks).where(eq(disposalTasks.id, fixture.taskId));
      await db
        .delete(disposalInstructionVersions)
        .where(eq(disposalInstructionVersions.id, fixture.versionId));
      await db.delete(documentUploads).where(eq(documentUploads.id, fixture.documentId));
      await db.delete(claimDrafts).where(eq(claimDrafts.id, fixture.draftId));
    }

    it('never reaps expired evidence that is awaiting review', async () => {
      const db = handle!.db;
      const fixture = await createRetainedEvidence(null);
      const blob = new RecordingBlob();

      await new DrizzleDraftCleanupWorker(db, blob).runBatch();

      const [row] = await db
        .select()
        .from(documentUploads)
        .where(eq(documentUploads.id, fixture.documentId));
      expect(blob.deleted).not.toContain('tests/retention');
      expect(row?.uploadStatus).toBe('verified');
      await cleanup(fixture);
      // Six fixture round trips plus the worker run; the 5s default assumes a
      // local database, and this suite also runs against a remote one.
    }, 30_000);

    it('keeps evidence inside a future retention window', async () => {
      const db = handle!.db;
      const fixture = await createRetainedEvidence(new Date(Date.now() + 86_400_000));
      const blob = new RecordingBlob();

      await new DrizzleDraftCleanupWorker(db, blob).runBatch();

      const [row] = await db
        .select()
        .from(documentUploads)
        .where(eq(documentUploads.id, fixture.documentId));
      expect(row?.uploadStatus).toBe('verified');
      await cleanup(fixture);
    }, 30_000);

    // Retention is a deadline, not a permanent exemption: once the window has
    // elapsed the ordinary cleanup policy applies again.
    it('reaps evidence whose retention window has elapsed', async () => {
      const db = handle!.db;
      const fixture = await createRetainedEvidence(new Date(Date.now() - 1000));
      const blob = new RecordingBlob();

      await new DrizzleDraftCleanupWorker(db, blob).runBatch();

      const [row] = await db
        .select()
        .from(documentUploads)
        .where(eq(documentUploads.id, fixture.documentId));
      expect(row?.uploadStatus).toBe('deleted');
      await cleanup(fixture);
    }, 30_000);
  });
});
