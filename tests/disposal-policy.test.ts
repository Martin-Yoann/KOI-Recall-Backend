import { describe, expect, it } from 'vitest';

import {
  assertCanIssueAuthorization,
  canIssueAuthorization,
  DISPOSAL_BLOCKING_REASONS,
  DisposalGateViolationError,
  evaluateDisposal,
  type DisposalPolicyState,
} from '../src/modules/disposal/policy.js';

/** The one state where every precondition holds. Each test breaks one thing. */
const satisfiable: DisposalPolicyState = {
  taskStatus: 'open',
  eligibilityStatus: 'confirmed_eligible',
  instructionStatus: 'approved',
  approvalAuthorizesDisposal: true,
  latestBatchReviewStatus: 'accepted',
  holdActive: false,
  authorizationStatus: null,
};

describe('disposal policy', () => {
  it('permits disposal when every precondition holds', () => {
    const snapshot = evaluateDisposal(satisfiable);
    expect(snapshot.blockingReasons).toEqual([]);
    expect(canIssueAuthorization(satisfiable)).toBe(true);
    expect(() => assertCanIssueAuthorization(satisfiable)).not.toThrow();
  });

  // D01: a potential match is not a confirmed match.
  it('blocks a product that is only a potential match', () => {
    const snapshot = evaluateDisposal({
      ...satisfiable,
      eligibilityStatus: 'pending_confirmation',
    });
    expect(snapshot.blockingReasons).toContain(DISPOSAL_BLOCKING_REASONS.ELIGIBILITY_NOT_CONFIRMED);
    expect(
      canIssueAuthorization({ ...satisfiable, eligibilityStatus: 'pending_confirmation' }),
    ).toBe(false);
  });

  // D03 / D28: the final measure is return, recycling, or other compensation, so
  // there is no consumer disposal to permit and no declaration to demand.
  it('blocks when the confirmed measure is not consumer disposal', () => {
    const state = { ...satisfiable, eligibilityStatus: 'not_applicable' as const };
    expect(evaluateDisposal(state).blockingReasons).toContain(
      DISPOSAL_BLOCKING_REASONS.DISPOSAL_NOT_APPLICABLE,
    );
    expect(canIssueAuthorization(state)).toBe(false);
  });

  it('blocks a product ruled ineligible', () => {
    const state = { ...satisfiable, eligibilityStatus: 'ineligible' as const };
    expect(canIssueAuthorization(state)).toBe(false);
  });

  // D04: no approved instruction content means no permission, and no invented
  // destruction method to show either.
  it('blocks when no instruction version is approved', () => {
    for (const instructionStatus of ['draft', null] as const) {
      const state = { ...satisfiable, instructionStatus };
      expect(evaluateDisposal(state).blockingReasons).toContain(
        DISPOSAL_BLOCKING_REASONS.INSTRUCTION_NOT_APPROVED,
      );
      expect(canIssueAuthorization(state)).toBe(false);
    }
  });

  // D15: a withdrawn instruction stops new permissions immediately.
  it('blocks a withdrawn instruction version', () => {
    const state = { ...satisfiable, instructionStatus: 'withdrawn' as const };
    expect(evaluateDisposal(state).blockingReasons).toContain(
      DISPOSAL_BLOCKING_REASONS.INSTRUCTION_WITHDRAWN,
    );
    expect(canIssueAuthorization(state)).toBe(false);
  });

  // D25 / D26: an approved-looking version whose only backing material is a NOV,
  // a lab report, a Form 332 procedure, or a CBP record.
  it('blocks when the approval does not authorize consumer disposal', () => {
    const state = { ...satisfiable, approvalAuthorizesDisposal: false };
    expect(evaluateDisposal(state).blockingReasons).toContain(
      DISPOSAL_BLOCKING_REASONS.APPROVAL_NOT_AUTHORIZING,
    );
    expect(canIssueAuthorization(state)).toBe(false);
  });

  it('does not let a non-authorizing approval pass just because the instruction is approved', () => {
    // Guards the ordering bug: instruction approved + approval recorded but
    // non-authorizing must still block.
    const state = {
      ...satisfiable,
      instructionStatus: 'approved' as const,
      approvalAuthorizesDisposal: false,
    };
    expect(canIssueAuthorization(state)).toBe(false);
  });

  // D06: `verified` is a malware/MIME fact. It is not acceptance.
  it('blocks while evidence has not been submitted at all', () => {
    const state = { ...satisfiable, latestBatchReviewStatus: null };
    expect(evaluateDisposal(state).blockingReasons).toContain(
      DISPOSAL_BLOCKING_REASONS.EVIDENCE_NOT_SUBMITTED,
    );
    expect(canIssueAuthorization(state)).toBe(false);
  });

  it('blocks while the photo review is still pending', () => {
    const state = { ...satisfiable, latestBatchReviewStatus: 'pending' as const };
    expect(evaluateDisposal(state).blockingReasons).toContain(
      DISPOSAL_BLOCKING_REASONS.EVIDENCE_PENDING_REVIEW,
    );
    expect(canIssueAuthorization(state)).toBe(false);
  });

  it.each(['needs_resubmission', 'superseded'] as const)(
    'blocks when the latest batch is %s',
    (latestBatchReviewStatus) => {
      const state = { ...satisfiable, latestBatchReviewStatus };
      expect(canIssueAuthorization(state)).toBe(false);
    },
  );

  // D12: even accepted photos do not permit disposal while a hold stands.
  it('blocks while an evidence-retention hold is in force', () => {
    const state = { ...satisfiable, holdActive: true };
    expect(evaluateDisposal(state).blockingReasons).toContain(
      DISPOSAL_BLOCKING_REASONS.DISPOSAL_ON_HOLD,
    );
    expect(canIssueAuthorization(state)).toBe(false);
  });

  it.each(['completed', 'cancelled', 'expired'] as const)('blocks a %s task', (taskStatus) => {
    const state = { ...satisfiable, taskStatus };
    expect(evaluateDisposal(state).blockingReasons).toContain(
      DISPOSAL_BLOCKING_REASONS.TASK_CLOSED,
    );
    expect(canIssueAuthorization(state)).toBe(false);
  });

  // The separation the whole domain rests on: reviewing evidence is not the
  // same act as permitting disposal, so a hold must not stop the review.
  it('keeps evidence review available while a hold is in force', () => {
    const snapshot = evaluateDisposal({
      ...satisfiable,
      latestBatchReviewStatus: 'pending',
      holdActive: true,
    });
    expect(snapshot.mayReviewEvidence).toBe(true);
    expect(snapshot.allowedActions).toContain('disposal.review_batch');
    expect(snapshot.allowedActions).not.toContain('disposal.submit_evidence');
  });

  // A held task must not accept new evidence: the point of the hold is to stop
  // the process where it is.
  it('refuses new evidence while a hold is in force', () => {
    const snapshot = evaluateDisposal({
      ...satisfiable,
      latestBatchReviewStatus: null,
      holdActive: true,
    });
    expect(snapshot.maySubmitEvidence).toBe(false);
  });

  it('offers a resubmission only after a rejection, not before any submission', () => {
    expect(
      evaluateDisposal({ ...satisfiable, latestBatchReviewStatus: null }).allowedActions,
    ).toContain('disposal.submit_evidence');
    expect(
      evaluateDisposal({ ...satisfiable, latestBatchReviewStatus: 'needs_resubmission' })
        .allowedActions,
    ).toContain('disposal.resubmit_evidence');
    expect(
      evaluateDisposal({ ...satisfiable, latestBatchReviewStatus: 'pending' }).allowedActions,
    ).not.toContain('disposal.resubmit_evidence');
  });

  // The service must fail closed with a reason, so a missed gate surfaces as an
  // actionable message rather than a bare 500.
  describe('assertCanIssueAuthorization', () => {
    it('names the specific unmet precondition', () => {
      const cases = [
        [{ ...satisfiable, holdActive: true }, DISPOSAL_BLOCKING_REASONS.DISPOSAL_ON_HOLD],
        [
          { ...satisfiable, latestBatchReviewStatus: null },
          DISPOSAL_BLOCKING_REASONS.EVIDENCE_NOT_SUBMITTED,
        ],
        [
          { ...satisfiable, eligibilityStatus: 'pending_confirmation' as const },
          DISPOSAL_BLOCKING_REASONS.ELIGIBILITY_NOT_CONFIRMED,
        ],
        [
          { ...satisfiable, approvalAuthorizesDisposal: false },
          DISPOSAL_BLOCKING_REASONS.APPROVAL_NOT_AUTHORIZING,
        ],
      ] as const;

      for (const [state, expected] of cases) {
        try {
          assertCanIssueAuthorization(state);
          throw new Error('expected the gate to refuse');
        } catch (error) {
          expect(error).toBeInstanceOf(DisposalGateViolationError);
          expect((error as DisposalGateViolationError).reason).toBe(expected);
        }
      }
    });
  });
});
