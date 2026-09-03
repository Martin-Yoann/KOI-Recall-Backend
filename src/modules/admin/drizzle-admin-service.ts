import { and, asc, desc, eq, inArray, lt, notInArray, or, sql, count } from 'drizzle-orm';

import { evaluate } from '../workflow/policy.js';

import type { DatabaseExecutor } from '../../db/client.js';
import {
  adminAuditEvents,
  campaignLocalizations,
  campaignVersions,
  caseConsumers,
  caseEvents,
  caseResolutions,
  documentUploads,
  incidents,
  claimedProducts,
  recallCampaigns,
  recallCases,
  reportabilityReviews,
} from '../../db/schema/index.js';
import type { PrivateBlobPort } from '../../platform/blob/port.js';
import type { SensitiveDataCryptoPort } from '../../platform/crypto/port.js';
import { piiTierFor } from '../staff/permissions.js';
import type { CaseResolution, ApproveResolutionInput, CompleteResolutionInput, CancelResolutionInput, CaseResolutionService } from '../resolutions/service.js';
import { ClaimValidationError, ResourceNotFoundError } from '../../shared/errors.js';
import { maskAddress, maskEmail, maskName, maskOrderNumber, maskPhone } from './pii-masking.js';
import type {
  AdminCaseDetail,
  AdminCaseProduct,
  AdminCaseSummary,
  AdminCampaignSummary,
  AdminDocumentAccess,
  AdminIncidentSummary,
  AdminQueue,
  AdminService,
  CaseDetailConsumer,
  CaseListPage,
  CloseReportabilityReviewInput,
  GetCaseDetailInput,
  IncidentDetailView,
  IncidentListPage,
  ListCasesFilter,
  ListIncidentsFilter,
} from './service.js';
import {
  buildCaseListCursor,
  buildIncidentCursor,
  parseCaseListCursor,
  parseIncidentCursor,
} from './service.js';

/**
 * Statuses that put a case in each operational queue. `incident` is special:
 * it matches ANY non-terminal incident-flagged case (see listCases below).
 * Single source of truth — the front-end must not re-derive these.
 */
type CaseStatus = (typeof recallCases.$inferSelect)['status'];
const QUEUE_STATUS: Record<AdminQueue, readonly CaseStatus[]> = {
  standard: ['submitted'],
  manual_review: ['triage', 'under_review'],
  need_info: ['need_info'],
  decision: ['under_review', 'approved'],
  closure: ['closure_review'],
  incident: [],
};

