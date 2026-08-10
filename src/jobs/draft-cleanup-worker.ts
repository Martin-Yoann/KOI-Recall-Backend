import { and, eq, inArray, lte } from 'drizzle-orm';

import type { Database } from '../db/client.js';
import {
  documentUploads,
  type documentUploads as documentUploadsTable,
} from '../db/schema/index.js';
import type { PrivateBlobPort } from '../platform/blob/port.js';

const CLEANUP_BATCH = 100;

export interface DraftCleanupResult {
  deleted: number;
  pending: number;
}

type DocumentRow = typeof documentUploadsTable.$inferSelect;

/**
 * Reaps expired claim drafts and their Private Blob objects (T5.4/O5). Rows in
 * `deletion_pending` are retried; only rows whose blob object was actually
 * removed advance to `deleted`. A blob deletion failure keeps the row in
 * `deletion_pending` so a later run retries it.
 */
export class DrizzleDraftCleanupWorker {
  constructor(
    private readonly db: Database,
    private readonly blob: PrivateBlobPort,
  ) {}

  async runBatch(): Promise<DraftCleanupResult> {
    const db = this.db;

    // Documents eligible for physical deletion: soft-deleted (deletion_pending)
    // or owned by an expired draft. Claim-locked drafts stay untouched.
    const candidates = await db
      .select()
      .from(documentUploads)
      .where(
        and(
          lte(documentUploads.expiresAt, new Date()),
          inArray(documentUploads.uploadStatus, [
            'deletion_pending',
            'authorized',
            'uploaded',
            'verified',
          ]),
        ),
      )
      .limit(CLEANUP_BATCH);

    let deleted = 0;
    let pending = 0;
    for (const document of candidates) {
      const resolved = await this.deleteDocumentIfExpired(db, document);
      if (resolved) deleted += 1;
      else pending += 1;
    }
    return { deleted, pending };
  }

  private async deleteDocumentIfExpired(db: Database, document: DocumentRow): Promise<boolean> {
    // Blob deletion is the irreversible step — only then mark the row deleted.
    try {
      await this.blob.delete(document.storagePathname);
    } catch {
      // Keep deletion_pending so the next run retries the object removal.
      if (document.uploadStatus !== 'deletion_pending') {
        await db
          .update(documentUploads)
          .set({ uploadStatus: 'deletion_pending' })
          .where(eq(documentUploads.id, document.id));
      }
      return false;
    }

    await db
      .update(documentUploads)
      .set({ uploadStatus: 'deleted' })
      .where(eq(documentUploads.id, document.id));
    return true;
  }
}
