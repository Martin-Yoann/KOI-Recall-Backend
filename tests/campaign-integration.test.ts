// Opt-in integration test for the real database read path.
// Runs only when RUN_DB_INTEGRATION=true AND DATABASE_URL is set, e.g. locally:
//   RUN_DB_INTEGRATION=true pnpm test
// dotenv loads .env so the local DATABASE_URL is available. CI never sets the
// flag, so this suite is skipped there.
import 'dotenv/config';

import { afterAll, describe, expect, it } from 'vitest';

import { createDatabase, type DatabaseHandle } from '../src/db/client.js';
import { DrizzleCampaignService } from '../src/modules/campaigns/drizzle-campaign-service.js';

const enabled = process.env.RUN_DB_INTEGRATION === 'true' && Boolean(process.env.DATABASE_URL);

const handle: DatabaseHandle | null = enabled
  ? createDatabase(process.env.DATABASE_URL as string)
  : null;

describe.skipIf(!enabled)('DrizzleCampaignService (database integration)', () => {
  afterAll(async () => {
    await handle?.close();
  });

  it('returns the seeded published campaign with products and evidence rules', async () => {
    const service = new DrizzleCampaignService(handle!);
    const campaign = await service.getPublishedCampaign({
      slug: 'music-lollipop-demo-2026',
      locale: 'en-US',
    });

    expect(campaign).not.toBeNull();
    expect(campaign!.slug).toBe('music-lollipop-demo-2026');
    expect(campaign!.code).toBe('ML-DEMO-2026');
    expect(campaign!.version).toBe(1);
    expect(campaign!.title).toBe('Music Lollipop Safety Recall');
    expect(campaign!.products[0]!.affectedLots.length).toBeGreaterThan(0);
    expect(campaign!.evidenceRequirements.map((e) => e.category)).toEqual(
      expect.arrayContaining(['product_photo', 'proof_of_purchase']),
    );
  });

  it('returns null for an unknown slug', async () => {
    const service = new DrizzleCampaignService(handle!);
    const campaign = await service.getPublishedCampaign({
      slug: 'no-such-campaign',
      locale: 'en-US',
    });
    expect(campaign).toBeNull();
  });
});
