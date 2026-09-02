import { describe, expect, it } from 'vitest';

import {
  evaluate,
  BLOCKING_REASONS,
  PUBLIC_STATUSES,
  type WorkflowCaseState,
} from '../src/modules/workflow/policy.js';

/** Base case state; individual tests spread over the fields they care about. */
function state(overrides: Partial<WorkflowCaseState> = {}): WorkflowCaseState {
  return {
    caseStatus: 'submitted',
    subtype: 'standard',
    incidentFlag: false,
    reportabilityStatus: null,
    resolution: null,
    ...overrides,
  };
}

function resolution(
  fields: Partial<NonNullable<WorkflowCaseState['resolution']>> = {},
): NonNullable<WorkflowCaseState['resolution']> {
  return {
    requestedType: 'replacement',
    approvedType: null,
    status: 'requested',
    ...fields,
  };
}

describe('CaseWorkflowPolicy — stage mapping (ADR redesign §7)', () => {
  it('maps submitted → intake_review / customer_service', () => {
    const snap = evaluate(state({ caseStatus: 'submitted' }));
    expect(snap.currentStage).toBe('intake_review');
    expect(snap.responsibleDepartment).toBe('customer_service');
  });

  it('maps triage without pending incident → triage / customer_service', () => {
    const snap = evaluate(state({ caseStatus: 'triage' }));
    expect(snap.currentStage).toBe('triage');
    expect(snap.responsibleDepartment).toBe('customer_service');
  });

  it('maps triage with pending incident → compliance_review / compliance', () => {
    const snap = evaluate(
      state({
        caseStatus: 'triage',
        incidentFlag: true,
        subtype: 'injury_hazard',
        reportabilityStatus: 'pending',
      }),
    );
    expect(snap.currentStage).toBe('compliance_review');
    expect(snap.responsibleDepartment).toBe('compliance');
  });

  it('maps under_review with pending incident → compliance_review', () => {
    const snap = evaluate(
      state({
        caseStatus: 'under_review',
        incidentFlag: true,
        subtype: 'injury_hazard',
        reportabilityStatus: 'pending',
      }),
    );
    expect(snap.currentStage).toBe('compliance_review');
  });

  it('maps under_review (no incident) → case_review', () => {
    const snap = evaluate(state({ caseStatus: 'under_review' }));
    expect(snap.currentStage).toBe('case_review');
  });

  it('maps need_info → awaiting_consumer_information', () => {
    const snap = evaluate(state({ caseStatus: 'need_info' }));
    expect(snap.currentStage).toBe('awaiting_consumer_information');
  });

  it('maps approved with no approved resolution → resolution_approval', () => {
    const snap = evaluate(
      state({ caseStatus: 'approved', resolution: resolution({ status: 'requested' }) }),
    );
    expect(snap.currentStage).toBe('resolution_approval');
    expect(snap.responsibleDepartment).toBe('customer_service');
  });

  it('maps approved + replacement approved → replacement_processing / logistics', () => {
    const snap = evaluate(
      state({
        caseStatus: 'approved',
        resolution: resolution({ status: 'approved', approvedType: 'replacement' }),
      }),
    );
    expect(snap.currentStage).toBe('replacement_processing');
    expect(snap.responsibleDepartment).toBe('logistics');
  });

  it('maps approved + refund approved → refund_processing / finance', () => {
    const snap = evaluate(
      state({
        caseStatus: 'approved',
        resolution: resolution({ status: 'approved', approvedType: 'refund' }),
      }),
    );
    expect(snap.currentStage).toBe('refund_processing');
    expect(snap.responsibleDepartment).toBe('finance');
  });

  it('maps approved + externally_completed → closure_review', () => {
    const snap = evaluate(
      state({
        caseStatus: 'approved',
        resolution: resolution({ status: 'externally_completed', approvedType: 'replacement' }),
      }),
    );
    expect(snap.currentStage).toBe('closure_review');
    expect(snap.responsibleDepartment).toBe('compliance');
  });

  it('maps closure_review → closure_review / compliance', () => {
    const snap = evaluate(state({ caseStatus: 'closure_review' }));
    expect(snap.currentStage).toBe('closure_review');
  });

  it('maps closed → completed / none', () => {
    const snap = evaluate(state({ caseStatus: 'closed' }));
    expect(snap.currentStage).toBe('completed');
    expect(snap.responsibleDepartment).toBe('none');
    expect(snap.nextAction).toBe('None');
  });

  it('maps rejected/duplicate/withdrawn → final / none', () => {
    for (const status of ['rejected', 'duplicate', 'withdrawn'] as const) {
      const snap = evaluate(state({ caseStatus: status }));
      expect(snap.currentStage).toBe('final');
      expect(snap.responsibleDepartment).toBe('none');
    }
  });
});

