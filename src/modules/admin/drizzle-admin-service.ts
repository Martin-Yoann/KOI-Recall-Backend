import { and, desc, eq, inArray } from 'drizzle-orm';

import type { DatabaseExecutor } from '../../db/client.js';
import {
  caseConsumers,
  caseEvents,
  recallCases,
  reportabilityReviews,
} from '../../db/schema/index.js';
import type { SensitiveDataCryptoPort } from '../../platform/crypto/port.js';
import { piiTierFor } from '../staff/permissions.js';
import { ClaimValidationError, ResourceNotFoundError } from '../../shared/errors.js';
import { maskAddress, maskEmail, maskName, maskPhone } from './pii-masking.js';
import type {
  AdminCaseDetail,
  AdminCaseSummary,
  AdminQueue,
  AdminService,
  CaseDetailConsumer,
  CloseReportabilityReviewInput,
  GetCaseDetailInput,
  ListCasesFilter,
} from './service.js';

/**
 * Legal forward status transitions for a recall case (ADR-0004 B8). Closed is
 * terminal; duplicate/withdrawn are also terminal. This prevents invalid jumps
 * like closed → submitted.
 */
const LEGAL_TRANSITIONS: Readonly<Record<string, readonly string[]>> = {
  submitted: ['triage', 'under_review', 'rejected', 'duplicate', 'withdrawn'],
  triage: ['under_review', 'need_info', 'approved', 'rejected', 'duplicate', 'withdrawn'],
  under_review: ['need_info', 'approved', 'rejected', 'closure_review', 'withdrawn'],
  need_info: ['under_review', 'approved', 'rejected', 'withdrawn'],
  approved: ['closure_review', 'closed'],
  closure_review: ['closed', 'under_review'],
};

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
    private readonly db: DatabaseExecutor,
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

  async getCaseDetail(input: GetCaseDetailInput): Promise<AdminCaseDetail | null> {
    const db = this.db;
    const [caseRow] = await db
      .select()
      .from(recallCases)
      .where(eq(recallCases.publicReference, input.caseReference))
      .limit(1);
    if (!caseRow) return null;

    const [consumerRow] = await db
      .select()
      .from(caseConsumers)
      .where(eq(caseConsumers.caseId, caseRow.id))
      .limit(1);

    const tier = piiTierFor(input.viewerRole);
    const consumer = consumerRow
      ? await this.renderConsumer(consumerRow, tier)
      : ({ piiTier: tier } as CaseDetailConsumer);

    return {
      caseReference: caseRow.publicReference,
      status: caseRow.status,
      subtype: caseRow.subtype,
      incidentFlag: caseRow.incidentFlag,
      submittedAt: caseRow.submittedAt.toISOString(),
      assignedToStaffUserId: caseRow.assignedToStaffUserId,
      assignedAt: caseRow.assignedAt ? caseRow.assignedAt.toISOString() : null,
      consumer,
    };
  }

  private async renderConsumer(
    row: typeof caseConsumers.$inferSelect,
    tier: 'masked' | 'raw',
  ): Promise<CaseDetailConsumer> {
    const firstName = await this.crypto.decrypt({
      value: row.firstNameEncrypted,
      keyVersion: row.keyVersion,
    });
    const lastName = await this.crypto.decrypt({
      value: row.lastNameEncrypted,
      keyVersion: row.keyVersion,
    });
    const email = await this.crypto.decrypt({
      value: row.emailEncrypted,
      keyVersion: row.keyVersion,
    });
    const phone = row.phoneEncrypted
      ? await this.crypto.decrypt({ value: row.phoneEncrypted, keyVersion: row.keyVersion })
      : undefined;
    const address = row.addressEncrypted
      ? await this.crypto.decrypt({ value: row.addressEncrypted, keyVersion: row.keyVersion })
      : undefined;
    let parsedAddress: Record<string, unknown> | undefined;
    if (address) {
      try {
        parsedAddress = JSON.parse(address) as Record<string, unknown>;
      } catch {
        parsedAddress = { raw: address };
      }
    }

    if (tier === 'raw') {
      return {
        piiTier: 'raw',
        firstName,
        lastName,
        email,
        phone,
        countryCode: row.countryCode,
        address: parsedAddress,
      };
    }
    return {
      piiTier: 'masked',
      firstName: maskName(firstName),
      lastName: maskName(lastName),
      email: maskEmail(email),
      phone: phone ? maskPhone(phone) : undefined,
      countryCode: row.countryCode,
      address: maskAddress(parsedAddress) as unknown as Record<string, unknown>,
    };
  }

  async assignCase(caseReference: string, staffUserId: string | null): Promise<void> {
    const db = this.db;
    const result = await db
      .update(recallCases)
      .set({ assignedToStaffUserId: staffUserId, assignedAt: staffUserId ? new Date() : null })
      .where(eq(recallCases.publicReference, caseReference))
      .returning({ id: recallCases.id });
    if (result.length === 0) throw new ResourceNotFoundError('Case was not found.');
  }

  async transitionCaseStatus(
    caseReference: string,
    nextStatus: string,
    actorUserId: string,
  ): Promise<void> {
    const db = this.db;
    const [caseRow] = await db
      .select({ id: recallCases.id, status: recallCases.status })
      .from(recallCases)
      .where(eq(recallCases.publicReference, caseReference))
      .limit(1);
    if (!caseRow) throw new ResourceNotFoundError('Case was not found.');

    const allowed = LEGAL_TRANSITIONS[caseRow.status] ?? [];
    if (!allowed.includes(nextStatus)) {
      throw new ClaimValidationError(
        `Status transition from '${caseRow.status}' to '${nextStatus}' is not allowed.`,
      );
    }
    await db
      .update(recallCases)
      .set({ status: nextStatus as never })
      .where(eq(recallCases.id, caseRow.id));
    await db.insert(caseEvents).values({
      caseId: caseRow.id,
      eventType: 'case.status.transitioned',
      actorType: 'staff',
      actorId: actorUserId,
      data: { previousStatus: caseRow.status, nextStatus },
    });
  }
}
