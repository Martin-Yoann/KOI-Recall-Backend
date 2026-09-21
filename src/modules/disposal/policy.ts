/**
 * Disposal policy — the single source of truth for whether a consumer may be
 * told to dispose of a recalled product.
 *
 * Pure and database-free on purpose. The service layer calls the very same
 * function before it writes an authorization, so the rule an operator sees in
 * `allowedActions` and the rule the server enforces cannot drift apart. The
 * previous compliance round established this shape in
 * `modules/workflow/policy.ts`; disposal follows it.
 *
 * The domain separates five facts, and every one of them is a precondition:
 *
 *   1. the product is confirmed affected      (not merely a potential match)
 *   2. the instruction version is approved     (and not withdrawn)
 *   3. an approval actually authorizes it      (a NOV never does — see the CHECK
 *                                               on `disposal_instruction_approvals`)
 *   4. a human accepted the evidence photos    (technical verification is not
 *                                               acceptance)
 *   5. no evidence-retention hold is in force  (independent of the reportability
 *                                               review's own status)
 *
 * An earlier stage passing says nothing about a later one. That is the point.
 */

export type DisposalApprovalMaterial =
  | 'recall_expectation_letter'
  | 'cap_or_written_coordination'
  | 'nov'
  | 'laboratory_report'
  | 'form_332_inventory_procedure'
  | 'cbp_seizure_record'
  | 'other';

export type DisposalApprovalScope =
  'consumer_held_product' | 'enterprise_inventory' | 'port_involved_goods' | 'not_determined';

export type DisposalMeasure =
  | 'consumer_disposal'
  | 'consumer_return'
  | 'professional_recycling'
  | 'other_compensation'
  | 'not_determined';

/** The only materials that can ever back a consumer-disposal permission. */
export const CONSUMER_AUTHORIZING_MATERIALS: readonly DisposalApprovalMaterial[] = [
  'recall_expectation_letter',
  'cap_or_written_coordination',
];

/**
 * Whether a piece of approval material authorizes telling a consumer to dispose
 * of the product.
 *
 * Computed, never supplied. The service derives this from the material, scope,
 * and measure and stores the result; the database CHECK pins the stored boolean
 * to the same algebra, so a caller — a form, an admin screen, or a direct SQL
 * statement — cannot record a Notice of Violation, a laboratory report, a
 * Form 332 inventory procedure, or a CBP seizure record as a consumer-disposal
 * permission. Recording them is allowed and expected; the history matters.
 *
 * `scope` must be the consumer-held product: an authorization covering
 * enterprise inventory or port-involved goods is a different measure entirely,
 * and `measure` must actually be consumer disposal.
 */
export function authorizesConsumerDisposal(input: {
  materialType: DisposalApprovalMaterial;
  scope: DisposalApprovalScope;
  measure: DisposalMeasure;
}): boolean {
  return (
    input.measure === 'consumer_disposal' &&
    input.scope === 'consumer_held_product' &&
    CONSUMER_AUTHORIZING_MATERIALS.includes(input.materialType)
  );
}

export type DisposalInstructionStatus = 'draft' | 'approved' | 'withdrawn';
export type DisposalEligibilityStatus =
  'pending_confirmation' | 'confirmed_eligible' | 'not_applicable' | 'ineligible';
export type DisposalTaskStatus = 'open' | 'completed' | 'cancelled' | 'expired';
export type DisposalBatchReviewStatus =
  'pending' | 'accepted' | 'needs_resubmission' | 'superseded';
export type DisposalAuthorizationStatus = 'active' | 'suspended' | 'revoked';

/** Stable reason codes, mirroring `workflow/policy.ts`'s BLOCKING_REASONS. */
export const DISPOSAL_BLOCKING_REASONS = {
  /** Still awaiting the human decision that the product is confirmed affected. */
  ELIGIBILITY_NOT_CONFIRMED: 'ELIGIBILITY_NOT_CONFIRMED',
  /** The proposed measure is return, recycling, or other compensation. */
  DISPOSAL_NOT_APPLICABLE: 'DISPOSAL_NOT_APPLICABLE',
  PRODUCT_RULED_INELIGIBLE: 'PRODUCT_RULED_INELIGIBLE',
  /** No approved instruction version exists for the pinned campaign version. */
  INSTRUCTION_NOT_APPROVED: 'INSTRUCTION_NOT_APPROVED',
  INSTRUCTION_WITHDRAWN: 'INSTRUCTION_WITHDRAWN',
  /** An approval record exists but does not authorize consumer disposal. */
  APPROVAL_NOT_AUTHORIZING: 'APPROVAL_NOT_AUTHORIZING',
  EVIDENCE_NOT_SUBMITTED: 'EVIDENCE_NOT_SUBMITTED',
  EVIDENCE_PENDING_REVIEW: 'EVIDENCE_PENDING_REVIEW',
  EVIDENCE_NEEDS_RESUBMISSION: 'EVIDENCE_NEEDS_RESUBMISSION',
  /** A compliance hold is in force; even accepted photos do not permit disposal. */
  DISPOSAL_ON_HOLD: 'DISPOSAL_ON_HOLD',
  TASK_CLOSED: 'TASK_CLOSED',
} as const;

