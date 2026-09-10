import { describe, expect, it } from 'vitest';

import type { Database } from '../src/db/client.js';
import { DrizzleAdminService } from '../src/modules/admin/drizzle-admin-service.js';
import type { SensitiveDataCryptoPort } from '../src/platform/crypto/port.js';

const cryptoFake: SensitiveDataCryptoPort = {
  encrypt: (plaintext) => Promise.resolve({ keyVersion: 'v1', value: plaintext }),
  decrypt: (ciphertext) => Promise.resolve(ciphertext.value),
  lookupHash: (value) => Promise.resolve(value),
};

const CASE_ID = '11111111-1111-4111-8111-111111111111';
const STAFF_ID = '22222222-2222-4222-8222-222222222222';
const CASE_REFERENCE = 'KOI-7N4Q-A91M2X6P';
const WEB_BASE_URL = 'https://web.example';

/** A case row as the transition path reads it (open case, no incident). */
function openCaseRow(status: string) {
  return {
    id: CASE_ID,
    publicReference: CASE_REFERENCE,
    locale: 'en-US',
    status,
    subtype: 'standard',
    incidentFlag: false,
  };
}

describe('DrizzleAdminService RBAC operations', () => {
  it('appends a case event when a staff user transitions case status', async () => {
    const inserted: Record<string, unknown>[] = [];
    const db = createTransitionFakeDb(inserted);
    const service = new DrizzleAdminService({
      db,
      crypto: cryptoFake,
      consumerWebBaseUrl: WEB_BASE_URL,
    });

    await service.transitionCaseStatus(CASE_REFERENCE, 'triage', STAFF_ID);

    expect(inserted).toEqual([
      {
        caseId: CASE_ID,
        eventType: 'case.status.transitioned',
        actorType: 'staff',
        actorId: STAFF_ID,
        data: { previousStatus: 'submitted', nextStatus: 'triage' },
      },
    ]);
  });

  it('persists the transition note on the case event when provided', async () => {
    const inserted: Record<string, unknown>[] = [];
    const db = createTransitionFakeDb(inserted);
    const service = new DrizzleAdminService({
      db,
      crypto: cryptoFake,
      consumerWebBaseUrl: WEB_BASE_URL,
    });

    await service.transitionCaseStatus(
      CASE_REFERENCE,
      'triage',
      STAFF_ID,
      'Product anomaly suspected — verify lot code.  ',
    );

    expect(inserted[0]?.data).toEqual({
      previousStatus: 'submitted',
      nextStatus: 'triage',
      note: 'Product anomaly suspected — verify lot code.',
    });
  });

  it('rejects a need_info transition without a note of at least 10 characters', async () => {
    const inserted: Record<string, unknown>[] = [];
    const db = createTransitionFakeDb(inserted);
    const service = new DrizzleAdminService({
      db,
      crypto: cryptoFake,
      consumerWebBaseUrl: WEB_BASE_URL,
    });

    await expect(
      service.transitionCaseStatus(CASE_REFERENCE, 'need_info', STAFF_ID),
    ).rejects.toThrow('at least 10 characters');
    await expect(
      service.transitionCaseStatus(CASE_REFERENCE, 'need_info', STAFF_ID, 'short'),
    ).rejects.toThrow('at least 10 characters');
    expect(inserted).toEqual([]);
  });

  it('rejects a reason-bearing decision transition without a consumer-visible reason', async () => {
    const inserted: Record<string, unknown>[] = [];
    const db = createTransitionFakeDb(inserted);
    const service = new DrizzleAdminService({
      db,
      crypto: cryptoFake,
      consumerWebBaseUrl: WEB_BASE_URL,
    });

    await expect(
      service.transitionCaseStatus(CASE_REFERENCE, 'rejected', STAFF_ID, 'too short'),
    ).rejects.toThrow('consumer-visible reason');
    await expect(
      service.transitionCaseStatus(CASE_REFERENCE, 'withdrawn', STAFF_ID),
    ).rejects.toThrow('consumer-visible reason');
    expect(inserted).toEqual([]);
  });

  it('requires the consumer reason even for a forced (bypass-workflow) transition', async () => {
    const inserted: Record<string, unknown>[] = [];
    const db = createTransitionFakeDb(inserted);
    const service = new DrizzleAdminService({
      db,
      crypto: cryptoFake,
      consumerWebBaseUrl: WEB_BASE_URL,
    });

    await expect(
      service.transitionCaseStatus(CASE_REFERENCE, 'rejected', STAFF_ID, undefined, true),
    ).rejects.toThrow('consumer-visible reason');
    expect(inserted).toEqual([]);
  });

  it('requires a closure reason when closing without an externally completed remedy', async () => {
    const inserted: Record<string, unknown>[] = [];
    const db = createTransitionFakeDb(inserted, [
      openCaseRow('approved'),
      undefined,
      { requestedType: 'refund', approvedType: 'refund', status: 'approved' },
    ]);
    const service = new DrizzleAdminService({
      db,
      crypto: cryptoFake,
      consumerWebBaseUrl: WEB_BASE_URL,
    });

    await expect(
      service.transitionCaseStatus(CASE_REFERENCE, 'closed', STAFF_ID, undefined, true),
    ).rejects.toThrow("moving a case to 'closed'");
    expect(inserted).toEqual([]);
  });

  it('enqueues case_closed with the reason for a forced closure without remedy', async () => {
    const { service, triggered } = createEmailCapturingService([
      openCaseRow('approved'),
      undefined,
      { requestedType: 'refund', approvedType: 'refund', status: 'approved' },
    ]);

    await service.transitionCaseStatus(
      CASE_REFERENCE,
      'closed',
      STAFF_ID,
      'Closed without remedy after the consumer went silent.',
      true,
    );

    expect(triggered).toEqual([
      {
        caseId: CASE_ID,
        templateKey: 'case_closed',
        locale: 'en-US',
        variables: {
          caseReference: CASE_REFERENCE,
          closureReason: 'Closed without remedy after the consumer went silent.',
        },
        deduplicationKey: `case-closed:${CASE_ID}:event-1`,
        eventType: 'case.closed.requested',
      },
    ]);
  });

  it('enqueues the need_info email with the action link and an event-scoped dedup key', async () => {
    const { service, triggered } = createEmailCapturingService([openCaseRow('under_review')]);

    await service.transitionCaseStatus(
      CASE_REFERENCE,
      'need_info',
      STAFF_ID,
      'Please send a photo of the lot code.',
    );

    expect(triggered).toEqual([
      {
        caseId: CASE_ID,
        templateKey: 'need_info',
        locale: 'en-US',
        variables: {
          caseReference: CASE_REFERENCE,
          requestedInformation: 'Please send a photo of the lot code.',
          actionUrl: `https://web.example/dashboard/claims/${CASE_REFERENCE}`,
        },
        deduplicationKey: `case-action-required:${CASE_ID}:event-1`,
        eventType: 'case.action_required.requested',
      },
    ]);
  });

  it('enqueues the not-approved email for a duplicate transition', async () => {
    const { service, triggered } = createEmailCapturingService([openCaseRow('submitted')]);

    await service.transitionCaseStatus(
      CASE_REFERENCE,
      'duplicate',
      STAFF_ID,
      'This claim duplicates an earlier submission.',
    );

    expect(triggered).toEqual([
      {
        caseId: CASE_ID,
        templateKey: 'claim_rejected',
        locale: 'en-US',
        variables: {
          caseReference: CASE_REFERENCE,
          reason: 'This claim duplicates an earlier submission.',
        },
        deduplicationKey: `case-not-approved:${CASE_ID}:event-1`,
        eventType: 'case.not_approved.requested',
      },
    ]);
  });

  it('enqueues the closure email when a case is withdrawn', async () => {
    const { service, triggered } = createEmailCapturingService([openCaseRow('under_review')]);

    await service.transitionCaseStatus(
      CASE_REFERENCE,
      'withdrawn',
      STAFF_ID,
      'Withdrawn at the consumer request.',
    );

    expect(triggered).toEqual([
      {
        caseId: CASE_ID,
        templateKey: 'case_closed',
        locale: 'en-US',
        variables: {
          caseReference: CASE_REFERENCE,
          closureReason: 'Withdrawn at the consumer request.',
        },
        deduplicationKey: `case-closed:${CASE_ID}:event-1`,
        eventType: 'case.closed.requested',
      },
    ]);
  });

  it('sends case_completed (not case_closed) when a remedied case closes', async () => {
    const { service, triggered } = createEmailCapturingService([
      openCaseRow('closure_review'),
      undefined,
      { requestedType: 'refund', approvedType: 'refund', status: 'externally_completed' },
    ]);

    await service.transitionCaseStatus(CASE_REFERENCE, 'closed', STAFF_ID);

    expect(triggered).toEqual([
      {
        caseId: CASE_ID,
        templateKey: 'case_completed',
        locale: 'en-US',
        variables: { caseReference: CASE_REFERENCE, completedResolutionLabel: 'Refund' },
        deduplicationKey: `case-completed:${CASE_ID}:event-1`,
        eventType: 'case.completed.requested',
      },
    ]);
  });

  it('sends no email for a noise-control transition (under_review)', async () => {
    const { service, triggered } = createEmailCapturingService([openCaseRow('triage')]);

    await service.transitionCaseStatus(CASE_REFERENCE, 'under_review', STAFF_ID);

    expect(triggered).toEqual([]);
  });
});

