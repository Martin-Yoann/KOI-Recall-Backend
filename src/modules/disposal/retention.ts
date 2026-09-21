import { and, eq, gt, isNull, notExists, or } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';

import type { DatabaseExecutor } from '../../db/client.js';
import { disposalEvidenceBatches, disposalEvidenceBatchDocuments } from '../../db/schema/index.js';

/**
 * Evidence retention: a document referenced by any disposal evidence batch whose
 * retention window has not elapsed must not be reaped by the ordinary
 * temporary-upload expiry clock.
 *
 * A null `retentionUntil` means "no expiry configured", which is the
 * conservative default — an operator still has to look at those photos, so they
 * stay. When the business sets a retention period (an open question in the
 * rollout), it becomes a real deadline and the reaper resumes afterwards.
 *
 * Exported as a condition builder so the cleanup worker and the consumer
 * document-delete path share one rule instead of each spelling it out.
 */
export function notUnderEvidenceRetention(
  db: DatabaseExecutor,
  documentIdColumn: Parameters<typeof eq>[0],
): SQL {
  const liveRetention = db
    .select({ present: disposalEvidenceBatchDocuments.id })
    .from(disposalEvidenceBatchDocuments)
    .innerJoin(
      disposalEvidenceBatches,
      eq(disposalEvidenceBatches.id, disposalEvidenceBatchDocuments.batchId),
    )
    .where(
      and(
        eq(disposalEvidenceBatchDocuments.documentId, documentIdColumn),
        or(
          isNull(disposalEvidenceBatches.retentionUntil),
          gt(disposalEvidenceBatches.retentionUntil, new Date()),
        ),
      ),
    );

  return notExists(liveRetention);
}
