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
});
