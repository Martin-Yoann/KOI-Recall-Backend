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
}