/** Terminal statuses never belong to an operational queue. */
const TERMINAL_STATUSES: readonly CaseStatus[] = ['closed', 'rejected', 'duplicate', 'withdrawn'];

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
    private readonly blob?: PrivateBlobPort,
  ) {}

  async listCases(filter: ListCasesFilter): Promise<CaseListPage> {
    const db = this.db;

    const filterConditions = [];
    if (filter.status) {
      filterConditions.push(eq(recallCases.status, filter.status as never));
    } else if (filter.queue) {
      if (filter.queue === 'incident') {
        // Any non-terminal case flagged as an injury/safety incident.
        filterConditions.push(eq(recallCases.incidentFlag, true));
        filterConditions.push(notInArray(recallCases.status, [...TERMINAL_STATUSES]));
      } else {
        const statuses = QUEUE_STATUS[filter.queue];
        filterConditions.push(inArray(recallCases.status, statuses));
      }
    }
    if (filter.search?.trim()) {
      const term = `%${filter.search.trim().toLowerCase()}%`;
      filterConditions.push(
        or(
          sql`lower(${recallCases.publicReference}) like ${term}`,
          sql`lower(${recallCases.subtype}) like ${term}`,
        ),
      );
    }
    const filterWhere = filterConditions.length > 0 ? and(...filterConditions) : undefined;

    // Forward-only cursor over (submittedAt desc, id desc). The id acts as a
    // unique tie-breaker so equal timestamps never skip or repeat rows.
    const cursor = filter.cursor ? parseCaseListCursor(filter.cursor) : null;
    let cursorCondition = null;
    if (filter.cursor && !cursor) {
      // Malformed cursor: return an empty page instead of erroring so a stale
      // client bookmark degrades gracefully.
      cursorCondition = sql`false`;
    } else if (cursor) {
      cursorCondition = or(
        lt(recallCases.submittedAt, cursor.submittedAt),
        and(
          eq(recallCases.submittedAt, cursor.submittedAt),
          lt(recallCases.id, cursor.id),
        ),
      );
    }

    const pageWhere = cursorCondition
      ? (filterWhere ? and(filterWhere, cursorCondition) : cursorCondition)
      : filterWhere;

    const rows = await db
      .select({
        id: recallCases.id,
        caseReference: recallCases.publicReference,
        status: recallCases.status,
        subtype: recallCases.subtype,
        incidentFlag: recallCases.incidentFlag,
        submittedAt: recallCases.submittedAt,
      })
      .from(recallCases)
      .where(pageWhere)
      .orderBy(desc(recallCases.submittedAt), desc(recallCases.id))
      .limit(filter.limit);

    // Total matching rows for the *filter* (cursor excluded) so the UI can
    // render "page x of total" without a second request.
    const [totalRow] = await db
      .select({ value: count() })
      .from(recallCases)
      .where(filterWhere);
    const total = Number(totalRow?.value ?? 0);

    const cases = await Promise.all(rows.map(async (row): Promise<AdminCaseSummary> => {
      const resolution = await db.select({ requestedType: caseResolutions.requestedType, approvedType: caseResolutions.approvedType, status: caseResolutions.status }).from(caseResolutions).where(eq(caseResolutions.caseId, row.id)).limit(1);
      const workflow = await this.workflowFor(row);
      return { caseReference: row.caseReference, status: row.status, subtype: row.subtype, incidentFlag: row.incidentFlag, submittedAt: row.submittedAt.toISOString(), ...(resolution[0] ? { resolution: resolution[0] } : { resolution: null }), ...(workflow ? { workflow } : {}) };
    }));

    // When a page fills the limit, look ahead by one row to know whether
    // another page exists (avoids a dangling "next" on the last page).
    let nextCursor: string | null = null;
    if (rows.length === filter.limit && rows.length > 0) {
      const last = rows[rows.length - 1]!;
      const [lookahead] = await db
        .select({ id: recallCases.id })
        .from(recallCases)
        .where(and(
          pageWhere,
          or(
            lt(recallCases.submittedAt, last.submittedAt),
              and(
                eq(recallCases.submittedAt, last.submittedAt),
                lt(recallCases.id, last.id),
              ),
            ),

        ))
        .limit(1);
      if (lookahead) {
        nextCursor = buildCaseListCursor(last.submittedAt, last.id);
      }
    }

    return { cases, total, nextCursor };
  }

  async exportCases(): Promise<AdminCaseSummary[]> {
    // The full-archive export intentionally ignores pagination: walk pages
    // until the cursor is exhausted.
    const all: AdminCaseSummary[] = [];
    const pageSize = 1000;
    let cursor: string | null = null;
    for (;;) {
      const page = await this.listCases({
        limit: pageSize,
        ...(cursor ? { cursor } : {}),
      });
      all.push(...page.cases);
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }
    return all;
  }

  async listIncidents(filter?: ListIncidentsFilter): Promise<IncidentListPage> {
    const db = this.db;
    const filters = filter ?? { limit: 100 };

    const filterConditions = [];
    if (filters.search?.trim()) {
      const term = `%${filters.search.trim().toLowerCase()}%`;
      filterConditions.push(sql`lower(${recallCases.publicReference}) like ${term}`);
    }
    if (filters.severity) {
      filterConditions.push(eq(incidents.injurySeverity, filters.severity as never));
    }
    if (filters.reportabilityStatus) {
      filterConditions.push(eq(reportabilityReviews.status, filters.reportabilityStatus as never));
    }
    const filterWhere = filterConditions.length > 0 ? and(...filterConditions) : undefined;

    const cursor = filters.cursor ? parseIncidentCursor(filters.cursor) : null;
    let cursorCondition = null;
    if (filters.cursor && !cursor) {
      cursorCondition = sql`false`;
    } else if (cursor) {
      cursorCondition = or(
        lt(incidents.createdAt, cursor.createdAt),
        and(
          eq(incidents.createdAt, cursor.createdAt),
          lt(incidents.id, cursor.id),
        ),
      );
    }
    const pageWhere = cursorCondition
      ? (filterWhere ? and(filterWhere, cursorCondition) : cursorCondition)
      : filterWhere;

    const rows = await db
      .select({
        id: incidents.id,
        caseReference: recallCases.publicReference,
        caseStatus: recallCases.status,
        answer: incidents.answer,
        eventTypes: incidents.eventTypes,
        injurySeverity: incidents.injurySeverity,
        medicalTreatment: incidents.medicalTreatment,
        occurredAt: incidents.occurredAt,
        createdAt: incidents.createdAt,
        reviewId: reportabilityReviews.id,
        reviewStatus: reportabilityReviews.status,
        cpscReference: reportabilityReviews.cpscReference,
        filedAt: reportabilityReviews.filedAt,
        decisionAt: reportabilityReviews.decisionAt,
      })
      .from(incidents)
      .innerJoin(recallCases, eq(recallCases.id, incidents.caseId))
      .leftJoin(reportabilityReviews, eq(reportabilityReviews.incidentId, incidents.id))
      .where(pageWhere)
      .orderBy(desc(incidents.createdAt), desc(incidents.id))
      .limit(filters.limit);

    const [totalRow] = await db
      .select({ value: count() })
      .from(incidents)
      .innerJoin(recallCases, eq(recallCases.id, incidents.caseId))
      .leftJoin(reportabilityReviews, eq(reportabilityReviews.incidentId, incidents.id))
      .where(filterWhere);
    const total = Number(totalRow?.value ?? 0);

    let nextCursor: string | null = null;
    if (rows.length === filters.limit && rows.length > 0) {
      const last = rows[rows.length - 1]!;
      const [lookahead] = await db
        .select({ id: incidents.id })
        .from(incidents)
        .where(and(
          pageWhere,
          or(
            lt(incidents.createdAt, last.createdAt),
            and(eq(incidents.createdAt, last.createdAt), lt(incidents.id, last.id)),
          ),
        ))
        .limit(1);
      if (lookahead) nextCursor = buildIncidentCursor(last.createdAt, last.id);
    }

    return {
      incidents: rows.map((row) => ({
        id: row.id,
        caseReference: row.caseReference,
        caseStatus: row.caseStatus,
        answer: row.answer,
        eventTypes: row.eventTypes,
        injurySeverity: row.injurySeverity ?? null,
        medicalTreatment: row.medicalTreatment ?? null,
        occurredAt: row.occurredAt ? row.occurredAt.toISOString() : null,
        createdAt: row.createdAt.toISOString(),
        reportability: row.reviewId
          ? {
              id: row.reviewId,
              status: row.reviewStatus ?? 'pending',
              cpscReference: row.cpscReference ?? null,
              filedAt: row.filedAt ? row.filedAt.toISOString() : null,
              decisionAt: row.decisionAt ? row.decisionAt.toISOString() : null,
            }
          : null,
      })),
      total,
      nextCursor,
    };
  }

  async getIncidentDetail(id: string): Promise<IncidentDetailView | null> {
    const db = this.db;
    const rows = await db
      .select({
        id: incidents.id,
        caseReference: recallCases.publicReference,
        caseStatus: recallCases.status,
        answer: incidents.answer,
        eventTypes: incidents.eventTypes,
        injurySeverity: incidents.injurySeverity,
        medicalTreatment: incidents.medicalTreatment,
        occurredAt: incidents.occurredAt,
        createdAt: incidents.createdAt,
        reviewId: reportabilityReviews.id,
        reviewStatus: reportabilityReviews.status,
        cpscReference: reportabilityReviews.cpscReference,
        filedAt: reportabilityReviews.filedAt,
        decisionAt: reportabilityReviews.decisionAt,
      })
      .from(incidents)
      .innerJoin(recallCases, eq(recallCases.id, incidents.caseId))
      .leftJoin(reportabilityReviews, eq(reportabilityReviews.incidentId, incidents.id))
      .where(eq(incidents.id, id))
      .limit(1);
    const row = rows[0];
    if (!row) return null;

    const incident: AdminIncidentSummary = {
      id: row.id,
      caseReference: row.caseReference,
      caseStatus: row.caseStatus,
      answer: row.answer,
      eventTypes: row.eventTypes,
      injurySeverity: row.injurySeverity ?? null,
      medicalTreatment: row.medicalTreatment ?? null,
      occurredAt: row.occurredAt ? row.occurredAt.toISOString() : null,
      createdAt: row.createdAt.toISOString(),
      reportability: row.reviewId
        ? {
            id: row.reviewId,
            status: row.reviewStatus ?? 'pending',
            cpscReference: row.cpscReference ?? null,
            filedAt: row.filedAt ? row.filedAt.toISOString() : null,
            decisionAt: row.decisionAt ? row.decisionAt.toISOString() : null,
          }
        : null,
    };

    // Review history: reportability/incident-scoped audit events (best-effort;
    // only fields already returned by the audit service are used).
    const reviewEvents = await this.db
      .select({
        id: adminAuditEvents.id,
        action: adminAuditEvents.action,
        actorRole: adminAuditEvents.actorRole,
        outcome: adminAuditEvents.outcome,
        reasonCode: adminAuditEvents.reasonCode,
        occurredAt: adminAuditEvents.occurredAt,
      })
      .from(adminAuditEvents)
      .where(
        or(
          and(
            eq(adminAuditEvents.resourceType, 'reportability'),
            eq(adminAuditEvents.resourceId, id),
          ),
          and(
            eq(adminAuditEvents.resourceType, 'incident'),
            eq(adminAuditEvents.resourceId, row.caseReference),
          ),
        ),
      )
      .orderBy(desc(adminAuditEvents.occurredAt))
      .limit(50)
      .catch(() => []);

    return {
      incident,
      caseReference: row.caseReference,
      caseStatus: row.caseStatus,
      reviewEvents: reviewEvents.map((event) => ({
        id: event.id,
        action: event.action,
        actorRole: event.actorRole,
        outcome: event.outcome,
        reasonCode: event.reasonCode ?? null,
        occurredAt: event.occurredAt.toISOString(),
      })),
    };
  }

  async listCampaigns(): Promise<AdminCampaignSummary[]> {
    const db = this.db;
    const rows = await db
      .select({
        id: recallCampaigns.id,
        slug: recallCampaigns.slug,
        code: recallCampaigns.code,
        status: recallCampaigns.status,
        launchAt: recallCampaigns.launchAt,
        closeAt: recallCampaigns.closeAt,
        title: campaignLocalizations.title,
      })
      .from(recallCampaigns)
      .leftJoin(campaignVersions, eq(campaignVersions.id, recallCampaigns.publishedVersionId))
      .leftJoin(
        campaignLocalizations,
        and(
          eq(campaignLocalizations.campaignVersionId, campaignVersions.id),
          eq(campaignLocalizations.locale, recallCampaigns.defaultLocale),
        ),
      )
      .orderBy(desc(recallCampaigns.updatedAt))
      .limit(200);

    const counts = await db
      .select({ campaignId: recallCases.campaignId, caseCount: sql<number>`count(*)::int` })
      .from(recallCases)
      .groupBy(recallCases.campaignId);
    const countByCampaign = new Map(counts.map((row) => [row.campaignId, row.caseCount]));

    return rows.map((row) => ({
      id: row.id,
      slug: row.slug,
      code: row.code,
      status: row.status,
      launchAt: row.launchAt ? row.launchAt.toISOString() : null,
      closeAt: row.closeAt ? row.closeAt.toISOString() : null,
      ...(row.title ? { title: row.title } : {}),
      caseCount: countByCampaign.get(row.id) ?? 0,
    }));
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

    const incident = await this.incidentFor(caseRow.id, tier);
    const campaign = await this.campaignFor(caseRow.campaignVersionId, caseRow.locale);
    return {
      caseReference: caseRow.publicReference,
      status: caseRow.status,
      subtype: caseRow.subtype,
      incidentFlag: caseRow.incidentFlag,
      submittedAt: caseRow.submittedAt.toISOString(),
      assignedToStaffUserId: caseRow.assignedToStaffUserId,
      assignedAt: caseRow.assignedAt ? caseRow.assignedAt.toISOString() : null,
      ...(campaign ? { campaign } : {}),
      products: await this.productsFor(caseRow.id, tier),
      documents: await this.documentsFor(caseRow.id),
      incident,
      consumer,
      resolution: this.resolutions ? await this.resolutions.getForCase(caseRow.id) : null,
      workflow: await this.workflowFor(caseRow, incident?.reportability?.status ?? null),
      events: (await db.select().from(caseEvents).where(eq(caseEvents.caseId, caseRow.id)).orderBy(desc(caseEvents.occurredAt)).limit(100)).reverse().map((event) => ({ id: event.id, eventType: event.eventType, actorType: event.actorType, actorId: event.actorId, data: event.data, occurredAt: event.occurredAt.toISOString() })),
    };
  }

  /** The campaign context a case was submitted against (title via case locale). */
  private async campaignFor(campaignVersionId: string, locale: string) {
    const [row] = await this.db
      .select({
        slug: recallCampaigns.slug,
        code: recallCampaigns.code,
        title: campaignLocalizations.title,
      })
      .from(campaignVersions)
      .innerJoin(recallCampaigns, eq(recallCampaigns.id, campaignVersions.campaignId))
      .leftJoin(
        campaignLocalizations,
        and(
          eq(campaignLocalizations.campaignVersionId, campaignVersions.id),
          eq(campaignLocalizations.locale, locale),
        ),
      )
      .where(eq(campaignVersions.id, campaignVersionId))
      .limit(1);
    if (!row) return undefined;
    return { slug: row.slug, code: row.code, ...(row.title ? { title: row.title } : {}) };
  }

  private async productsFor(caseId: string, tier: 'masked' | 'raw'): Promise<AdminCaseProduct[]> {
    const rows = await this.db
      .select({
        id: claimedProducts.id,
        quantity: claimedProducts.quantity,
        shape: claimedProducts.shape,
        flavor: claimedProducts.flavor,
        lotCode: claimedProducts.lotCode,
        dateCode: claimedProducts.dateCode,
        purchaseChannel: claimedProducts.purchaseChannel,
        purchaseDate: claimedProducts.purchaseDate,
        orderNumberEncrypted: claimedProducts.orderNumberEncrypted,
        checkResult: claimedProducts.checkResult,
        identificationMode: claimedProducts.identificationMode,
        reasonCodes: claimedProducts.reasonCodes,
        purchaseCorroboration: claimedProducts.purchaseCorroboration,
        riskFlags: claimedProducts.riskFlags,
      })
      .from(claimedProducts)
      .where(eq(claimedProducts.caseId, caseId))
      .orderBy(asc(claimedProducts.createdAt));
    return await Promise.all(
      rows.map(async (row) => {
        // The order-number column stores only the ciphertext (no key_version
        // column); the envelope embeds `v1`, so decrypt with the fixed version
        // and degrade gracefully if the value is malformed/legacy.
        let orderNumber: string | null | undefined;
        if (row.orderNumberEncrypted) {
          try {
            const plaintext = await this.crypto.decrypt({
              value: row.orderNumberEncrypted,
              keyVersion: 'v1',
            });
            orderNumber = tier === 'raw' ? plaintext : maskOrderNumber(plaintext);
          } catch {
            orderNumber = null;
          }
        }
        return {
          id: row.id,
          quantity: row.quantity,
          shape: row.shape,
          flavor: row.flavor,
          lotCode: row.lotCode,
          dateCode: row.dateCode,
          purchaseChannel: row.purchaseChannel,
          purchaseDate: row.purchaseDate ?? null,
          ...(orderNumber !== undefined ? { orderNumber } : {}),
          checkResult: row.checkResult,
          identificationMode: row.identificationMode ?? null,
          reasonCodes: row.reasonCodes ?? null,
          purchaseCorroboration: row.purchaseCorroboration ?? null,
          riskFlags: row.riskFlags ?? null,
        };
      }),
    );
  }

  /** Evidence metadata for the case — never storage pathnames, never blobs. */
  private async documentsFor(caseId: string) {
    const rows = await this.db
      .select({
        id: documentUploads.id,
        category: documentUploads.category,
        categorySlot: documentUploads.categorySlot,
        originalFileName: documentUploads.originalFileName,
        declaredMimeType: documentUploads.declaredMimeType,
        sizeBytes: documentUploads.sizeBytes,
        uploadStatus: documentUploads.uploadStatus,
        scanStatus: documentUploads.scanStatus,
        uploadedAt: documentUploads.uploadedAt,
      })
      .from(documentUploads)
      .where(eq(documentUploads.caseId, caseId))
      .orderBy(asc(documentUploads.createdAt));
    return rows.map((row) => ({
      ...row,
      categorySlot: row.categorySlot ?? null,
      uploadedAt: row.uploadedAt ? row.uploadedAt.toISOString() : null,
    }));
  }

  /**
   * The incident joined to its reportability gate. The narrative is decrypted
   * only for the raw PII tier — masked viewers never receive it, and the raw
   * read is audited by the route as a `pii.view_raw` event.
   */
  private async incidentFor(caseId: string, tier: 'masked' | 'raw') {
    const [row] = await this.db
      .select({
        id: incidents.id,
        answer: incidents.answer,
        eventTypes: incidents.eventTypes,
        narrativeKeyVersion: incidents.narrativeKeyVersion,
        narrativeEncrypted: incidents.narrativeEncrypted,
        injurySeverity: incidents.injurySeverity,
        medicalTreatment: incidents.medicalTreatment,
        usedAsIntended: incidents.usedAsIntended,
        occurredAt: incidents.occurredAt,
        occurredDateUnknown: incidents.occurredDateUnknown,
        companyObtainedAt: incidents.companyObtainedAt,
        reviewId: reportabilityReviews.id,
        reviewStatus: reportabilityReviews.status,
        cpscReference: reportabilityReviews.cpscReference,
        filedAt: reportabilityReviews.filedAt,
      })
      .from(incidents)
      .leftJoin(reportabilityReviews, eq(reportabilityReviews.incidentId, incidents.id))
      .where(eq(incidents.caseId, caseId))
      .limit(1);
    if (!row) return null;

    const narrative =
      tier === 'raw'
        ? await this.crypto.decrypt({
            value: row.narrativeEncrypted,
            keyVersion: row.narrativeKeyVersion,
          })
        : undefined;

    return {
      id: row.id,
      answer: row.answer,
      eventTypes: row.eventTypes,
      injurySeverity: row.injurySeverity ?? null,
      medicalTreatment: row.medicalTreatment ?? null,
      usedAsIntended: row.usedAsIntended ?? null,
      occurredAt: row.occurredAt ? row.occurredAt.toISOString() : null,
      occurredDateUnknown: row.occurredDateUnknown,
      companyObtainedAt: row.companyObtainedAt.toISOString(),
      reportability: row.reviewId
        ? {
            id: row.reviewId,
            status: row.reviewStatus ?? 'pending',
            cpscReference: row.cpscReference ?? null,
            filedAt: row.filedAt ? row.filedAt.toISOString() : null,
          }
        : null,
      ...(narrative !== undefined ? { narrative } : {}),
    };
  }

  /**
   * `reportabilityStatus` may be passed in by callers that already loaded the
   * incident (getCaseDetail); when omitted it is queried (listCases path).
   */
  private async workflowFor(
    caseRow: { id: string; status: CaseStatus; subtype: 'standard' | 'injury_hazard'; incidentFlag: boolean },
    reportabilityStatus?: string | null,
  ) {
    let reviewStatus = reportabilityStatus;
    if (reviewStatus === undefined) {
      const [incidentRow] = await this.db.select({ reportabilityStatus: reportabilityReviews.status }).from(incidents).leftJoin(reportabilityReviews, eq(reportabilityReviews.incidentId, incidents.id)).where(eq(incidents.caseId, caseRow.id)).limit(1);
      reviewStatus = incidentRow?.reportabilityStatus ?? null;
    }
    const [resolutionRow] = await this.db.select({ requestedType: caseResolutions.requestedType, approvedType: caseResolutions.approvedType, status: caseResolutions.status }).from(caseResolutions).where(eq(caseResolutions.caseId, caseRow.id)).limit(1);
    return evaluate({
      caseStatus: caseRow.status,
      subtype: caseRow.subtype,
      incidentFlag: caseRow.incidentFlag,
      reportabilityStatus: (reviewStatus as 'pending' | 'filed' | 'documented_non_reportable' | null) ?? null,
      resolution: resolutionRow ?? null,
    });
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

  async getDocumentAccess(
    caseReference: string,
    documentId: string,
  ): Promise<AdminDocumentAccess | null> {
    if (!this.blob) throw new Error('Blob service is not configured.');
    const db = this.db;
    const [caseRow] = await db
      .select({ id: recallCases.id })
      .from(recallCases)
      .where(eq(recallCases.publicReference, caseReference))
      .limit(1);
    if (!caseRow) return null;

    const [doc] = await db
      .select({
        id: documentUploads.id,
        caseId: documentUploads.caseId,
        storagePathname: documentUploads.storagePathname,
        originalFileName: documentUploads.originalFileName,
      })
      .from(documentUploads)
      .where(eq(documentUploads.id, documentId))
      .limit(1);
    // The document must exist AND belong to this case — never hand out access
    // to a file the viewer cannot already see in the case detail.
    if (!doc || doc.caseId !== caseRow.id) return null;

    const access = await this.blob.createAccessUrl(doc.storagePathname);
    return {
      documentId: doc.id,
      fileName: doc.originalFileName,
      contentType: access.contentType,
      url: access.url,
      downloadUrl: access.downloadUrl,
    };
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
    note?: string,
    bypassWorkflow = false,
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

    // The consumer must be told what to provide: a need_info transition
    // without a note would strand them in "action required" with no guidance.
    const trimmedNote = note?.trim();
    if (!bypassWorkflow && nextStatus === 'need_info' && (!trimmedNote || trimmedNote.length < 10)) {
      throw new ClaimValidationError(
        'A note of at least 10 characters is required when requesting additional information.',
      );
    }
    if (trimmedNote && trimmedNote.length > 2000) {
      throw new ClaimValidationError('The transition note must be at most 2000 characters.');
    }

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

    if (bypassWorkflow) {
      await db
        .update(recallCases)
        .set({ status: nextStatus as never })
        .where(eq(recallCases.id, caseRow.id));
      await db.insert(caseEvents).values({
        caseId: caseRow.id,
        eventType: 'case.status.transitioned',
        actorType: 'staff',
        actorId: actorUserId,
        data: {
          previousStatus: caseRow.status,
          nextStatus,
          forced: true,
          ...(trimmedNote ? { note: trimmedNote } : {}),
        },
      });
      return;
    }

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
      data: {
        previousStatus: caseRow.status,
        nextStatus,
        ...(trimmedNote ? { note: trimmedNote } : {}),
      },
    });
  }
}
