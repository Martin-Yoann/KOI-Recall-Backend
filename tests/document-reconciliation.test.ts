import { describe, expect, it } from 'vitest';

import type { Database, DatabaseExecutor, DatabaseHandle } from '../src/db/client.js';
import {
  campaignEvidenceRequirements,
  claimDrafts,
  documentUploads,
  webhookEvents,
} from '../src/db/schema/index.js';
import { DrizzleDocumentService } from '../src/modules/documents/drizzle-document-service.js';
import { NotImplementedPrivateBlobAdapter } from '../src/platform/blob/not-implemented.js';
import type { PrivateBlobPort, UploadAuthorizationRequest } from '../src/platform/blob/port.js';
import { EvidenceRulesViolationError } from '../src/shared/errors.js';

type WebhookStatus = 'received' | 'processing' | 'processed' | 'failed';

class FakeReconciliationDatabase {
  readonly document = {
    declaredMimeType: 'image/jpeg',
    uploadStatus: 'authorized',
    scanStatus: 'pending',
    storagePathname: 'drafts/draft/document/product.jpg',
  };

  readonly webhook = {
    id: '7f0c5bde-6068-42ab-a004-c2cc117d84a0',
    providerEventId: '',
    status: undefined as WebhookStatus | undefined,
    lastErrorCode: null as string | null,
  };

  failNextDocumentUpdate = false;
  failNextFailureStatusUpdate = false;
  /** Every upload_status value written to the document row, in write order. */
  readonly uploadStatusWrites: string[] = [];

  insert(table: unknown) {
    if (table !== webhookEvents) throw new Error('Unexpected insert table');
    return {
      values: (values: Record<string, unknown>) => {
        const performLegacyInsert = () => {
          if (this.webhook.status) {
            throw Object.assign(new Error('duplicate webhook'), { code: '23505' });
          }
          this.webhook.providerEventId = String(values.providerEventId);
          this.webhook.status = 'received';
          return [];
        };

        return {
          then: <TResult1 = unknown, TResult2 = never>(
            onfulfilled?: ((value: unknown) => TResult1 | PromiseLike<TResult1>) | null,
            onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
          ) => Promise.resolve().then(performLegacyInsert).then(onfulfilled, onrejected),
          onConflictDoUpdate: () => ({
            returning: () => {
              if (!this.webhook.status) {
                this.webhook.providerEventId = String(values.providerEventId);
                this.webhook.status = 'processing';
                return Promise.resolve([{ id: this.webhook.id }]);
              }
              if (
                this.webhook.status === 'received' ||
                this.webhook.status === 'processing' ||
                this.webhook.status === 'failed'
              ) {
                this.webhook.status = 'processing';
                this.webhook.lastErrorCode = null;
                return Promise.resolve([{ id: this.webhook.id }]);
              }
              return Promise.resolve([]);
            },
          }),
        };
      },
    };
  }

  select(_selection: unknown) {
    return {
      from: (table: unknown) => ({
        where: () => ({
          limit: () => {
            if (table !== documentUploads) throw new Error('Unexpected select table');
            return Promise.resolve([
              {
                declaredMimeType: this.document.declaredMimeType,
                status: this.document.uploadStatus,
              },
            ]);
          },
        }),
      }),
    };
  }

  update(table: unknown) {
    return {
      set: (values: Record<string, unknown>) => ({
        where: () => ({
          execute: () => {
            if (table === documentUploads) {
              if (this.failNextDocumentUpdate) {
                this.failNextDocumentUpdate = false;
                return Promise.reject(new Error('temporary document update failure'));
              }
              if (typeof values.uploadStatus === 'string') {
                this.document.uploadStatus = values.uploadStatus;
                this.uploadStatusWrites.push(values.uploadStatus);
              }
              if (typeof values.storagePathname === 'string') {
                this.document.storagePathname = values.storagePathname;
              }
              if (typeof values.scanStatus === 'string') {
                this.document.scanStatus = values.scanStatus;
              }
              return Promise.resolve();
            }
            if (table === webhookEvents) {
              if (values.status === 'failed' && this.failNextFailureStatusUpdate) {
                this.failNextFailureStatusUpdate = false;
                return Promise.reject(new Error('temporary webhook status update failure'));
              }
              if (typeof values.status === 'string') {
                this.webhook.status = values.status as WebhookStatus;
              }
              if (typeof values.lastErrorCode === 'string' || values.lastErrorCode === null) {
                this.webhook.lastErrorCode = values.lastErrorCode;
              }
              return Promise.resolve();
            }
            return Promise.reject(new Error('Unexpected update table'));
          },
        }),
      }),
    };
  }
}