export type DisposalBlockingReason =
  (typeof DISPOSAL_BLOCKING_REASONS)[keyof typeof DISPOSAL_BLOCKING_REASONS];

export interface DisposalPolicyState {
  taskStatus: DisposalTaskStatus;
  eligibilityStatus: DisposalEligibilityStatus;
  instructionStatus: DisposalInstructionStatus | null;
  /**
   * Whether an approval on the instruction version authorizes consumer disposal.
   * Computed from the approval rows, never supplied by a client.
   */
  approvalAuthorizesDisposal: boolean;
  /** Review status of the latest evidence batch; null when none was submitted. */
  latestBatchReviewStatus: DisposalBatchReviewStatus | null;
  /** A hold with no release timestamp exists. */
  holdActive: boolean;
  authorizationStatus: DisposalAuthorizationStatus | null;
}

export interface DisposalPolicySnapshot {
  /** Action ids the operator or consumer may take from this state. */
  allowedActions: string[];
  /** Stable codes explaining what is currently blocked, in evaluation order. */
  blockingReasons: DisposalBlockingReason[];
  /**
   * Whether photo evidence may be accepted for this task. Reviewing evidence is
   * a separate act from permitting disposal, so it stays available while a hold
   * or a pending authorization decision blocks the later step.
   */
  mayReviewEvidence: boolean;
  /** Whether a new evidence batch may be submitted. */
  maySubmitEvidence: boolean;
}

/**
 * Evaluates the full gate. Order matters for the reason codes: they read as the
 * sequence of things to fix, so the first unmet precondition is the one an
 * operator should act on.
 */
export function evaluateDisposal(state: DisposalPolicyState): DisposalPolicySnapshot {
  const blockingReasons: DisposalBlockingReason[] = [];
  const allowedActions: string[] = [];

  const taskOpen = state.taskStatus === 'open';
  if (!taskOpen) {
    blockingReasons.push(DISPOSAL_BLOCKING_REASONS.TASK_CLOSED);
  }

  // 1. Confirmed affected. `pending_confirmation` is not a soft yes — a
  //    potential match stays unconfirmed until a person says otherwise.
  if (state.eligibilityStatus === 'pending_confirmation') {
    blockingReasons.push(DISPOSAL_BLOCKING_REASONS.ELIGIBILITY_NOT_CONFIRMED);
  } else if (state.eligibilityStatus === 'not_applicable') {
    blockingReasons.push(DISPOSAL_BLOCKING_REASONS.DISPOSAL_NOT_APPLICABLE);
  } else if (state.eligibilityStatus === 'ineligible') {
    blockingReasons.push(DISPOSAL_BLOCKING_REASONS.PRODUCT_RULED_INELIGIBLE);
  }
  const eligibilityConfirmed = state.eligibilityStatus === 'confirmed_eligible';

  // 2. An approved instruction version must exist and still be in force.
  if (state.instructionStatus === null || state.instructionStatus === 'draft') {
    blockingReasons.push(DISPOSAL_BLOCKING_REASONS.INSTRUCTION_NOT_APPROVED);
  } else if (state.instructionStatus === 'withdrawn') {
    blockingReasons.push(DISPOSAL_BLOCKING_REASONS.INSTRUCTION_WITHDRAWN);
  }
  const instructionUsable = state.instructionStatus === 'approved';

  // 3. The approval behind that version must actually authorize disposal. This
  //    is where a Notice of Violation, a lab report, or a Form 332 inventory
  //    procedure stops: they are recordable evidence, not permission.
  if (instructionUsable && !state.approvalAuthorizesDisposal) {
    blockingReasons.push(DISPOSAL_BLOCKING_REASONS.APPROVAL_NOT_AUTHORIZING);
  }
  const approvalAuthorizes = instructionUsable && state.approvalAuthorizesDisposal;

  // 4. Evidence must exist and have been accepted by a person. `verified` is a
  //    malware/MIME fact and never substitutes for this.
  if (state.latestBatchReviewStatus === null) {
    blockingReasons.push(DISPOSAL_BLOCKING_REASONS.EVIDENCE_NOT_SUBMITTED);
  } else if (state.latestBatchReviewStatus === 'pending') {
    blockingReasons.push(DISPOSAL_BLOCKING_REASONS.EVIDENCE_PENDING_REVIEW);
  } else if (state.latestBatchReviewStatus !== 'accepted') {
    blockingReasons.push(DISPOSAL_BLOCKING_REASONS.EVIDENCE_NEEDS_RESUBMISSION);
  }

  // 5. A compliance hold blocks disposal regardless of what the photos show.
  //    Deliberately independent of the reportability review: closing the review
  //    is not a reason to release a hold.
  if (state.holdActive) {
    blockingReasons.push(DISPOSAL_BLOCKING_REASONS.DISPOSAL_ON_HOLD);
  }

  // --- actions -------------------------------------------------------------
  // Reviewing photos is available as soon as evidence exists, even while a hold
  // is in force: compliance still needs to look at what was submitted, and
  // "reviewed" must never be conflated with "permitted".
  if (taskOpen && state.latestBatchReviewStatus === 'pending') {
    allowedActions.push('disposal.review_batch');
  }
  if (taskOpen && eligibilityConfirmed && approvalAuthorizes && !state.holdActive) {
    if (state.latestBatchReviewStatus === null) {
      allowedActions.push('disposal.submit_evidence');
    } else if (
      state.latestBatchReviewStatus === 'needs_resubmission' ||
      state.latestBatchReviewStatus === 'superseded'
    ) {
      allowedActions.push('disposal.resubmit_evidence');
    }
  }
  if (taskOpen) {
    allowedActions.push('disposal.hold.place');
  }
  if (taskOpen && state.holdActive) {
    allowedActions.push('disposal.hold.release');
  }
  if (taskOpen && approvalAuthorizes && state.authorizationStatus === null) {
    // Not an operator action: the server issues this once the gate passes.
    allowedActions.push('disposal.issue_authorization');
  }

  return {
    allowedActions,
    blockingReasons,
    mayReviewEvidence: taskOpen && state.latestBatchReviewStatus === 'pending',
    maySubmitEvidence:
      taskOpen &&
      eligibilityConfirmed &&
      approvalAuthorizes &&
      !state.holdActive &&
      (state.latestBatchReviewStatus === null ||
        state.latestBatchReviewStatus === 'needs_resubmission' ||
        state.latestBatchReviewStatus === 'superseded'),
  };
}

