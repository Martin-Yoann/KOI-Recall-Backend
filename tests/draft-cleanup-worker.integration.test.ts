// Opt-in integration test for the draft cleanup path.
// Runs only when RUN_DB_INTEGRATION=true AND DATABASE_URL is set.
import 'dotenv/config';

import { randomUUID } from 'node:crypto';

import { eq } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';

import type { DatabaseHandle } from '../src/db/client.js';
import { createDatabase } from '../src/db/client.js';
import { claimDrafts, documentUploads } from '../src/db/schema/index.js';
import { DrizzleDraftCleanupWorker } from '../src/jobs/draft-cleanup-worker.js';
import type {
  PrivateBlobPort,
  UploadAuthorization,
  UploadCompletion,
} from '../src/platform/blob/port.js';

const enabled = process.env.RUN_DB_INTEGRATION === 'true' && Boolean(process.env.DATABASE_URL);
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
});