const completion = {
  documentId: 'a996d56a-da5e-49c3-bf76-665130bbb88a',
  detectedMimeType: 'image/jpeg',
  sizeBytes: 2048,
  pathname: 'drafts/draft/document/product-random.jpg',
};

const event = {
  providerEventId: 'evt-reconciliation-1',
  eventType: 'blob.upload-completed',
  payload: { type: 'blob.upload-completed' },
};

function serviceWith(fake: FakeReconciliationDatabase, malwareScanRequired = false) {
  const transaction: DatabaseHandle['transaction'] = (work) =>
    work(fake as unknown as DatabaseExecutor);
  return new DrizzleDocumentService(
    fake as unknown as Database,
    new NotImplementedPrivateBlobAdapter(),
    transaction,
    malwareScanRequired,
  );
}

describe('DrizzleDocumentService upload reconciliation', () => {
  it('stores the provider pathname and marks a completed webhook as processed', async () => {
    const fake = new FakeReconciliationDatabase();

    await expect(serviceWith(fake).reconcileCompletedUpload(completion, event)).resolves.toBe(true);

    expect(fake.document).toMatchObject({
      uploadStatus: 'verified',
      storagePathname: 'drafts/draft/document/product-random.jpg',
    });
    expect(fake.webhook.status).toBe('processed');
  });

  it('keeps the scan pending when malware scanning is required', async () => {
    const fake = new FakeReconciliationDatabase();

    await serviceWith(fake, true).reconcileCompletedUpload(completion, event);

    expect(fake.document.uploadStatus).toBe('verified');
    expect(fake.document.scanStatus).toBe('pending');
  });

  it('reprocesses a failed webhook delivery instead of treating it as completed', async () => {
    const fake = new FakeReconciliationDatabase();
    fake.failNextDocumentUpdate = true;
    const service = serviceWith(fake);

    await expect(service.reconcileCompletedUpload(completion, event)).rejects.toThrow(
      'temporary document update failure',
    );
    expect(fake.webhook.status).toBe('failed');

    await expect(service.reconcileCompletedUpload(completion, event)).resolves.toBe(true);
    expect(fake.document.uploadStatus).toBe('verified');
    expect(fake.document.scanStatus).toBe('not_run');
    expect(fake.webhook.status).toBe('processed');
  });

  it('reclaims a processing event when recording the previous failure also failed', async () => {
    const fake = new FakeReconciliationDatabase();
    fake.failNextDocumentUpdate = true;
    fake.failNextFailureStatusUpdate = true;
    const service = serviceWith(fake);

    await expect(service.reconcileCompletedUpload(completion, event)).rejects.toThrow(
      'temporary document update failure',
    );
    expect(fake.webhook.status).toBe('processing');

    await expect(service.reconcileCompletedUpload(completion, event)).resolves.toBe(true);
    expect(fake.document.uploadStatus).toBe('verified');
    expect(fake.webhook.status).toBe('processed');
  });

  it('stores the provider pathname when deletion was requested before the callback', async () => {
    const fake = new FakeReconciliationDatabase();
    fake.document.uploadStatus = 'deletion_pending';

    await expect(serviceWith(fake).reconcileCompletedUpload(completion, event)).resolves.toBe(true);

    expect(fake.document).toMatchObject({
      uploadStatus: 'deletion_pending',
      storagePathname: 'drafts/draft/document/product-random.jpg',
    });
    expect(fake.webhook.status).toBe('processed');
  });

  it('writes an observable uploaded row state before the verification verdict', async () => {
    // Phase 1 flips authorized → uploaded (public `verifying`), phase 2 issues
    // the verdict — both before the webhook event is acknowledged.
    const fake = new FakeReconciliationDatabase();

    await serviceWith(fake, true).reconcileCompletedUpload(completion, event);

    expect(fake.uploadStatusWrites).toEqual(['uploaded', 'verified']);
    expect(fake.document.scanStatus).toBe('pending');
  });

  it('rejects on detected/declared media-type divergence after the intermediate state', async () => {
    const fake = new FakeReconciliationDatabase();
    const mismatched = { ...completion, detectedMimeType: 'application/octet-stream' };

    await serviceWith(fake).reconcileCompletedUpload(mismatched, event);

    expect(fake.uploadStatusWrites).toEqual(['uploaded', 'rejected']);
    expect(fake.document.uploadStatus).toBe('rejected');
    // A media-type rejection never claims a scan ran.
    expect(fake.document.scanStatus).toBe('not_run');
  });
});