describe('CaseWorkflowPolicy — allowed actions & closure gates (§8.2)', () => {
  it('approved → closure_review is blocked until resolution externally_completed', () => {
    const snap = evaluate(
      state({ caseStatus: 'approved', resolution: resolution({ status: 'approved' }) }),
    );
    expect(snap.allowedActions).not.toContain('transition:closure_review');
    expect(snap.blockingReasons).toContain(BLOCKING_REASONS.RESOLUTION_NOT_EXTERNALLY_COMPLETED);
  });

  it('approved → closure_review is allowed once resolution externally_completed', () => {
    const snap = evaluate(
      state({
        caseStatus: 'approved',
        resolution: resolution({ status: 'externally_completed', approvedType: 'replacement' }),
      }),
    );
    expect(snap.allowedActions).toContain('transition:closure_review');
    expect(snap.blockingReasons).toHaveLength(0);
  });

  it('approved never allows → closed (direct close is forbidden)', () => {
    const snap = evaluate(
      state({
        caseStatus: 'approved',
        resolution: resolution({ status: 'externally_completed', approvedType: 'replacement' }),
      }),
    );
    expect(snap.allowedActions).not.toContain('transition:closed');
  });

  it('closure_review → closed blocked while reportability is pending', () => {
    const snap = evaluate(
      state({
        caseStatus: 'closure_review',
        incidentFlag: true,
        subtype: 'injury_hazard',
        reportabilityStatus: 'pending',
        resolution: resolution({ status: 'externally_completed', approvedType: 'replacement' }),
      }),
    );
    expect(snap.allowedActions).not.toContain('transition:closed');
    expect(snap.blockingReasons).toContain(BLOCKING_REASONS.REPORTABILITY_PENDING);
  });

  it('closure_review → closed allowed when all gates pass', () => {
    const snap = evaluate(
      state({
        caseStatus: 'closure_review',
        incidentFlag: true,
        subtype: 'injury_hazard',
        reportabilityStatus: 'filed',
        resolution: resolution({ status: 'externally_completed', approvedType: 'replacement' }),
      }),
    );
    expect(snap.allowedActions).toContain('transition:closed');
    expect(snap.blockingReasons).toHaveLength(0);
  });

  it('terminal states have no case transitions', () => {
    for (const status of ['closed', 'rejected', 'duplicate', 'withdrawn'] as const) {
      const snap = evaluate(state({ caseStatus: status }));
      expect(snap.allowedActions.filter((a) => a.startsWith('transition:'))).toHaveLength(0);
    }
  });
});

describe('CaseWorkflowPolicy — resolution actions', () => {
  it('requested → approve + cancel', () => {
    const snap = evaluate(state({ resolution: resolution({ status: 'requested' }) }));
    expect(snap.allowedActions).toContain('resolution:approve');
    expect(snap.allowedActions).toContain('resolution:cancel');
  });

  it('approved → complete + cancel', () => {
    const snap = evaluate(state({ resolution: resolution({ status: 'approved' }) }));
    expect(snap.allowedActions).toContain('resolution:complete');
    expect(snap.allowedActions).toContain('resolution:cancel');
  });

  it('externally_completed → no resolution actions (no return)', () => {
    const snap = evaluate(state({ resolution: resolution({ status: 'externally_completed' }) }));
    expect(snap.allowedActions.filter((a) => a.startsWith('resolution:'))).toHaveLength(0);
  });

  it('no resolution row → no resolution actions', () => {
    const snap = evaluate(state({ resolution: null }));
    expect(snap.allowedActions.filter((a) => a.startsWith('resolution:'))).toHaveLength(0);
  });
});

describe('CaseWorkflowPolicy — public status (§9.9)', () => {
  it('submitted → received', () => {
    expect(evaluate(state({ caseStatus: 'submitted' })).publicStatus).toBe(
      PUBLIC_STATUSES.RECEIVED,
    );
  });

  it('triage / under_review → in_review', () => {
    expect(evaluate(state({ caseStatus: 'triage' })).publicStatus).toBe(PUBLIC_STATUSES.IN_REVIEW);
    expect(evaluate(state({ caseStatus: 'under_review' })).publicStatus).toBe(
      PUBLIC_STATUSES.IN_REVIEW,
    );
  });

  it('need_info → action_required', () => {
    expect(evaluate(state({ caseStatus: 'need_info' })).publicStatus).toBe(
      PUBLIC_STATUSES.ACTION_REQUIRED,
    );
  });

  it('approved + resolution approved → resolution_approved', () => {
    expect(
      evaluate(state({ caseStatus: 'approved', resolution: resolution({ status: 'approved' }) }))
        .publicStatus,
    ).toBe(PUBLIC_STATUSES.RESOLUTION_APPROVED);
  });

  it('approved + resolution externally_completed → resolution_in_progress', () => {
    expect(
      evaluate(
        state({
          caseStatus: 'approved',
          resolution: resolution({ status: 'externally_completed' }),
        }),
      ).publicStatus,
    ).toBe(PUBLIC_STATUSES.RESOLUTION_IN_PROGRESS);
  });

  it('closed → completed', () => {
    expect(evaluate(state({ caseStatus: 'closed' })).publicStatus).toBe(PUBLIC_STATUSES.COMPLETED);
  });

  it('rejected → not_approved', () => {
    expect(evaluate(state({ caseStatus: 'rejected' })).publicStatus).toBe(
      PUBLIC_STATUSES.NOT_APPROVED,
    );
  });

  it('duplicate / withdrawn → closed', () => {
    expect(evaluate(state({ caseStatus: 'duplicate' })).publicStatus).toBe(PUBLIC_STATUSES.CLOSED);
    expect(evaluate(state({ caseStatus: 'withdrawn' })).publicStatus).toBe(PUBLIC_STATUSES.CLOSED);
  });
});

describe('CaseWorkflowPolicy — purity', () => {
  it('is side-effect free: repeated evaluation is deterministic', () => {
    const s = state({
      caseStatus: 'closure_review',
      incidentFlag: true,
      subtype: 'injury_hazard',
      reportabilityStatus: 'pending',
      resolution: resolution({ status: 'externally_completed' }),
    });
    const first = evaluate(s);
    const second = evaluate(s);
    expect(first).toEqual(second);
  });
});
