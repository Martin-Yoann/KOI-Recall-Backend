import { describe, expect, it } from 'vitest';

import { generateDraftToken, hashDraftToken } from '../src/modules/claim-drafts/tokens.js';

describe('claim draft token helpers', () => {
  it('produces a token long enough for the contract', () => {
    const token = generateDraftToken();

    expect(token.length).toBeGreaterThanOrEqual(32);
    // base64url alphabet only: letters, digits, '-', and '_'.
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('produces a fresh token on each call', () => {
    expect(generateDraftToken()).not.toBe(generateDraftToken());
  });

  it('hashes a token to a 64-character lowercase hex digest', () => {
    const digest = hashDraftToken('one-time-secret-with-at-least-32-characters');

    expect(digest).toMatch(/^[a-f0-9]{64}$/);
  });

  it('hashes the same input deterministically', () => {
    const token = generateDraftToken();

    expect(hashDraftToken(token)).toBe(hashDraftToken(token));
  });

  it('produces different digests for different tokens', () => {
    expect(hashDraftToken(generateDraftToken())).not.toBe(hashDraftToken(generateDraftToken()));
  });
});
