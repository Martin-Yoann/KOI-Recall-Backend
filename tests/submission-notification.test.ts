import { describe, expect, it } from 'vitest';

import { claimConfirmationVariables } from '../src/modules/cases/submission-notification.js';

const BASE = {
  caseReference: 'KOI-7N4Q-A91M2X6P',
  submittedAt: new Date('2026-09-01T12:00:00.000Z'),
  campaignSlug: 'music-lollipop-demo-2026',
  consumerWebBaseUrl: 'https://example.test',
};

describe('claimConfirmationVariables', () => {
  it('puts the token in the fragment, so it never reaches a server log', () => {
    const variables = claimConfirmationVariables({
      ...BASE,
      disposal: { taskId: 'task-1', token: 'secret-token' },
    });

    expect(variables.disposalResumeUrl).toBe(
      'https://example.test/recalls/music-lollipop-demo-2026/disposal/task-1#token=secret-token',
    );
    // Everything after the `#` stays in the browser; a query parameter would be written
    // into the access log of whichever server the consumer's click lands on.
    expect(variables.disposalResumeUrl.split('#')[1]).toBe('token=secret-token');
  });

  it('says no disposal step applies rather than leaving a link empty', () => {
    const variables = claimConfirmationVariables({ ...BASE, disposal: null });

    expect(variables.disposalResumeUrl).toBe('');
    expect(variables.disposalSection).toBe('No product-disposal step applies to this claim.');
    // A template that used this variable in an href would otherwise emit `href=""`.
    expect(variables.disposalSection).not.toContain('http');
  });

  it('treats a missing disposal service as no disposal step', () => {
    // `this.disposal?.createTaskForSubmission(...)` yields undefined when the service is
    // not configured, and the consumer must read the same sentence either way.
    expect(claimConfirmationVariables({ ...BASE, disposal: undefined }).disposalSection).toBe(
      'No product-disposal step applies to this claim.',
    );
  });

  it('carries the whole sentence when there is a step, because the renderer cannot branch', () => {
    const variables = claimConfirmationVariables({
      ...BASE,
      disposal: { taskId: 'task-1', token: 'secret-token' },
    });

    expect(variables.disposalSection).toContain(variables.disposalResumeUrl);
    expect(variables.disposalSection).toContain('the only way back to it');
    expect(variables.disposalSection).not.toContain('No product-disposal step');
  });

  it('returns the same keys in both branches', () => {
    // The renderer refuses to send when a placeholder is unresolved, so the two branches
    // must not differ in shape — only in wording.
    const keys = (disposal: { taskId: string; token: string } | null) =>
      Object.keys(claimConfirmationVariables({ ...BASE, disposal })).sort();

    expect(keys({ taskId: 'task-1', token: 'secret-token' })).toEqual(keys(null));
    expect(keys(null)).toEqual([
      'caseReference',
      'disposalResumeUrl',
      'disposalSection',
      'submittedAt',
    ]);
  });

  it('passes the reference and the timestamp through unchanged', () => {
    const variables = claimConfirmationVariables({ ...BASE, disposal: null });
    expect(variables.caseReference).toBe(BASE.caseReference);
    expect(variables.submittedAt).toBe('2026-09-01T12:00:00.000Z');
  });
});