/** A service wired to a fake email trigger that captures every enqueue. */
function createEmailCapturingService(selectRows: unknown[]) {
  const inserted: Record<string, unknown>[] = [];
  const triggered: unknown[] = [];
  const emailTrigger = {
    trigger: (_tx: unknown, params: unknown) => {
      triggered.push(params);
      return Promise.resolve();
    },
  };
  const service = new DrizzleAdminService({
    db: createTransitionFakeDb(inserted, selectRows),
    crypto: cryptoFake,
    emailTrigger: emailTrigger as never,
    consumerWebBaseUrl: WEB_BASE_URL,
  });
  return { service, triggered };
}

/**
 * Fake DB serving one canned case row by default, or the given rows in select
 * order (`undefined` skips that select's consumer). The transition path locks
 * the case row and inserts the case event with `.returning`, so the fake
 * models `.for('update')` and `.returning({ id })`.
 */
function createTransitionFakeDb(
  inserted: Record<string, unknown>[],
  selectRows: unknown[] = [],
): Database {
  const fallback = openCaseRow('submitted');
  const nextRow = () => (selectRows.length > 0 ? selectRows.shift() : fallback);
  const resolved = () => Promise.resolve([nextRow()]);
  return {
    select: () => ({
      from: () => ({
        where: () => ({
          for: () => ({ limit: resolved }),
          limit: resolved,
        }),
      }),
    }),
    update: () => ({
      set: () => ({ where: () => Promise.resolve() }),
    }),
    insert: () => ({
      values: (values: Record<string, unknown>) => {
        inserted.push(values);
        return {
          returning: () => Promise.resolve([{ id: 'event-1' }]),
        };
      },
    }),
  } as unknown as Database;
}
