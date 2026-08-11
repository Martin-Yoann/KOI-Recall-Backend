import type { StaffRole } from '../staff/permissions.js';

/** The three operational queues an admin can inspect (T8/O10). */
export type AdminQueue = 'standard' | 'manual_review' | 'incident';

export interface AdminCaseSummary {
  caseReference: string;
  status: string;
  subtype: string;
  incidentFlag: boolean;
  submittedAt: string;
}

export interface ListCasesFilter {
  queue?: AdminQueue;
  status?: string;
  limit: number;
}

export interface CloseReportabilityReviewInput {
  outcome: 'filed' | 'documented_non_reportable';
  reviewerId: string;
  rationale: string;
  /** Required when outcome = filed. */
  cpscReference?: string;
}

/**
 * ADR-0004 §2.3: which PII tier the caller saw. `masked` means PII fields went
 * through `pii-masking.ts`; `raw` means they were decrypted in plaintext (and
 * the caller must have written a `pii.view_raw` audit event).
 */
export type PiiTier = 'masked' | 'raw';

/** The masked shape for a consumer field in a case detail view. */
export interface CaseDetailConsumer {
  piiTier: PiiTier;
  firstName?: string | undefined;
  lastName?: string | undefined;
  email?: string | undefined;
  phone?: string | undefined;
  countryCode?: string | undefined;
  address?: Record<string, unknown> | undefined;
}

/** Full case detail (ADR-0004 B8), with PII tier decided by the viewer's role. */
export interface AdminCaseDetail {
  caseReference: string;
  status: string;
  subtype: string;
  incidentFlag: boolean;
  submittedAt: string;
  assignedToStaffUserId: string | null;
  assignedAt: string | null;
  consumer: CaseDetailConsumer;
}

export interface GetCaseDetailInput {
  caseReference: string;
  /** The resolved role of the viewer — decides masked vs raw. */
  viewerRole: StaffRole;
}

/**
 * Single-role admin surface (T8/O10): case viewing, operational queues, full
 * export, and the reportability-close gate. All operations are read-heavy
 * except closing a reportability review, which is the auditable "reporting
 * obligation closed" transition.
 */
export interface AdminService {
  listCases(filter: ListCasesFilter): Promise<AdminCaseSummary[]>;

  /** Full case export for archive/reporting (T8/O10: complete export). */
  exportCases(): Promise<AdminCaseSummary[]>;

  /**
   * Closes a reportability review: pending -> filed (requires cpscReference)
   * or documented_non_reportable. The decision is recorded with the reviewer
   * id and rationale, satisfying the reportability obligation gate.
   */
  closeReportabilityReview(reviewId: string, input: CloseReportabilityReviewInput): Promise<void>;

  /**
   * ADR-0004 B8: case detail with two-tier PII. `viewerRole` decides masked vs
   * raw. Returns null when the case reference does not exist.
   */
  getCaseDetail(input: GetCaseDetailInput): Promise<AdminCaseDetail | null>;

  /** ADR-0004 B8: assign a case to a staff user. */
  assignCase(caseReference: string, staffUserId: string | null): Promise<void>;

  /**
   * ADR-0004 B8: transition a case status. Throws ClaimValidationError on an
   * illegal transition; ResourceNotFoundError if the case does not exist.
   */
  transitionCaseStatus(caseReference: string, nextStatus: string): Promise<void>;
}
