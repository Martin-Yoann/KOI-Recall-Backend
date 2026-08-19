/**
 * CaseWorkflowPolicy — the single source of truth for workflow state mapping
 * (ADR redesign §5.2 / §7). Pure, database-free, unit-testable.
 *
 * The admin list/detail/transition validation and the consumer-facing
 * status-lookup endpoint all consume the SAME `evaluate` function, so the
 * legal-transition and stage mapping can never drift between back-end and
 * front-end again (the old `LEGAL_TRANSITIONS` copy in the admin front-end is
 * retired — see B2).
 *
 * `responsibleDepartment` is a *display* value only. It is NOT an authorization
 * subject and must never be promoted into one (ADR redesign §17).
 */

export type CaseStatus =
  | 'submitted'
  | 'triage'
  | 'under_review'
  | 'need_info'
  | 'approved'
  | 'rejected'
  | 'duplicate'
  | 'withdrawn'
  | 'closure_review'
  | 'closed';

export type ReportabilityStatus = 'pending' | 'filed' | 'documented_non_reportable';

export type ResolutionType = 'replacement' | 'refund';
export type ResolutionStatus = 'requested' | 'approved' | 'externally_completed' | 'cancelled';

export type Department = 'customer_service' | 'compliance' | 'logistics' | 'finance' | 'none';

/** The inputs `evaluate` needs. Everything else stays out of the policy. */
export interface WorkflowCaseState {
  caseStatus: CaseStatus;
  subtype: 'standard' | 'injury_hazard';
  incidentFlag: boolean;
  /** null when there is no incident / reportability review. */
  reportabilityStatus: ReportabilityStatus | null;
  /** null when the case has no resolution row yet (pre-backfill window). */
  resolution: {
    requestedType: ResolutionType | null;
    approvedType: ResolutionType | null;
    status: ResolutionStatus | null;
  } | null;
}

export interface WorkflowSnapshot {
  currentStage: string;
  responsibleDepartment: Department;
  nextAction: string;
  /** Stable action ids the operator may take from this state. */
  allowedActions: string[];
  /** Stable reason codes explaining which transitions are currently blocked. */
  blockingReasons: string[];
  /** Consumer-facing status (ADR redesign §9.9). */
  publicStatus: string;
}

/** Stable blocking-reason codes. */
export const BLOCKING_REASONS = {
  RESOLUTION_NOT_EXTERNALLY_COMPLETED: 'resolution_not_externally_completed',
  REPORTABILITY_PENDING: 'reportability_pending',
} as const;

/** Stable consumer-facing statuses (ADR redesign §9.9). */
export const PUBLIC_STATUSES = {
  RECEIVED: 'received',
  IN_REVIEW: 'in_review',
  ACTION_REQUIRED: 'action_required',
  RESOLUTION_APPROVED: 'resolution_approved',
  RESOLUTION_IN_PROGRESS: 'resolution_in_progress',
  COMPLETED: 'completed',
  NOT_APPROVED: 'not_approved',
  CLOSED: 'closed',
} as const;

/** Case status transitions, after ADR redesign §8.2 (approved→closed is removed). */
const BASE_TRANSITIONS: Readonly<Record<CaseStatus, readonly CaseStatus[]>> = {
  submitted: ['triage', 'under_review', 'rejected', 'duplicate', 'withdrawn'],
  triage: ['under_review', 'need_info', 'approved', 'rejected', 'duplicate', 'withdrawn'],
  under_review: ['need_info', 'approved', 'rejected', 'closure_review', 'withdrawn'],
  need_info: ['under_review', 'approved', 'rejected', 'withdrawn'],
  approved: ['closure_review'],
  closure_review: ['closed', 'under_review'],
  closed: [],
  rejected: [],
  duplicate: [],
  withdrawn: [],
};

interface StageRule {
  currentStage: string;
  responsibleDepartment: Department;
  nextAction: string;
}

/**
 * The stage/department/next-action mapping from ADR redesign §7. Each rule is
 * keyed by a compact discriminator resolved in {@link evaluate}; conditions not
 * expressible in a flat table (e.g. "triage with a pending incident") are
 * handled before the table lookup.
 */
const STAGE_RULES: Record<string, StageRule> = {
  submitted: {
    currentStage: 'intake_review',
    responsibleDepartment: 'customer_service',
    nextAction: 'Review the submission for completeness and begin triage.',
  },
  triage: {
    currentStage: 'triage',
    responsibleDepartment: 'customer_service',
    nextAction: 'Resolve product or evidence anomalies.',
  },
  compliance_review: {
    currentStage: 'compliance_review',
    responsibleDepartment: 'compliance',
    nextAction: 'Complete the safety incident reportability review.',
  },
  under_review: {
    currentStage: 'case_review',
    responsibleDepartment: 'customer_service',
    nextAction: 'Complete product, evidence, and risk assessment.',
  },
  need_info: {
    currentStage: 'awaiting_consumer_information',
    responsibleDepartment: 'customer_service',
    nextAction: 'Wait for and verify requested additional information.',
  },
  resolution_approval: {
    currentStage: 'resolution_approval',
    responsibleDepartment: 'customer_service',
    nextAction: 'Approve a Replacement or Refund resolution.',
  },
  replacement_processing: {
    currentStage: 'replacement_processing',
    responsibleDepartment: 'logistics',
    nextAction: 'Process the replacement in the external fulfillment system.',
  },
  refund_processing: {
    currentStage: 'refund_processing',
    responsibleDepartment: 'finance',
    nextAction: 'Process the refund via Refund Export in the external system.',
  },
  closure_review: {
    currentStage: 'closure_review',
    responsibleDepartment: 'compliance',
    nextAction: 'Verify closure conditions.',
  },
  completed: {
    currentStage: 'completed',
    responsibleDepartment: 'none',
    nextAction: 'None',
  },
  final: {
    currentStage: 'final',
    responsibleDepartment: 'none',
    nextAction: 'None',
  },
};

