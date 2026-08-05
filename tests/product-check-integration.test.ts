// Opt-in integration test for the real database read path.
// Runs only when RUN_DB_INTEGRATION=true AND DATABASE_URL is set, e.g. locally:
//   RUN_DB_INTEGRATION=true pnpm test
// dotenv loads .env so the local DATABASE_URL is available. CI never sets the
// flag, so this suite is skipped there. Seed the demo campaign first:
//   APP_ENV=local ALLOW_SYNTHETIC_SEED=true pnpm db:seed
import 'dotenv/config';

import { afterAll, describe, expect, it } from 'vitest';

import { createDatabase, type DatabaseHandle } from '../src/db/client.js';
import { DrizzleProductCheckService } from '../src/modules/product-checks/drizzle-product-check-service.js';

const enabled = process.env.RUN_DB_INTEGRATION === 'true' && Boolean(process.env.DATABASE_URL);

const handle: DatabaseHandle | null = enabled
  ? createDatabase(process.env.DATABASE_URL as string)
  : null;

describe.skipIf(!enabled)('DrizzleProductCheckService (database integration)', () => {
  afterAll(async () => {
    await handle?.pool?.end();
  });

  it('flags an affected product as a potential match against the seeded version', async () => {
    const service = new DrizzleProductCheckService(handle!.db);
    const result = await service.check({
      campaignSlug: 'music-lollipop-demo-2026',
      shape: 'Bear',
      flavor: 'Peach',
      lotCode: 'ML-2406-A',
      dateCode: '06/2024',
    });

    expect(result).not.toBeNull();
    expect(result!.result).toBe('potential_match');
    expect(result!.checkedCampaignVersion).toBe(1);
  });

  it('matches case-insensitively', async () => {
    const service = new DrizzleProductCheckService(handle!.db);
    const result = await service.check({
      campaignSlug: 'music-lollipop-demo-2026',
      shape: 'bear',
      flavor: 'PEACH',
      lotCode: 'ml-2406-a',
      dateCode: '06/2024',
    });

    expect(result).not.toBeNull();
    expect(result!.result).toBe('potential_match');
  });

  it('does not match an unknown lot/date code', async () => {
    const service = new DrizzleProductCheckService(handle!.db);
    const result = await service.check({
      campaignSlug: 'music-lollipop-demo-2026',
      shape: 'Bear',
      flavor: 'Peach',
      lotCode: 'UNKNOWN-LOT',
      dateCode: '01/1999',
    });

    expect(result).not.toBeNull();
    expect(result!.result).toBe('not_matched');
    expect(result!.checkedCampaignVersion).toBe(1);
  });

  it('returns null for an unknown campaign slug', async () => {
    const service = new DrizzleProductCheckService(handle!.db);
    const result = await service.check({
      campaignSlug: 'no-such-campaign',
      shape: 'Bear',
      flavor: 'Peach',
      lotCode: 'ML-2406-A',
      dateCode: '06/2024',
    });
    expect(result).toBeNull();
  });
});
