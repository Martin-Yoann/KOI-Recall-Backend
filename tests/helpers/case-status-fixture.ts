import type { CaseStatusLookupResponse } from '../../src/contracts/toc.js';

/**
 * A canonical whitelisted lookup view shared by mapping and route tests. The
 * approved-resolution fact starts hidden (null), mirroring an in-review case.
 */
export function cannedLookupView(
  overrides: Partial<CaseStatusLookupResponse> = {},
): CaseStatusLookupResponse {
  return {
    caseReference: 'KOI-B2C4-D6E8F0A1',
    campaignTitle: 'Music Lollipop Recall',
    publicStatus: 'in_review',
    publicStatusLabel: 'Under review',
    consumerNextAction: 'Your claim is under review. No action is needed right now.',
    requestedResolution: 'Replacement',
    approvedResolution: null,
    lastUpdatedAt: '2026-08-20T09:30:00.000Z',
    ...overrides,
  };
}
