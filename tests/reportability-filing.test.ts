import { describe, expect, it } from 'vitest';

import { DrizzleAdminService, parseFiledAt } from '../src/modules/admin/drizzle-admin-service.js';
import { NodeSensitiveDataCrypto } from '../src/platform/crypto/node-sensitive-data-crypto.js';
import type { DatabaseExecutor } from '../src/db/client.js';
import { ClaimValidationError } from '../src/shared/errors.js';

// Two distinct keys, because the crypto port refuses a pepper equal to the key.
const crypto = new NodeSensitiveDataCrypto(
  Buffer.alloc(32, 7).toString('base64'),
  Buffer.alloc(32, 9).toString('base64'),
);

const PENDING_REVIEW = { id: '00000000-0000-4000-8000-000000000001', status: 'pending' };

/**
 * The smallest database the close path touches: read one review by id, write one
 * update. Records the update payload so a test can assert what was written — and,
 * just as importantly, that nothing was written when a validation refused.
 */
function makeDb(review: Record<string, unknown> | null) {
  const updates: Record<string, unknown>[] = [];
  const db = {
    select: () => ({
      from: () => ({
        where: () => ({ limit: () => Promise.resolve(review ? [review] : []) }),
      }),
    }),
    update: () => ({
      set: (payload: Record<string, unknown>) => ({
        where: () => {
          updates.push(payload);
          return Promise.resolve();
        },
      }),
    }),
  };
  return { db: db as unknown as DatabaseExecutor, updates };
}

function makeService(review: Record<string, unknown> | null = PENDING_REVIEW) {
  const { db, updates } = makeDb(review);
  const service = new DrizzleAdminService({
    db,
    crypto,
    consumerWebBaseUrl: 'https://example.test',
  });
  return { service, updates };
}

const RATIONALE = 'Filed after completing the Section 15(b) analysis with counsel.';

describe('parseFiledAt', () => {
  it('accepts a date-only value as that UTC day', () => {
    expect(parseFiledAt('2026-09-01').toISOString()).toBe('2026-09-01T00:00:00.000Z');
  });

  it('accepts a timestamp that has already happened', () => {
    const past = new Date(Date.now() - 86_400_000);
    expect(parseFiledAt(past.toISOString()).getTime()).toBe(past.getTime());
  });

  it('allows a date up to 26 hours ahead, for the operator a calendar day ahead', () => {
    const ahead = new Date(Date.now() + 25 * 60 * 60 * 1000);
    expect(parseFiledAt(ahead.toISOString()).getTime()).toBe(ahead.getTime());
  });

  it('refuses an empty value', () => {
    expect(() => parseFiledAt(undefined)).toThrow(ClaimValidationError);
    expect(() => parseFiledAt('   ')).toThrow(/filedAt is required/);
  });

  it('refuses a value that is not a date', () => {
    expect(() => parseFiledAt('last Tuesday')).toThrow(/ISO 8601/);
  });

  it('refuses a date that has not happened yet', () => {
    const future = new Date(Date.now() + 30 * 60 * 60 * 1000);
    expect(() => parseFiledAt(future.toISOString())).toThrow(/cannot be in the future/);
  });
});

describe('closeReportabilityReview filing basis', () => {
  it('records the operator-supplied filing date, not the moment the row was written', async () => {
    const { service, updates } = makeService();

    await service.closeReportabilityReview(PENDING_REVIEW.id, {
      outcome: 'filed',
      reviewerId: '00000000-0000-4000-8000-000000000002',
      rationale: RATIONALE,
      cpscReference: 'CPSC-2026-0001',
      filedAt: '2026-09-01',
      filingEvidence: 'Submission receipt 4QZ-2, acknowledged the same day.',
    });

    expect(updates).toHaveLength(1);
    const written = updates[0]!;
    expect(written.status).toBe('filed');
    // The whole point: the filing date is what the operator said, and it is not
    // `decisionAt`, which is the server clock at record time.
    expect((written.filedAt as Date).toISOString()).toBe('2026-09-01T00:00:00.000Z');
    expect((written.decisionAt as Date).getTime()).toBeGreaterThan(
      (written.filedAt as Date).getTime(),
    );

    const stored = written.filingEvidenceEncrypted as string;
    expect(stored.startsWith('enc.v1.aes-256-gcm.')).toBe(true);
    await expect(crypto.decrypt({ keyVersion: 'v1', value: stored })).resolves.toBe(
      'Submission receipt 4QZ-2, acknowledged the same day.',
    );
  });

  it('refuses a filing with no filing date, and writes nothing', async () => {
    const { service, updates } = makeService();

    await expect(
      service.closeReportabilityReview(PENDING_REVIEW.id, {
        outcome: 'filed',
        reviewerId: '00000000-0000-4000-8000-000000000002',
        rationale: RATIONALE,
        cpscReference: 'CPSC-2026-0001',
        filingEvidence: 'Submission receipt 4QZ-2.',
      }),
    ).rejects.toThrow(/filedAt is required/);
    expect(updates).toHaveLength(0);
  });

  it('refuses a filing with no receipt material, and writes nothing', async () => {
    const { service, updates } = makeService();

    await expect(
      service.closeReportabilityReview(PENDING_REVIEW.id, {
        outcome: 'filed',
        reviewerId: '00000000-0000-4000-8000-000000000002',
        rationale: RATIONALE,
        cpscReference: 'CPSC-2026-0001',
        filedAt: '2026-09-01',
        filingEvidence: 'see file',
      }),
    ).rejects.toThrow(/filingEvidence of at least 10 characters/);
    expect(updates).toHaveLength(0);
  });

  it('refuses a receipt on a review that decided not to file', async () => {
    const { service, updates } = makeService();

    await expect(
      service.closeReportabilityReview(PENDING_REVIEW.id, {
        outcome: 'documented_non_reportable',
        reviewerId: '00000000-0000-4000-8000-000000000002',
        rationale: RATIONALE,
        filingEvidence: 'Submission receipt 4QZ-2.',
      }),
    ).rejects.toThrow(/cannot carry filedAt or filingEvidence/);
    expect(updates).toHaveLength(0);
  });

  it('closes a non-filing decision without any filing fields', async () => {
    const { service, updates } = makeService();

    await service.closeReportabilityReview(PENDING_REVIEW.id, {
      outcome: 'documented_non_reportable',
      reviewerId: '00000000-0000-4000-8000-000000000002',
      rationale: RATIONALE,
    });

    expect(updates).toHaveLength(1);
    expect(updates[0]!.status).toBe('documented_non_reportable');
    expect(updates[0]!.filedAt).toBeUndefined();
    expect(updates[0]!.filingEvidenceEncrypted).toBeUndefined();
  });
});
