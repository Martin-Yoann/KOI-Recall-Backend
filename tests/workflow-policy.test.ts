import { describe, expect, it } from 'vitest';

import {
  evaluate,
  BLOCKING_REASONS,
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

  it('maps submitted with pending incident → compliance_review / compliance (A02)', () => {
    // A clean "yes" submission lands at `submitted`, so the review must outrank
    // intake here too — otherwise the case waits for customer service to move it
    // before compliance can see it.
    const snap = evaluate(
      state({
        caseStatus: 'submitted',
        incidentFlag: true,
        subtype: 'injury_hazard',
        reportabilityStatus: 'pending',
      }),
    );
    expect(snap.currentStage).toBe('compliance_review');
    expect(snap.responsibleDepartment).toBe('compliance');
  });

  it('maps submitted with a decided incident back to intake_review', () => {
    // Once the review is no longer pending the case returns to the ordinary
    // intake queue; the override tracks the review, not the incident flag.
    const snap = evaluate(
      state({
        caseStatus: 'submitted',
        incidentFlag: true,
        subtype: 'injury_hazard',
        reportabilityStatus: 'filed',
      }),
    );
    expect(snap.currentStage).toBe('intake_review');
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

  it('approved replacement → ship is offered; approved refund is not', () => {
    const replacement = evaluate(
      state({ resolution: resolution({ status: 'approved', approvedType: 'replacement' }) }),
    );
    expect(replacement.allowedActions).toContain('resolution:ship');

    const refund = evaluate(
      state({ resolution: resolution({ status: 'approved', approvedType: 'refund' }) }),
    );
    expect(refund.allowedActions).not.toContain('resolution:ship');
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
  // These assertions used to name a local vocabulary constant. They now state the strings
  // the consumer API returns, because the snapshot reports that mapping instead of keeping
  // a second copy of it — see `publicStatus` in the module.
  it('submitted → received', () => {
    expect(evaluate(state({ caseStatus: 'submitted' })).publicStatus).toBe('received');
  });

  it('triage / under_review → in_review', () => {
    expect(evaluate(state({ caseStatus: 'triage' })).publicStatus).toBe('in_review');
    expect(evaluate(state({ caseStatus: 'under_review' })).publicStatus).toBe('in_review');
  });

  it('need_info → action_required', () => {
    expect(evaluate(state({ caseStatus: 'need_info' })).publicStatus).toBe('action_required');
  });

  it('approved + resolution approved → resolution_approved', () => {
    expect(
      evaluate(state({ caseStatus: 'approved', resolution: resolution({ status: 'approved' }) }))
        .publicStatus,
    ).toBe('resolution_approved');
  });

  it('approved + resolution externally_completed → resolution_in_progress', () => {
    // The gap recorded in docs/open-items.md is closed: a completed remedy is reported as
    // in progress rather than as awaiting a decision, which is what consumers were being
    // told until an operator moved the case on.
    expect(
      evaluate(
        state({
          caseStatus: 'approved',
          resolution: resolution({ status: 'externally_completed' }),
        }),
      ).publicStatus,
    ).toBe('resolution_in_progress');
  });

  it('closes without a remedy as a neutral closure, not as completed', () => {
    // The snapshot used to call every closed case `completed`. A case closed with nothing
    // approved is not a completed remedy, and the consumer API has always said `closed` —
    // so the same case read differently to the operator and to the consumer.
    expect(evaluate(state({ caseStatus: 'closed' })).publicStatus).toBe('closed');
    expect(
      evaluate(
        state({
          caseStatus: 'closed',
          resolution: resolution({ status: 'approved', approvedType: 'refund' }),
        }),
      ).publicStatus,
    ).toBe('completed');
  });

  it('tells a duplicate apart from a withdrawal', () => {
    // Both read `closed` in the snapshot, while the consumer was told `not_approved` for the
    // duplicate — the distinction an operator most needs to read correctly.
    expect(evaluate(state({ caseStatus: 'rejected' })).publicStatus).toBe('not_approved');
    expect(evaluate(state({ caseStatus: 'duplicate' })).publicStatus).toBe('not_approved');
    expect(evaluate(state({ caseStatus: 'withdrawn' })).publicStatus).toBe('closed');
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

describe('CaseWorkflowPolicy — escalation is a second axis, not a rival status', () => {
  // The rule these four cases encode: `status` is the pipeline, and the compliance
  // override is a *second* axis derived from the incident. So a case does not have to
  // choose between "the product is unverified" and "this is with compliance" — and an
  // escalated case is never finished merely because its review is not pending.

  it('puts an unsure injury submission with compliance while it stays triage for the product', () => {
    const snap = evaluate(
      state({
        caseStatus: 'triage',
        subtype: 'injury_hazard',
        incidentFlag: true,
        reportabilityStatus: 'pending',
      }),
    );
    expect(snap.currentStage).toBe('compliance_review');
    expect(snap.responsibleDepartment).toBe('compliance');
  });

  it('puts an escalated case with a pending review with compliance', () => {
    const snap = evaluate(
      state({
        caseStatus: 'escalated',
        subtype: 'injury_hazard',
        incidentFlag: true,
        reportabilityStatus: 'pending',
      }),
    );
    expect(snap.currentStage).toBe('compliance_review');
    expect(snap.responsibleDepartment).toBe('compliance');
  });

  it('treats an escalated case whose review is closed as submitted, not as finished', () => {
    // The defect this pins: `escalated` used to reach the tail of the stage table, so
    // a case that was still being worked read as `final` — nothing left to do.
    const snap = evaluate(
      state({
        caseStatus: 'escalated',
        subtype: 'injury_hazard',
        incidentFlag: true,
        reportabilityStatus: 'documented_non_reportable',
      }),
    );
    expect(snap.currentStage).toBe('intake_review');
    expect(snap.responsibleDepartment).toBe('customer_service');
  });

  it('still reports the terminal statuses as final', () => {
    for (const caseStatus of ['rejected', 'duplicate', 'withdrawn'] as const) {
      expect(evaluate(state({ caseStatus })).currentStage).toBe('final');
    }
  });
});
