import { and, eq, inArray, lte } from 'drizzle-orm';

import type { Database } from '../db/client.js';
import {
  documentUploads,
  type documentUploads as documentUploadsTable,
} from '../db/schema/index.js';
import { notUnderEvidenceRetention } from '../modules/disposal/retention.js';
import type { PrivateBlobPort } from '../platform/blob/port.js';

const CLEANUP_BATCH = 100;

/** States a document may be physically deleted from. */
const DELETABLE_STATUSES = ['authorized', 'uploaded', 'verified'] as const;

export interface DraftCleanupResult {
  deleted: number;
  pending: number;
}

type DocumentRow = typeof documentUploadsTable.$inferSelect;

/**
 * Reaps expired claim drafts and their Private Blob objects (T5.4/O5).
 *
 * The blob deletion is irreversible, so a document is *claimed* before its bytes
 * are removed: an atomic guarded UPDATE moves it to `deletion_pending`, and only
 * the worker that won that UPDATE proceeds. Losing the claim means someone else
 * owns the row — or that it became evidence under retention between the scan and
 * the claim, which is exactly the race that used to make this unsafe.
 *
 * Two things are deliberately excluded from reaping:
 *   - documents in a submitted claim (`linked`), as before;
 *   - documents under disposal evidence retention, because an operator still has
 *     to review those photos and `expiresAt` is never extended for them.
 *
 * Rows in `deletion_pending` are retried; only a row whose blob was actually
 * removed advances to `deleted`. A blob failure leaves it `deletion_pending` so
 * a later run retries.
 */
export class DrizzleDraftCleanupWorker {
  constructor(
    private readonly db: Database,
    private readonly blob: PrivateBlobPort,
  ) {}

  async runBatch(): Promise<DraftCleanupResult> {
    const db = this.db;

    // Already claimed in an earlier run (or by the consumer's own delete), so
    // these are safe to retry: a `deletion_pending` row can no longer be added
    // to an evidence batch, which requires `verified`.
    const alreadyClaimed = await db
      .select()
      .from(documentUploads)
      .where(eq(documentUploads.uploadStatus, 'deletion_pending'))
      .limit(CLEANUP_BATCH);

    // Newly reapable: expired and still in a deletable state. Retention is
    // re-checked atomically at claim time below, so this filter is an
    // optimisation rather than the guarantee.
    const expired = await db
      .select()
      .from(documentUploads)
      .where(
        and(
          lte(documentUploads.expiresAt, new Date()),
          inArray(documentUploads.uploadStatus, [...DELETABLE_STATUSES]),
          notUnderEvidenceRetention(db, documentUploads.id),
        ),
      )
      .limit(CLEANUP_BATCH);

    let deleted = 0;
    let pending = 0;

    for (const document of alreadyClaimed) {
      if (await this.removeBlob(document)) deleted += 1;
      else pending += 1;
    }

    for (const document of expired) {
      if (!(await this.claim(document.id))) continue;
      if (await this.removeBlob({ ...document, uploadStatus: 'deletion_pending' })) deleted += 1;
      else pending += 1;
    }

    return { deleted, pending };
  }

  /**
   * Atomically takes ownership of a document for deletion.
   *
   * The retention predicate is part of the UPDATE, not only of the scan: a
   * batch submitted between the two would otherwise be left pointing at evidence
   * whose bytes are about to disappear. Returns false when the claim was lost.
   */
  private async claim(documentId: string): Promise<boolean> {
    const claimed = await this.db
      .update(documentUploads)
      .set({ uploadStatus: 'deletion_pending' })
      .where(
        and(
          eq(documentUploads.id, documentId),
          inArray(documentUploads.uploadStatus, [...DELETABLE_STATUSES]),
          notUnderEvidenceRetention(this.db, documentUploads.id),
        ),
      )
      .returning({ id: documentUploads.id });
    return claimed.length > 0;
  }

  /** The irreversible step. Only then does the row advance to `deleted`. */
  private async removeBlob(document: DocumentRow): Promise<boolean> {
    try {
      await this.blob.delete(document.storagePathname);
    } catch {
      // Keep deletion_pending so the next run retries the object removal.
      if (document.uploadStatus !== 'deletion_pending') {
        await this.db
          .update(documentUploads)
          .set({ uploadStatus: 'deletion_pending' })
          .where(
            and(
              eq(documentUploads.id, document.id),
              inArray(documentUploads.uploadStatus, [...DELETABLE_STATUSES]),
            ),
          );
      }
      return false;
    }

    await this.db
      .update(documentUploads)
      .set({ uploadStatus: 'deleted' })
      .where(eq(documentUploads.id, document.id));
    return true;
  }
}
