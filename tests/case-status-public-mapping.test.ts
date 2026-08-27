import { describe, expect, it } from 'vitest';

import { recallCaseStatusEnum } from '../src/db/schema/index.js';
import {
  CONSUMER_NEXT_ACTIONS,
  PUBLIC_CASE_STATUSES,
  PUBLIC_CASE_STATUS_LABELS,
} from '../src/contracts/toc.js';
import {
  mapToPublicCaseState,
  publicStatusLabel,
  consumerNextAction,
  type PublicResolutionInput,
} from '../src/modules/cases/public-status.js';

const NO_RESOLUTION: PublicResolutionInput = {
  status: null,
  requestedType: null,
  approvedType: null,
};

describe('mapToPublicCaseState', () => {
  it('covers every internal case status — no orphan states', () => {
    const mapped = new Set(
      recallCaseStatusEnum.enumValues.map(
        (status) => mapToPublicCaseState(status, NO_RESOLUTION).publicStatus,
      ),
    );
    for (const status of mapped) expect(PUBLIC_CASE_STATUSES).toContain(status);
  });

  it('maps the early lifecycle onto received / in_review / action_required', () => {
    expect(mapToPublicCaseState('submitted', NO_RESOLUTION).publicStatus).toBe('received');
    expect(mapToPublicCaseState('triage', NO_RESOLUTION).publicStatus).toBe('in_review');
    expect(mapToPublicCaseState('under_review', NO_RESOLUTION).publicStatus).toBe('in_review');
    expect(mapToPublicCaseState('need_info', NO_RESOLUTION).publicStatus).toBe('action_required');
  });

  it('maps approvals and closure review onto resolution progress', () => {
    const approved = {
      ...NO_RESOLUTION,
      status: 'approved' as const,
      approvedType: 'refund' as const,
    };
    expect(mapToPublicCaseState('approved', approved)).toEqual({
      publicStatus: 'resolution_approved',
      approvedVisible: true,
    });
    expect(mapToPublicCaseState('closure_review', approved)).toEqual({
      publicStatus: 'resolution_in_progress',
      approvedVisible: true,
    });
  });

  it('keeps negative outcomes sticky and non-positive across resolutions', () => {
    for (const status of ['rejected', 'duplicate'] as const) {
      expect(
        mapToPublicCaseState(status, {
          status: 'requested',
          requestedType: 'refund',
          approvedType: null,
        }),
      ).toEqual({
        publicStatus: 'not_approved',
        approvedVisible: false,
      });
    }
    expect(mapToPublicCaseState('withdrawn', NO_RESOLUTION).publicStatus).toBe('closed');
    // A completed external refund cannot resurrect a withdrawn claim's status.
    expect(
      mapToPublicCaseState('withdrawn', {
        status: 'externally_completed',
        requestedType: null,
        approvedType: null,
      }).publicStatus,
    ).toBe('closed');
  });

  it('decides closed cases by what preceded closure', () => {
    // Approval completeness for externally_completed is guaranteed by the
    // case_resolutions_approval_chk database constraint.
    const externallyCompleted = {
      status: 'externally_completed' as const,
      requestedType: null,
      approvedType: 'refund' as const,
    };
    expect(mapToPublicCaseState('closed', externallyCompleted)).toEqual({
      publicStatus: 'completed',
      approvedVisible: true,
    });

    const approvedEarlier = {
      status: 'approved' as const,
      requestedType: 'replacement' as const,
      approvedType: 'replacement' as const,
    };
    expect(mapToPublicCaseState('closed', approvedEarlier)).toEqual({
      publicStatus: 'completed',
      approvedVisible: true,
    });

    expect(mapToPublicCaseState('closed', NO_RESOLUTION)).toEqual({
      publicStatus: 'closed',
      approvedVisible: false,
    });
  });

  it('hides the approval until the lifecycle surfaces it to the consumer', () => {
    // Approved resolution exists but triage is still moving: not visible yet.
    expect(
      mapToPublicCaseState('under_review', {
        status: 'approved',
        requestedType: null,
        approvedType: 'refund',
      }),
    ).toEqual({ publicStatus: 'in_review', approvedVisible: false });
    // A non-null request alone never becomes an approval.
    expect(
      mapToPublicCaseState('closure_review', {
        status: 'requested',
        requestedType: 'refund',
        approvedType: null,
      }),
    ).toEqual({ publicStatus: 'resolution_in_progress', approvedVisible: false });
  });
});

describe('public display copy', () => {
  it('has label and next-action copy for every public status', () => {
    expect(Object.keys(PUBLIC_CASE_STATUS_LABELS).sort()).toEqual([...PUBLIC_CASE_STATUSES].sort());
    expect(Object.keys(CONSUMER_NEXT_ACTIONS).sort()).toEqual([...PUBLIC_CASE_STATUSES].sort());
    for (const status of PUBLIC_CASE_STATUSES) {
      expect(publicStatusLabel(status).length).toBeGreaterThan(0);
      expect(consumerNextAction(status).length).toBeGreaterThan(0);
    }
  });
});