type StageKey = keyof typeof STAGE_RULES;

function isIncidentPending(state: WorkflowCaseState): boolean {
  return state.incidentFlag && state.reportabilityStatus === 'pending';
}

function resolutionExternallyCompleted(state: WorkflowCaseState): boolean {
  return state.resolution?.status === 'externally_completed';
}

/**
 * Resolve the stage key for the ADR §7 table, applying the two conditional
 * overrides (pending incident → compliance_review; approved with no approved
 * resolution → resolution_approval; approved with an approved resolution →
 * replacement/refund processing).
 */
function stageKey(state: WorkflowCaseState): StageKey {
  if (state.caseStatus === 'submitted') return 'submitted';
  if (state.caseStatus === 'triage') {
    return isIncidentPending(state) ? 'compliance_review' : 'triage';
  }
  if (state.caseStatus === 'under_review') {
    return isIncidentPending(state) ? 'compliance_review' : 'under_review';
  }
  if (state.caseStatus === 'need_info') return 'need_info';
  if (state.caseStatus === 'approved') {
    const resolutionStatus = state.resolution?.status ?? null;
    if (resolutionStatus === 'approved') {
      return state.resolution?.approvedType === 'refund'
        ? 'refund_processing'
        : 'replacement_processing';
    }
    if (resolutionStatus === 'externally_completed') return 'closure_review';
    return 'resolution_approval';
  }
  if (state.caseStatus === 'closure_review') return 'closure_review';
  if (state.caseStatus === 'closed') return 'completed';
  return 'final'; // rejected / duplicate / withdrawn
}

/** Case status transitions after the ADR §8.2 closure gates are applied. */
function allowedCaseTransitions(state: WorkflowCaseState): { actions: string[]; blocking: string[] } {
  const base = [...BASE_TRANSITIONS[state.caseStatus]];
  const blocking: string[] = [];

  // approved → closure_review requires resolution externally_completed.
  if (state.caseStatus === 'approved' && base.includes('closure_review')) {
    if (!resolutionExternallyCompleted(state)) {
      base.splice(base.indexOf('closure_review'), 1);
      blocking.push(BLOCKING_REASONS.RESOLUTION_NOT_EXTERNALLY_COMPLETED);
    }
  }

  // closure_review → closed requires resolution done + reportability closed.
  if (state.caseStatus === 'closure_review' && base.includes('closed')) {
    let closedAllowed = true;
    if (!resolutionExternallyCompleted(state)) {
      closedAllowed = false;
      blocking.push(BLOCKING_REASONS.RESOLUTION_NOT_EXTERNALLY_COMPLETED);
    }
    if (isIncidentPending(state)) {
      closedAllowed = false;
      blocking.push(BLOCKING_REASONS.REPORTABILITY_PENDING);
    }
    if (!closedAllowed) base.splice(base.indexOf('closed'), 1);
  }

  return { actions: base.map((s) => `transition:${s}`), blocking };
}

/** Resolution actions available from the current resolution status. */
function resolutionActions(state: WorkflowCaseState): string[] {
  switch (state.resolution?.status ?? null) {
    case 'requested':
      return ['resolution:approve', 'resolution:cancel'];
    case 'approved':
      return ['resolution:complete', 'resolution:cancel'];
    default:
      return [];
  }
}

/** Consumer-facing status (ADR redesign §9.9). */
function publicStatus(state: WorkflowCaseState): string {
  switch (state.caseStatus) {
    case 'submitted':
      return PUBLIC_STATUSES.RECEIVED;
    case 'triage':
    case 'under_review':
      return PUBLIC_STATUSES.IN_REVIEW;
    case 'need_info':
      return PUBLIC_STATUSES.ACTION_REQUIRED;
    case 'approved': {
      const resolutionStatus = state.resolution?.status ?? null;
      if (resolutionStatus === 'approved') return PUBLIC_STATUSES.RESOLUTION_APPROVED;
      if (resolutionStatus === 'externally_completed')
        return PUBLIC_STATUSES.RESOLUTION_IN_PROGRESS;
      return PUBLIC_STATUSES.IN_REVIEW;
    }
    case 'closure_review':
      return PUBLIC_STATUSES.RESOLUTION_IN_PROGRESS;
    case 'closed':
      return PUBLIC_STATUSES.COMPLETED;
    case 'rejected':
      return PUBLIC_STATUSES.NOT_APPROVED;
    case 'duplicate':
    case 'withdrawn':
      return PUBLIC_STATUSES.CLOSED;
  }
}

/**
 * The policy's single entry point (ADR redesign §5.2). Pure and side-effect
 * free: same inputs always produce the same snapshot.
 */
export function evaluate(state: WorkflowCaseState): WorkflowSnapshot {
  // stageKey only ever returns a key present in STAGE_RULES; the assertion keeps
  // `noUncheckedIndexedAccess` happy without weakening the return type.
  const rule = STAGE_RULES[stageKey(state)]!;
  const transitions = allowedCaseTransitions(state);

  return {
    currentStage: rule.currentStage,
    responsibleDepartment: rule.responsibleDepartment,
    nextAction: rule.nextAction,
    allowedActions: [...transitions.actions, ...resolutionActions(state)],
    blockingReasons: transitions.blocking,
    publicStatus: publicStatus(state),
  };
}
