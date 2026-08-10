import { and, desc, eq, inArray } from 'drizzle-orm';

import type { Database } from '../../db/client.js';
import { recallCases, reportabilityReviews } from '../../db/schema/index.js';
import type { SensitiveDataCryptoPort } from '../../platform/crypto/port.js';
import { ClaimValidationError, ResourceNotFoundError } from '../../shared/errors.js';
import type {
  AdminCaseSummary,
  AdminQueue,
  AdminService,
  CloseReportabilityReviewInput,
  ListCasesFilter,
} from './service.js';

/** Statuses that put a case in each operational queue (T8/O10). */
type CaseStatus = (typeof recallCases.$inferSelect)['status'];
const QUEUE_STATUS: Record<AdminQueue, readonly CaseStatus[]> = {
  standard: ['submitted'],
  manual_review: ['triage', 'need_info'],
  incident: ['submitted', 'triage', 'under_review'],
};

/**
 * Single-role admin service (T8/O10): queues, export, and the
 * reportability-close gate. Read paths expose only non-PII summaries; the
 * export is the full archive for reporting obligations.
 */
export class DrizzleAdminService implements AdminService {
  constructor(
    private readonly db: Database,
    private readonly crypto: SensitiveDataCryptoPort,
  ) {}

  async listCases(filter: ListCasesFilter): Promise<AdminCaseSummary[]> {
    const db = this.db;

    const conditions = [];
    if (filter.status) {
      conditions.push(eq(recallCases.status, filter.status as never));
    } else if (filter.queue) {
      const statuses = QUEUE_STATUS[filter.queue];
      conditions.push(inArray(recallCases.status, statuses));
      if (filter.queue === 'incident') {
        conditions.push(eq(recallCases.incidentFlag, true));
      }
    }

    const rows = await db
      .select({
        caseReference: recallCases.publicReference,
        status: recallCases.status,
        subtype: recallCases.subtype,
        incidentFlag: recallCases.incidentFlag,
        submittedAt: recallCases.submittedAt,
      })
      .from(recallCases)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(desc(recallCases.submittedAt))
      .limit(filter.limit);

    return rows.map((row) => ({
      caseReference: row.caseReference,
      status: row.status,
      subtype: row.subtype,
      incidentFlag: row.incidentFlag,
      submittedAt: row.submittedAt.toISOString(),
    }));
  }

  async exportCases(): Promise<AdminCaseSummary[]> {
    return this.listCases({ limit: 10_000 });
  }

  async closeReportabilityReview(
    reviewId: string,
    input: CloseReportabilityReviewInput,
  ): Promise<void> {
    const db = this.db;

    const [review] = await db
      .select()
      .from(reportabilityReviews)
      .where(eq(reportabilityReviews.id, reviewId))
      .limit(1);
    if (!review) throw new ResourceNotFoundError('Reportability Review was not found.');
    if (review.status !== 'pending') {
      throw new ClaimValidationError('Only a pending Reportability Review can be closed.');
    }

    if (input.outcome === 'filed' && !input.cpscReference) {
      throw new ClaimValidationError('cpscReference is required when closing as filed.');
    }
    if (input.rationale.trim().length < 10) {
      throw new ClaimValidationError('A rationale of at least 10 characters is required.');
    }

    const rationale = await this.crypto.encrypt(input.rationale);
    await db
      .update(reportabilityReviews)
      .set({
        status: input.outcome,
        reviewerId: input.reviewerId,
        rationaleEncrypted: rationale.value,
        decisionAt: new Date(),
        ...(input.outcome === 'filed'
          ? { cpscReference: input.cpscReference, filedAt: new Date() }
          : {}),
      })
      .where(eq(reportabilityReviews.id, reviewId));
  }
}