/**
 * The hard gate. Every precondition must hold; there is no force flag and no
 * role that bypasses it.
 *
 * Defined as "no blocking reasons" rather than as a second conjunction of the
 * same conditions. An independently written conjunction is a rule that can drift
 * from the one operators are shown; this cannot.
 */
export function canIssueAuthorization(state: DisposalPolicyState): boolean {
  return evaluateDisposal(state).blockingReasons.length === 0;
}

/**
 * Declares the invariant as an exception so the service cannot forget it. The
 * message names the specific unmet precondition, which is what makes a 500 from
 * a missed gate actionable rather than mysterious.
 */
export class DisposalGateViolationError extends Error {
  constructor(public readonly reason: DisposalBlockingReason) {
    super(`Disposal authorization was refused: ${reason}.`);
    this.name = 'DisposalGateViolationError';
  }
}

export function assertCanIssueAuthorization(state: DisposalPolicyState): void {
  if (canIssueAuthorization(state)) return;
  const refusalOrder: readonly DisposalBlockingReason[] = [
    DISPOSAL_BLOCKING_REASONS.TASK_CLOSED,
    DISPOSAL_BLOCKING_REASONS.ELIGIBILITY_NOT_CONFIRMED,
    DISPOSAL_BLOCKING_REASONS.DISPOSAL_NOT_APPLICABLE,
    DISPOSAL_BLOCKING_REASONS.PRODUCT_RULED_INELIGIBLE,
    DISPOSAL_BLOCKING_REASONS.INSTRUCTION_NOT_APPROVED,
    DISPOSAL_BLOCKING_REASONS.INSTRUCTION_WITHDRAWN,
    DISPOSAL_BLOCKING_REASONS.APPROVAL_NOT_AUTHORIZING,
    DISPOSAL_BLOCKING_REASONS.EVIDENCE_NOT_SUBMITTED,
    DISPOSAL_BLOCKING_REASONS.EVIDENCE_PENDING_REVIEW,
    DISPOSAL_BLOCKING_REASONS.EVIDENCE_NEEDS_RESUBMISSION,
    DISPOSAL_BLOCKING_REASONS.DISPOSAL_ON_HOLD,
  ];
  const unmet = evaluateDisposal(state).blockingReasons;
  for (const reason of refusalOrder) {
    if (unmet.includes(reason)) throw new DisposalGateViolationError(reason);
  }
  throw new DisposalGateViolationError(DISPOSAL_BLOCKING_REASONS.EVIDENCE_NOT_SUBMITTED);
}
