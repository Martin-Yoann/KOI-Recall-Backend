import { describe, expect, it } from 'vitest';

import type { DatabaseExecutor } from '../src/db/client.js';
import { DrizzleStaffService } from '../src/modules/staff/drizzle-staff-service.js';
import { hashPassword } from '../src/modules/staff/password.js';
import type { SensitiveDataCryptoPort } from '../src/platform/crypto/port.js';

const cryptoFake: SensitiveDataCryptoPort = {
  encrypt: (plaintext) => Promise.resolve({ keyVersion: 'v1', value: plaintext }),
  decrypt: (ciphertext) => Promise.resolve(ciphertext.value),
  lookupHash: (value) => Promise.resolve(`hash:${value}`),
};

describe('DrizzleStaffService session security', () => {
  it('preserves the original hard expiry when rotating a session token', async () => {
    const originalIssuedAt = new Date('2026-08-01T00:00:00.000Z');
    const originalExpiresAt = new Date('2099-08-08T00:00:00.000Z');
    let updateValues: Record<string, unknown> | undefined;
    const db = {
      select: () => ({
        from: () => ({
          where: () => ({
            limit: () =>
              Promise.resolve([
                {
                  id: '11111111-1111-4111-8111-111111111111',
                  status: 'active',
                  issuedAt: originalIssuedAt,
                  expiresAt: originalExpiresAt,
                },
              ]),
          }),
        }),
      }),
      update: () => ({
        set: (values: Record<string, unknown>) => ({
          where: () => {
            updateValues = values;
            return Promise.resolve();
          },
        }),
      }),
    } as unknown as DatabaseExecutor;
    const service = new DrizzleStaffService(db, cryptoFake);

    const refreshed = await service.refreshSession('11111111-1111-4111-8111-111111111111');

    expect(refreshed?.expiresAt).toBe(originalExpiresAt.toISOString());
    expect(updateValues).not.toHaveProperty('issuedAt');
    expect(updateValues?.expiresAt).toEqual(originalExpiresAt);
  });

  it('locks an account after five consecutive bad passwords', async () => {
    const passwordHash = await hashPassword('correct-password');
    const user = {
      id: '22222222-2222-4222-8222-222222222222',
      emailLookupHash: 'hash:staff@example.com',
      email: 'staff@example.com',
      displayName: 'Staff',
      role: 'reviewer',
      status: 'active',
      passwordHash,
      failedLoginAttempts: 0,
      lockedUntil: null as Date | null,
    };
    const db = {
      select: () => ({
        from: () => ({
          where: () => ({ limit: () => Promise.resolve([user]) }),
        }),
      }),
      update: () => ({
        set: (values: Partial<typeof user>) => ({
          where: () => {
            Object.assign(user, values);
            return Promise.resolve();
          },
        }),
      }),
    } as unknown as DatabaseExecutor;
    const service = new DrizzleStaffService(db, cryptoFake);

    for (let attempt = 0; attempt < 5; attempt += 1) {
      await expect(service.login('staff@example.com', 'wrong-password')).resolves.toBeNull();
    }

    expect(user.failedLoginAttempts).toBe(5);
    expect(user.lockedUntil?.getTime()).toBeGreaterThan(Date.now());
  });
});
