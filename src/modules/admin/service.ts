import type { StaffRole } from '../staff/permissions.js';
import type { CaseResolution, ApproveResolutionInput, CompleteResolutionInput, CancelResolutionInput } from '../resolutions/service.js';
import type { WorkflowSnapshot } from '../workflow/policy.js';

/** The three operational queues an admin can inspect (T8/O10). */
export type AdminQueue = 'standard' | 'manual_review' | 'incident';

export interface AdminCaseSummary {
  caseReference: string;
  status: string;
  subtype: string;
  incidentFlag: boolean;
  submittedAt: string;
  resolution?: Pick<CaseResolution, 'requestedType' | 'approvedType' | 'status'> | null;
  workflow?: WorkflowSnapshot;
}

export interface ListCasesFilter {
  queue?: AdminQueue;
  status?: string;
  resolutionType?: 'replacement' | 'refund';
  resolutionStatus?: 'requested' | 'approved' | 'externally_completed' | 'cancelled';
  incident?: boolean;
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

/** The recall campaign a case was submitted against (review context). */
export interface AdminCaseCampaign {
  slug: string;
  code: string;
  title?: string | undefined;
}

/**
 * A product the consumer claimed, with the identifiers the reviewer needs to
 * re-run the lot/date match. Non-PII by design (order numbers stay encrypted).
 */
export interface AdminCaseProduct {
  id: string;
  quantity: number;
  shape: string;
  flavor: string;
  lotCode: string;
  dateCode: string;
  purchaseChannel: string;
  purchaseDate?: string | null;
  checkResult: string;
  identificationMode?: string | null;
  reasonCodes?: string[] | null;
}

/** Evidence file metadata for a case. Never includes storage pathnames. */
export interface AdminCaseDocument {
  id: string;
  category: string;
  categorySlot?: number | null;
  originalFileName: string;
  declaredMimeType: string;
  sizeBytes: number;
  uploadStatus: string;
  scanStatus: string;
  uploadedAt?: string | null;
}

/** The safety incident reported with a case, plus its reportability gate. */
export interface AdminCaseIncident {
  id: string;
  answer: string;
  eventTypes: string[];
  injurySeverity?: string | null;
  medicalTreatment?: string | null;
  usedAsIntended?: string | null;
  occurredAt?: string | null;
  occurredDateUnknown: boolean;
  companyObtainedAt: string;
  reportability: {
    id: string;
    status: string;
    cpscReference?: string | null;
    filedAt?: string | null;
  } | null;
  /**
   * Decrypted narrative — returned ONLY for the raw PII tier (the same read
   * that writes the `pii.view_raw` audit event). Masked viewers never see it.
   */
  narrative?: string | undefined;
}

/** Incident operations row: one incident joined to its case and review gate. */
export interface AdminIncidentSummary {
  id: string;
  caseReference: string;
  caseStatus: string;
  answer: string;
  eventTypes: string[];
  injurySeverity?: string | null;
  medicalTreatment?: string | null;
  occurredAt?: string | null;
  createdAt: string;
  reportability: {
    id: string;
    status: string;
    cpscReference?: string | null;
    filedAt?: string | null;
    decisionAt?: string | null;
  } | null;
}

/** Campaign overview row for the intake surface (read-only). */
export interface AdminCampaignSummary {
  id: string;
  slug: string;
  code: string;
  status: string;
  launchAt?: string | null;
  closeAt?: string | null;
  title?: string | undefined;
  caseCount: number;
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
  campaign?: AdminCaseCampaign;
  products?: AdminCaseProduct[];
  documents?: AdminCaseDocument[];
  incident?: AdminCaseIncident | null;
  consumer: CaseDetailConsumer;
  resolution?: CaseResolution | null;
  workflow?: WorkflowSnapshot;
  events?: Array<{
    id: string;
    eventType: string;
    actorType: string;
    actorId: string | null;
    data: Record<string, unknown>;
    occurredAt: string;
  }>;
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

  /**
   * Incident operations list: every incident joined to its case reference and
   * reportability gate. Feeds the incidents & safety surface (case.queue.read).
   */
  listIncidents(): Promise<AdminIncidentSummary[]>;

  /** Read-only campaign overview with case counts (case.queue.read). */
  listCampaigns(): Promise<AdminCampaignSummary[]>;

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
   * `note` is persisted on the transition event; transitioning to `need_info`
   * requires it (the consumer must be told what to provide).
   */
  transitionCaseStatus(
    caseReference: string,
    nextStatus: string,
    actorUserId: string,
    note?: string,
  ): Promise<void>;

  approveResolution?(caseReference: string, input: Omit<ApproveResolutionInput, 'caseId'>): Promise<CaseResolution>;
  completeResolution?(caseReference: string, input: Omit<CompleteResolutionInput, 'caseId'>): Promise<CaseResolution>;
  cancelResolution?(caseReference: string, input: Omit<CancelResolutionInput, 'caseId'>): Promise<CaseResolution>;
}
