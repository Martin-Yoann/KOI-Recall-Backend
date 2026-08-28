import { describe, expect, it } from 'vitest';

import type { Database } from '../src/db/client.js';
import { DrizzleAdminService } from '../src/modules/admin/drizzle-admin-service.js';
import type { SensitiveDataCryptoPort } from '../src/platform/crypto/port.js';

const cryptoFake: SensitiveDataCryptoPort = {
  encrypt: (plaintext) => Promise.resolve({ keyVersion: 'v1', value: plaintext }),
  decrypt: (ciphertext) => Promise.resolve(ciphertext.value),
  lookupHash: (value) => Promise.resolve(value),
};

describe('DrizzleAdminService RBAC operations', () => {
  it('appends a case event when a staff user transitions case status', async () => {
    const inserted: Record<string, unknown>[] = [];
    const db = {
      select: () => ({
        from: () => ({
          where: () => ({
            limit: () =>
              Promise.resolve([
                { id: '11111111-1111-4111-8111-111111111111', status: 'submitted' },
              ]),
          }),
        }),
      }),
      update: () => ({
        set: () => ({ where: () => Promise.resolve() }),
      }),
      insert: () => ({
        values: (values: Record<string, unknown>) => {
          inserted.push(values);
          return Promise.resolve();
        },
      }),
    } as unknown as Database;
    const service = new DrizzleAdminService(db, cryptoFake);

    await service.transitionCaseStatus(
      'KOI-7N4Q-A91M2X6P',
      'triage',
      '22222222-2222-4222-8222-222222222222',
    );

    expect(inserted).toEqual([
      {
        caseId: '11111111-1111-4111-8111-111111111111',
        eventType: 'case.status.transitioned',
        actorType: 'staff',
        actorId: '22222222-2222-4222-8222-222222222222',
        data: { previousStatus: 'submitted', nextStatus: 'triage' },
      },
    ]);
  });

  it('persists the transition note on the case event when provided', async () => {
    const inserted: Record<string, unknown>[] = [];
    const db = createTransitionFakeDb(inserted);
    const service = new DrizzleAdminService(db, cryptoFake);

    await service.transitionCaseStatus(
      'KOI-7N4Q-A91M2X6P',
      'triage',
      '22222222-2222-4222-8222-222222222222',
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
    const service = new DrizzleAdminService(db, cryptoFake);

    await expect(
      service.transitionCaseStatus(
        'KOI-7N4Q-A91M2X6P',
        'need_info',
        '22222222-2222-4222-8222-222222222222',
      ),
    ).rejects.toThrow('at least 10 characters');
    await expect(
      service.transitionCaseStatus(
        'KOI-7N4Q-A91M2X6P',
        'need_info',
        '22222222-2222-4222-8222-222222222222',
        'short',
      ),
    ).rejects.toThrow('at least 10 characters');
    expect(inserted).toEqual([]);
  });
});

/** A fake DB whose every select resolves like the seed case row used above. */
function createTransitionFakeDb(inserted: Record<string, unknown>[]): Database {
  return {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () =>
            Promise.resolve([
              { id: '11111111-1111-4111-8111-111111111111', status: 'submitted' },
            ]),
        }),
      }),
    }),
    update: () => ({
      set: () => ({ where: () => Promise.resolve() }),
    }),
    insert: () => ({
      values: (values: Record<string, unknown>) => {
        inserted.push(values);
        return Promise.resolve();
      },
    }),
  } as unknown as Database;
}