class FakeUploadDatabase {
  readonly documentRows: Array<Record<string, unknown>> = [];
  private countWaiters: Array<(value: Array<{ counted: number }>) => void> = [];

  select(_selection: unknown) {
    return {
      from: (table: unknown) => {
        if (table === claimDrafts) {
          return {
            where: () => ({
              limit: () => Promise.resolve([{ campaignVersionId: 'version-1' }]),
            }),
          };
        }
        if (table === campaignEvidenceRequirements) {
          return {
            where: () => ({
              limit: () =>
                Promise.resolve([
                  {
                    allowedMimeTypes: ['image/jpeg'],
                    maximumFileSizeBytes: 4096,
                    maximumFiles: 1,
                  },
                ]),
            }),
          };
        }
        if (table === documentUploads) {
          return {
            where: () =>
              new Promise<Array<{ counted: number }>>((resolve) => {
                this.countWaiters.push(resolve);
                if (this.countWaiters.length === 2) {
                  const waiters = this.countWaiters.splice(0);
                  for (const waiter of waiters) waiter([{ counted: this.documentRows.length }]);
                }
              }),
          };
        }
        throw new Error('Unexpected select table');
      },
    };
  }

  insert(table: unknown) {
    if (table !== documentUploads) throw new Error('Unexpected insert table');
    return {
      values: (values: Record<string, unknown>) => ({
        returning: () => {
          const slot = values.categorySlot;
          if (
            typeof slot === 'number' &&
            this.documentRows.some(
              (row) =>
                row.draftId === values.draftId &&
                row.category === values.category &&
                row.categorySlot === slot,
            )
          ) {
            return Promise.reject(
              Object.assign(new Error('duplicate category slot'), { code: '23505' }),
            );
          }
          this.documentRows.push(values);
          return Promise.resolve([values]);
        },
      }),
    };
  }
}

class FakeBlobAdapter implements PrivateBlobPort {
  authorizeClientUpload(request: UploadAuthorizationRequest) {
    return Promise.resolve({
      pathname: `drafts/${request.draftId}/${request.documentId}/${request.fileName}`,
      clientToken: 'client-token',
      expiresAt: '2026-08-06T12:00:00.000Z',
    });
  }

  handleUploadCallback() {
    return Promise.resolve(null);
  }

  delete() {
    return Promise.resolve();
  }
}

describe('DrizzleDocumentService upload quotas', () => {
  it('allows only one concurrent authorization when maximumFiles is one', async () => {
    const fake = new FakeUploadDatabase();
    const transaction: DatabaseHandle['transaction'] = (work) =>
      work(fake as unknown as DatabaseExecutor);
    const service = new DrizzleDocumentService(
      fake as unknown as Database,
      new FakeBlobAdapter(),
      transaction,
    );
    const input = {
      draftId: '21326c9a-5dc2-430f-98a6-546729a1065f',
      category: 'product_photo' as const,
      fileName: 'product.jpg',
      mimeType: 'image/jpeg',
      sizeBytes: 2048,
    };

    const results = await Promise.allSettled([
      service.authorizeUpload(input),
      service.authorizeUpload(input),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((result) => result.status === 'rejected');
    expect(rejected?.status).toBe('rejected');
    if (rejected?.status === 'rejected') {
      expect(rejected.reason).toBeInstanceOf(EvidenceRulesViolationError);
    }
    expect(fake.documentRows).toHaveLength(1);
  });
});
