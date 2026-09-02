import type { DatabaseExecutor } from '../../db/client.js';
import type { StaffRole } from '../staff/permissions.js';

/**
 * CaseResolutionModule — the single writer of `case_resolutions` (ADR redesign
 * §5.1). The consumer's requested resolution is captured at submission; the
 * operationally approved outcome (and, for refunds, amount/currency) is
 * recorded on approval. Callers never update the table directly.
 */

export type CaseResolutionType = 'replacement' | 'refund';
export type CaseResolutionStatus = 'requested' | 'approved' | 'externally_completed' | 'cancelled';

/** The read model returned by the module (no encrypted note payloads). */
export interface CaseResolution {
  id: string;
  caseId: string;
  requestedType: CaseResolutionType | null;
  requestedRemedyOptionId: string | null;
  approvedType: CaseResolutionType | null;
  status: CaseResolutionStatus;
  refundAmountMinor: number | null;
  currency: string | null;
  approvedByStaffUserId: string | null;
  approvedAt: string | null;
  externalReference: string | null;
  completedByStaffUserId: string | null;
  completedAt: string | null;
  version: number;
}

/**
 * Input for the submission-time write. Called inside the same transaction that
 * creates the Recall Case, so it takes the transaction executor rather than
 * opening its own.
 */
export interface RequestResolutionInput {
  caseId: string;
  requestedType: CaseResolutionType;
  requestedRemedyOptionId: string;
}

export interface ApproveResolutionInput {
  caseId: string;
  type: CaseResolutionType;
  /** Required when type === 'refund' (positive ISO 4217 minor units). */
  refundAmountMinor?: number;
  /** Required when type === 'refund' (uppercase ISO 4217 code). */
  currency?: string;
  /** Approval rationale, 10–1000 chars; stored AEAD-encrypted. */
  note: string;
  expectedVersion: number;
  actorUserId: string;
  actorRole: StaffRole;
}

export interface CompleteResolutionInput {
  caseId: string;
  /** External business reference only — never a payment credential. */
  externalReference?: string;
  /** Completion note, 10–2000 chars; stored AEAD-encrypted. */
  note: string;
  expectedVersion: number;
  actorUserId: string;
  actorRole: StaffRole;
}

export interface CancelResolutionInput {
  caseId: string;
  note: string;
  expectedVersion: number;
  actorUserId: string;
  actorRole: StaffRole;
  /** Only administrators may cancel an approved resolution (ADR redesign §8.1). */
  actorIsAdministrator: boolean;
}

export interface CaseResolutionService {
  /** Submission-time write; runs on the caller's transaction. */
  requestFromSubmission(tx: DatabaseExecutor, input: RequestResolutionInput): Promise<void>;

  /** requested → approved. Throws on version conflict or invalid state. */
  approve(input: ApproveResolutionInput): Promise<CaseResolution>;

  /** approved → externally_completed. No return path. */
  recordExternalCompletion(input: CompleteResolutionInput): Promise<CaseResolution>;

  /** requested → cancelled (any role) or approved → cancelled (administrator only). */
  cancel(input: CancelResolutionInput): Promise<CaseResolution>;

  /** Read-only lookup by case id. */
  getForCase(caseId: string): Promise<CaseResolution | null>;
}
