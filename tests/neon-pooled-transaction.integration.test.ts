// Dedicated opt-in smoke for a real pooled Neon transaction path.
// Normal test runs never construct a Neon client or perform network I/O.
import 'dotenv/config';

import { sql } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';

import { createDatabase, detectDriver, type DatabaseHandle } from '../src/db/client.js';

const databaseUrl = process.env.NEON_POOLED_TEST_DATABASE_URL;
const enabled =
  process.env.RUN_NEON_POOL_INTEGRATION === 'true' &&
  typeof databaseUrl === 'string' &&
  databaseUrl.length > 0;
const handle: DatabaseHandle | null = enabled ? createDatabase(databaseUrl) : null;

describe.skipIf(!enabled)('pooled Neon transaction smoke', () => {
  afterAll(async () => {
    await handle?.close();
  });

  it('executes real BEGIN/commit and rollback paths', async () => {
    expect(detectDriver(databaseUrl!)).toBe('neon-serverless');
    expect(handle!.driver).toBe('neon-serverless');

    await expect(
      handle!.transaction(async (tx) => {
        await tx.execute(sql`select 1 as committed`);
        return 'committed';
      }),
    ).resolves.toBe('committed');

    const rollbackSentinel = new Error('neon rollback sentinel');
    await expect(
      handle!.transaction(async (tx) => {
        await tx.execute(sql`select 1 as rolled_back`);
        throw rollbackSentinel;
      }),
    ).rejects.toBe(rollbackSentinel);
  });
});
