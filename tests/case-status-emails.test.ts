import { describe, expect, it } from 'vitest';

import { resolveCaseStatusEmail } from '../src/modules/communications/case-status-emails.js';

const BASE_CONTEXT = {
  caseId: 'case-1',
  caseReference: 'KOI-1234-ABCD',
  eventId: 'event-9',
  consumerWebBaseUrl: 'https://web.example',
};

describe('resolveCaseStatusEmail', () => {
  it('maps need_info to the action-required email with the secure claim link', () => {
    const email = resolveCaseStatusEmail('need_info', {
      ...BASE_CONTEXT,
      note: '  Please send a photo of the lot code.  ',
      resolutionStatus: null,
      approvedType: null,
    });

    expect(email).toEqual({
      templateKey: 'need_info',
      variables: {
        caseReference: 'KOI-1234-ABCD',
        requestedInformation: 'Please send a photo of the lot code.',
        actionUrl: 'https://web.example/dashboard/claims/KOI-1234-ABCD',
      },
      deduplicationKey: 'case-action-required:case-1:event-9',
      eventType: 'case.action_required.requested',
    });
  });

  it('maps rejected and duplicate to the not-approved email', () => {
    for (const status of ['rejected', 'duplicate']) {
      const email = resolveCaseStatusEmail(status, {
        ...BASE_CONTEXT,
        note: 'The product was outside the recalled lot range.',
        resolutionStatus: null,
        approvedType: null,
      });
      expect(email).toEqual({
        templateKey: 'claim_rejected',
        variables: {
          caseReference: 'KOI-1234-ABCD',
          reason: 'The product was outside the recalled lot range.',
        },
        deduplicationKey: 'case-not-approved:case-1:event-9',
        eventType: 'case.not_approved.requested',
      });
    }
  });

  it('maps closed-after-remedy to case_completed with the resolution label', () => {
    const email = resolveCaseStatusEmail('closed', {
      ...BASE_CONTEXT,
      resolutionStatus: 'externally_completed',
      approvedType: 'replacement',
    });

    expect(email).toEqual({
      templateKey: 'case_completed',
      variables: {
        caseReference: 'KOI-1234-ABCD',
        completedResolutionLabel: 'Replacement',
      },
      deduplicationKey: 'case-completed:case-1:event-9',
      eventType: 'case.completed.requested',
    });
  });

  it('maps withdrawn to case_closed with the closure reason', () => {
    const email = resolveCaseStatusEmail('withdrawn', {
      ...BASE_CONTEXT,
      note: 'Withdrawn at the consumer request.',
      resolutionStatus: null,
      approvedType: null,
    });

    expect(email).toEqual({
      templateKey: 'case_closed',
      variables: {
        caseReference: 'KOI-1234-ABCD',
        closureReason: 'Withdrawn at the consumer request.',
      },
      deduplicationKey: 'case-closed:case-1:event-9',
      eventType: 'case.closed.requested',
    });
  });

  it('falls back to case_closed when a force-closed case has no completed remedy', () => {
    const email = resolveCaseStatusEmail('closed', {
      ...BASE_CONTEXT,
      note: 'Closed by an administrator after an out-of-band agreement.',
      resolutionStatus: 'approved',
      approvedType: 'refund',
    });

    expect(email?.templateKey).toBe('case_closed');
  });

  it('never generates a reason-bearing email without a reason', () => {
    for (const status of ['need_info', 'rejected', 'duplicate', 'withdrawn', 'closed']) {
      expect(
        resolveCaseStatusEmail(status, {
          ...BASE_CONTEXT,
          resolutionStatus: null,
          approvedType: null,
        }),
      ).toBeNull();
      expect(
        resolveCaseStatusEmail(status, {
          ...BASE_CONTEXT,
          note: '   ',
          resolutionStatus: null,
          approvedType: null,
        }),
      ).toBeNull();
    }
  });

  it('produces no email for noise-control statuses', () => {
    for (const status of ['submitted', 'triage', 'under_review', 'approved', 'closure_review']) {
      expect(
        resolveCaseStatusEmail(status, {
          ...BASE_CONTEXT,
          note: 'internal note',
          resolutionStatus: 'approved',
          approvedType: 'replacement',
        }),
      ).toBeNull();
    }
  });
});
