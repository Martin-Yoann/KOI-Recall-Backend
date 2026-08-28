import type {
  caseResolutionStatusEnum,
  caseResolutionTypeEnum,
  recallCaseStatusEnum,
} from '../../db/schema/index.js';
import {
  CONSUMER_NEXT_ACTIONS,
  PUBLIC_CASE_STATUS_LABELS,
  type PublicCaseStatus,
} from '../../contracts/toc.js';

/** The full union of `recall_cases.status` values. */
export type InternalCaseStatus = (typeof recallCaseStatusEnum.enumValues)[number];
export type ResolutionType = (typeof caseResolutionTypeEnum.enumValues)[number];
export type ResolutionStatus = (typeof caseResolutionStatusEnum.enumValues)[number];

/**
 * The normalized Resolution slice the mapping needs. Both `requestedType` and
 * `approvedType` are nullable for legacy rows (M1 backfill), exactly as stored.
 */
export interface PublicResolutionInput {
  status: ResolutionStatus | null;
  requestedType: ResolutionType | null;
  approvedType: ResolutionType | null;
}

export interface MappedPublicCaseState {
  publicStatus: PublicCaseStatus;
  /** Whether the approved-resolution fact may be shown to the consumer. */
  approvedVisible: boolean;
}

const RESOLUTION_DISPLAY_NAMES: Record<ResolutionType, string> = {
  replacement: 'Replacement',
  refund: 'Refund',
};

export function resolutionDisplayName(type: ResolutionType | null): string | null {
  return type ? RESOLUTION_DISPLAY_NAMES[type] : null;
}

/**
 * Deterministic internal-lifecycle → public-status map. The switch is total
 * over the pgEnum union with no default arm, so adding an internal status
 * without a public counterpart is a compile error, never an orphan state at
 * runtime. Terminal consumer-facing facts are sticky: once a case is
 * rejected/duplicate/withdrawn, later lifecycle movement cannot flip it to a
 * positive status.
 */
export function mapToPublicCaseState(
  caseStatus: InternalCaseStatus,
  resolution: PublicResolutionInput,
): MappedPublicCaseState {
  let publicStatus: PublicCaseStatus;
  switch (caseStatus) {
    case 'submitted':
      publicStatus = 'received';
      break;
    case 'triage':
    case 'under_review':
      publicStatus = 'in_review';
      break;
    case 'need_info':
      publicStatus = 'action_required';
      break;
    case 'approved':
      publicStatus = 'resolution_approved';
      break;
    case 'closure_review':
      publicStatus = 'resolution_in_progress';
      break;
    case 'rejected':
    case 'duplicate':
      publicStatus = 'not_approved';
      break;
    case 'withdrawn':
      publicStatus = 'closed';
      break;
    case 'closed':
      // A closed case reads as "Completed" when an approval preceded it;
      // otherwise it stays a neutral closure. Externally-completed resolutions
      // surface as Completed regardless of how far the lifecycle flag moved.
      if (resolution.status === 'externally_completed') {
        publicStatus = 'completed';
      } else {
        publicStatus = resolution.approvedType !== null ? 'completed' : 'closed';
      }
      break;
  }

  const approvedVisible =
    resolution.approvedType !== null &&
    (publicStatus === 'resolution_approved' ||
      publicStatus === 'resolution_in_progress' ||
      publicStatus === 'completed');

  return { publicStatus, approvedVisible };
}

export function publicStatusLabel(status: PublicCaseStatus): string {
  return PUBLIC_CASE_STATUS_LABELS[status];
}

export function consumerNextAction(status: PublicCaseStatus): string {
  return CONSUMER_NEXT_ACTIONS[status];
}
