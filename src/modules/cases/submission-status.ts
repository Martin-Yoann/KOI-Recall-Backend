import type { CaseStatus } from '../workflow/policy.js';

/**
 * Where a submitted claim starts, and whether it carries an incident.
 *
 * Extracted from `submit` so the rule can be read and tested on its own: it is the only
 * place that decides a case's first status, it is reached today only through a real
 * database submission, and the precedence inside it is not obvious.
 */
export interface SubmissionStatusInput {
  /** The consumer's answer; anything but `no` means the claim reports an incident. */
  incidentAnswer: string;
  /** How each claimed product fared against the pinned Campaign Version. */
  productResults: readonly { evaluation: { result: string } }[];
  /** Phase 2 of the escalation rollout; see INCIDENT_ESCALATED_STATUS. */
  incidentEscalatedStatus: boolean;
}

export interface SubmissionStatus {
  hasIncident: boolean;
  caseStatus: CaseStatus;
  subtype: 'standard' | 'injury_hazard';
}

/**
 * Precedence matters here, and product verification outranks escalation: a case whose
 * product is not verified yet cannot be worked by compliance, and an `unsure` answer is
 * the consumer saying they cannot confirm the product — which is exactly triage's job. So
 * an incident reaches `escalated` only when its products are already verified. The
 * compliance fact is not lost when it lands in `triage` instead: it is carried by the
 * incident flag, the subtype, the pending review, and the derived stage, which is where
 * "with compliance" is expressed rather than in the status. With the escalation switch off
 * this is byte for byte the rule it replaces.
 */
export function deriveSubmissionStatus(input: SubmissionStatusInput): SubmissionStatus {
  const hasIncident = input.incidentAnswer !== 'no';
  const productsNeedReview = input.productResults.some(
    ({ evaluation }) => evaluation.result !== 'potential_match',
  );

  const caseStatus: CaseStatus =
    input.incidentAnswer === 'unsure' || productsNeedReview
      ? 'triage'
      : input.incidentEscalatedStatus && hasIncident
        ? 'escalated'
        : 'submitted';

  return { hasIncident, caseStatus, subtype: hasIncident ? 'injury_hazard' : 'standard' };
}
