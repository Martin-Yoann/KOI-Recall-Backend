import type { ResolutionStatus, ResolutionType } from '../workflow/policy.js';

/**
 * Maps an admin case-status transition to the consumer email it must enqueue
 * (trigger catalogue 02 / 04 / 07 / 08). Pure and database-free, so the
 * "which status sends which email" rule can be unit-tested without a DB —
 * the same way `workflow/policy.ts` owns the transition matrix.
 *
 * Returns null when the transition is not consumer-visible (triage,
 * under_review, approved, ...) or when the email would need a
 * consumer-visible reason that was not supplied — never send a reason-less
 * decision or closure email.
 */

export interface CaseStatusEmailContext {
  caseId: string;
  caseReference: string;
  /** `case_events.id` of the recorded transition — unique per event. */
  eventId: string;
  /** Operator-written, consumer-visible instruction or reason. */
  note?: string;
  resolutionStatus: ResolutionStatus | null;
  approvedType: ResolutionType | null;
  /** Consumer web app base URL, used to build the need_info CTA. */
  consumerWebBaseUrl: string;
}

export interface CaseStatusEmail {
  templateKey: string;
  variables: Record<string, string>;
  deduplicationKey: string;
  eventType: string;
}

function resolvedResolutionLabel(approvedType: ResolutionType | null): string {
  if (approvedType === 'refund') return 'Refund';
  if (approvedType === 'replacement') return 'Replacement';
  return 'Your selected remedy';
}

/** 08 `case_closed` — withdrawn, or force-closed without a completed remedy. */
function closureEmail(context: CaseStatusEmailContext): CaseStatusEmail | null {
  const reason = context.note?.trim();
  if (!reason) return null;
  return {
    templateKey: 'case_closed',
    variables: { caseReference: context.caseReference, closureReason: reason },
    deduplicationKey: `case-closed:${context.caseId}:${context.eventId}`,
    eventType: 'case.closed.requested',
  };
}

export function resolveCaseStatusEmail(
  nextStatus: string,
  context: CaseStatusEmailContext,
): CaseStatusEmail | null {
  switch (nextStatus) {
    case 'need_info': {
      const instruction = context.note?.trim();
      if (!instruction) return null;
      return {
        templateKey: 'need_info',
        variables: {
          caseReference: context.caseReference,
          requestedInformation: instruction,
          actionUrl: `${context.consumerWebBaseUrl}/dashboard/claims/${context.caseReference}`,
        },
        deduplicationKey: `case-action-required:${context.caseId}:${context.eventId}`,
        eventType: 'case.action_required.requested',
      };
    }
    case 'rejected':
    case 'duplicate': {
      const reason = context.note?.trim();
      if (!reason) return null;
      return {
        templateKey: 'claim_rejected',
        variables: { caseReference: context.caseReference, reason },
        deduplicationKey: `case-not-approved:${context.caseId}:${context.eventId}`,
        eventType: 'case.not_approved.requested',
      };
    }
    case 'closed': {
      // "Complete" wording is only truthful once the remedy was externally
      // completed; a force-closed case without one is a closure instead.
      if (context.resolutionStatus === 'externally_completed') {
        return {
          templateKey: 'case_completed',
          variables: {
            caseReference: context.caseReference,
            completedResolutionLabel: resolvedResolutionLabel(context.approvedType),
          },
          deduplicationKey: `case-completed:${context.caseId}:${context.eventId}`,
          eventType: 'case.completed.requested',
        };
      }
      return closureEmail(context);
    }
    case 'withdrawn':
      return closureEmail(context);
    default:
      // triage / under_review / approved / closure_review are noise-control
      // statuses: visible in the status portal, never a new email.
      return null;
  }
}

/**
 * Statuses whose consumer email always renders the operator note, whatever
 * the case state.
 */
export const REASON_REQUIRED_STATUSES: readonly string[] = [
  'need_info',
  'rejected',
  'duplicate',
  'withdrawn',
];

/**
 * Whether a transition to `nextStatus` owes the consumer a reason — the
 * reason facet of the mapping above: every status whose email renders the
 * note needs one. `closed` depends on the resolution row: a closure after
 * an externally completed remedy sends case_completed, which speaks for
 * itself; any other closure renders the note as its closureReason.
 */
export function transitionRequiresReason(
  nextStatus: string,
  resolutionStatus: ResolutionStatus | null,
): boolean {
  if (nextStatus === 'closed') return resolutionStatus !== 'externally_completed';
  return REASON_REQUIRED_STATUSES.includes(nextStatus);
}

/** The consumer-facing validation message for a missing transition reason. */
export function transitionReasonRequiredMessage(nextStatus: string): string {
  return nextStatus === 'need_info'
    ? 'A note of at least 10 characters is required when requesting additional information.'
    : `A consumer-visible reason of at least 10 characters is required when moving a case to '${nextStatus}'.`;
}
