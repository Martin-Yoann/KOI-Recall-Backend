import { describe, expect, it } from 'vitest';

import {
  disposalTaskViewSchema,
  recordDisposalDeclarationRequestSchema,
} from '../src/contracts/disposal.js';
import { DISPOSAL_BLOCKING_REASONS } from '../src/modules/disposal/policy.js';

const taskView = {
  taskId: '21326c9a-5dc2-430f-98a6-546729a1065f',
  status: 'open' as const,
  eligibilityStatus: 'confirmed_eligible' as const,
  allowedActions: ['disposal.submit_evidence'],
  blockingReasons: [],
  evidenceReviewStatus: null,
  authorizationStatus: null,
  holdActive: false,
  version: 1,
  products: [],
  instruction: null,
  expiresAt: '2026-09-21T00:00:00.000Z',
};

describe('DisposalTaskView contract', () => {
  /**
   * The red line: "API 为处置许可唯一来源；客户端不自行推导 canDispose". A client
   * that could read a permission-shaped boolean would be a client that could
   * derive permission locally, which is exactly the failure this domain exists
   * to prevent. The server expresses what may happen as `allowedActions`, and
   * what is blocked as `blockingReasons` — never as a decided boolean.
   *
   * Pinned as an exact field set rather than a name pattern: a pattern either
   * misses an inventive name or, as `allowedActions` shows, flags the one field
   * that is the approved mechanism. Any new field has to be added here
   * deliberately.
   */
  it('exposes exactly the agreed fields, and no decided permission', () => {
    expect(Object.keys(disposalTaskViewSchema.shape).sort()).toEqual([
      'allowedActions',
      'authorizationStatus',
      'blockingReasons',
      'eligibilityStatus',
      'evidenceReviewStatus',
      'expiresAt',
      'holdActive',
      'instruction',
      'products',
      'status',
      'taskId',
      'version',
    ]);
  });

  /**
   * `holdActive` is the only boolean, and it states a fact (a hold is in force)
   * rather than a decision. A second boolean arriving with a permission-sounding
   * name is the shape this test exists to stop.
   */
  it('has no boolean field that reads as a permission', () => {
    const booleans = Object.entries(disposalTaskViewSchema.shape)
      .filter(([, schema]) => schema.safeParse(true).success && schema.safeParse(false).success)
      .map(([key]) => key);
    expect(booleans).toEqual(['holdActive']);
    for (const name of booleans) {
      expect(name).not.toMatch(/can|may|permit|allow|authoriz/i);
    }
  });

  it('expresses permission only through server-issued action ids', () => {
    const parsed = disposalTaskViewSchema.parse({
      ...taskView,
      allowedActions: ['disposal.submit_evidence', 'disposal.hold.place'],
    });
    expect(parsed.allowedActions).toEqual(['disposal.submit_evidence', 'disposal.hold.place']);
  });

  /**
   * The four facts stay separable in the payload: an accepted photo review and an
   * active authorization are different fields, so a client cannot collapse them.
   */
  it('keeps review status, authorization status and holds as distinct fields', () => {
    const parsed = disposalTaskViewSchema.parse({
      ...taskView,
      evidenceReviewStatus: 'accepted',
      authorizationStatus: 'suspended',
      holdActive: true,
      blockingReasons: [DISPOSAL_BLOCKING_REASONS.DISPOSAL_ON_HOLD],
    });
    expect(parsed.evidenceReviewStatus).toBe('accepted');
    expect(parsed.authorizationStatus).toBe('suspended');
    expect(parsed.holdActive).toBe(true);
    // Accepted evidence plus a hold is not permission, and the payload says so.
    expect(parsed.blockingReasons).toContain(DISPOSAL_BLOCKING_REASONS.DISPOSAL_ON_HOLD);
  });
});

describe('disposal declaration contract', () => {
  it('accepts a declaration that cites an authorization', () => {
    expect(
      recordDisposalDeclarationRequestSchema.safeParse({
        declarationTextVersion: 'v1',
        authorizationId: '21326c9a-5dc2-430f-98a6-546729a1065f',
      }).success,
    ).toBe(true);
  });

  it('accepts a truthful exception with an explanation', () => {
    expect(
      recordDisposalDeclarationRequestSchema.safeParse({
        declarationTextVersion: 'v1',
        exceptionType: 'already_disposed_before_authorization',
        exceptionNote: 'Already discarded before the recall notice arrived.',
      }).success,
    ).toBe(true);
  });

  // The service and the database CHECK both reject this; the shape simply has to
  // remain capable of expressing it so the rejection carries a clear message.
  it('can express a declaration with neither basis, so the service can refuse it clearly', () => {
    const result = recordDisposalDeclarationRequestSchema.safeParse({
      declarationTextVersion: 'v1',
    });
    expect(result.success).toBe(true);
  });
});
