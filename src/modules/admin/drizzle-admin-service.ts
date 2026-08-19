import { and, desc, eq, inArray } from 'drizzle-orm';

import { evaluate } from '../workflow/policy.js';

import type { DatabaseExecutor } from '../../db/client.js';
import {
  caseConsumers,
  caseEvents,
  caseResolutions,
  incidents,
  recallCases,
  reportabilityReviews,
} from '../../db/schema/index.js';
import type { SensitiveDataCryptoPort } from '../../platform/crypto/port.js';
import { piiTierFor } from '../staff/permissions.js';
import type { CaseResolution, ApproveResolutionInput, CompleteResolutionInput, CancelResolutionInput, CaseResolutionService } from '../resolutions/service.js';
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
    private readonly resolutions?: CaseResolutionService,
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

    return Promise.all(rows.map(async (row): Promise<AdminCaseSummary> => {
      const [caseRow] = await db.select({ id: recallCases.id, status: recallCases.status, subtype: recallCases.subtype, incidentFlag: recallCases.incidentFlag }).from(recallCases).where(eq(recallCases.publicReference, row.caseReference)).limit(1);
      const resolution = caseRow ? await db.select({ requestedType: caseResolutions.requestedType, approvedType: caseResolutions.approvedType, status: caseResolutions.status }).from(caseResolutions).where(eq(caseResolutions.caseId, caseRow.id)).limit(1) : [];
      const workflow = caseRow ? await this.workflowFor(caseRow) : undefined;
      return { caseReference: row.caseReference, status: row.status, subtype: row.subtype, incidentFlag: row.incidentFlag, submittedAt: row.submittedAt.toISOString(), ...(resolution[0] ? { resolution: resolution[0] } : { resolution: null }), ...(workflow ? { workflow } : {}) };
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
      resolution: this.resolutions ? await this.resolutions.getForCase(caseRow.id) : null,
      workflow: await this.workflowFor(caseRow),
      events: (await db.select().from(caseEvents).where(eq(caseEvents.caseId, caseRow.id)).orderBy(desc(caseEvents.occurredAt)).limit(100)).reverse().map((event) => ({ id: event.id, eventType: event.eventType, actorType: event.actorType, actorId: event.actorId, data: event.data, occurredAt: event.occurredAt.toISOString() })),
    };
  }

  private async workflowFor(caseRow: { id: string; status: CaseStatus; subtype: 'standard' | 'injury_hazard'; incidentFlag: boolean }) {
    const [incidentRow] = await this.db.select({ reportabilityStatus: reportabilityReviews.status }).from(incidents).leftJoin(reportabilityReviews, eq(reportabilityReviews.incidentId, incidents.id)).where(eq(incidents.caseId, caseRow.id)).limit(1);
    const [resolutionRow] = await this.db.select({ requestedType: caseResolutions.requestedType, approvedType: caseResolutions.approvedType, status: caseResolutions.status }).from(caseResolutions).where(eq(caseResolutions.caseId, caseRow.id)).limit(1);
    return evaluate({ caseStatus: caseRow.status, subtype: caseRow.subtype, incidentFlag: caseRow.incidentFlag, reportabilityStatus: incidentRow?.reportabilityStatus ?? null, resolution: resolutionRow ?? null });
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

  async approveResolution(caseReference: string, input: Omit<ApproveResolutionInput, 'caseId'>): Promise<CaseResolution> {
    if (!this.resolutions) throw new Error('Resolution service not configured.');
    return this.resolutions.approve({ ...input, caseId: await this.caseIdForReference(caseReference) });
  }

  async completeResolution(caseReference: string, input: Omit<CompleteResolutionInput, 'caseId'>): Promise<CaseResolution> {
    if (!this.resolutions) throw new Error('Resolution service not configured.');
    return this.resolutions.recordExternalCompletion({ ...input, caseId: await this.caseIdForReference(caseReference) });
  }

  async cancelResolution(caseReference: string, input: Omit<CancelResolutionInput, 'caseId'>): Promise<CaseResolution> {
    if (!this.resolutions) throw new Error('Resolution service not configured.');
    return this.resolutions.cancel({ ...input, caseId: await this.caseIdForReference(caseReference) });
  }

  private async caseIdForReference(caseReference: string): Promise<string> {
    const [row] = await this.db.select({ id: recallCases.id }).from(recallCases).where(eq(recallCases.publicReference, caseReference)).limit(1);
    if (!row) throw new ResourceNotFoundError('Case was not found.');
    return row.id;
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
      .select({
        id: recallCases.id,
        status: recallCases.status,
        subtype: recallCases.subtype,
        incidentFlag: recallCases.incidentFlag,
      })
      .from(recallCases)
      .where(eq(recallCases.publicReference, caseReference))
      .limit(1);
    if (!caseRow) throw new ResourceNotFoundError('Case was not found.');

    const [incident] = await db
      .select({ id: incidents.id })
      .from(incidents)
      .where(eq(incidents.caseId, caseRow.id))
      .limit(1);
    const [incidentReview] = incident
      ? await db
          .select({ reportabilityStatus: reportabilityReviews.status })
          .from(reportabilityReviews)
          .where(eq(reportabilityReviews.incidentId, incident.id))
          .limit(1)
      : [];

    const [resolutionRow] = await db
      .select({
        requestedType: caseResolutions.requestedType,
        approvedType: caseResolutions.approvedType,
        status: caseResolutions.status,
      })
      .from(caseResolutions)
      .where(eq(caseResolutions.caseId, caseRow.id))
      .limit(1);

    const workflow = evaluate({
      caseStatus: caseRow.status,
      subtype: caseRow.subtype,
      incidentFlag: caseRow.incidentFlag,
      reportabilityStatus: incidentReview?.reportabilityStatus ?? null,
      resolution: resolutionRow
        ? {
            requestedType: resolutionRow.requestedType,
            approvedType: resolutionRow.approvedType,
            status: resolutionRow.status,
          }
        : null,
    });
    if (!workflow.allowedActions.includes(`transition:${nextStatus}`)) {
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
