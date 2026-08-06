// Opt-in integration test for the real database write path.
// Runs only when RUN_DB_INTEGRATION=true AND DATABASE_URL is set, e.g. locally:
//   RUN_DB_INTEGRATION=true pnpm test
// dotenv loads .env so the local DATABASE_URL is available. CI never sets the
// flag, so this suite is skipped there. Seed the demo campaign first:
//   APP_ENV=local ALLOW_SYNTHETIC_SEED=true pnpm db:seed
import 'dotenv/config';

import { eq } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';

import { createDatabase, type DatabaseHandle } from '../src/db/client.js';
import { DrizzleClaimDraftService } from '../src/modules/claim-drafts/drizzle-claim-draft-service.js';
import { hashDraftToken } from '../src/modules/claim-drafts/tokens.js';
import { claimDrafts } from '../src/db/schema/index.js';

const enabled = process.env.RUN_DB_INTEGRATION === 'true' && Boolean(process.env.DATABASE_URL);

const handle: DatabaseHandle | null = enabled
  ? createDatabase(process.env.DATABASE_URL as string)
  : null;

const SEED_CAMPAIGN_SLUG = 'music-lollipop-demo-2026';
const SEED_VERSION_ID = '85eafab1-a5bd-4d57-a697-38bce973deab';
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

describe.skipIf(!enabled)('DrizzleClaimDraftService (database integration)', () => {
  afterAll(async () => {
    await handle?.close();
  });

  it('creates an active draft bound to the seeded published version', async () => {
    const service = new DrizzleClaimDraftService(handle!.db);
    const result = await service.create(SEED_CAMPAIGN_SLUG);

    expect(result).not.toBeNull();
    expect(result!.draftId).toMatch(UUID_REGEX);
    expect(result!.draftToken.length).toBeGreaterThanOrEqual(32);
    const expiresAt = new Date(result!.expiresAt);
    expect(expiresAt.getTime()).toBeGreaterThan(Date.now());

    const [row] = await handle!.db
      .select({
        campaignId: claimDrafts.campaignId,
        campaignVersionId: claimDrafts.campaignVersionId,
        tokenHash: claimDrafts.tokenHash,
        status: claimDrafts.status,
        expiresAt: claimDrafts.expiresAt,
      })
      .from(claimDrafts)
      .where(eq(claimDrafts.id, result!.draftId))
      .limit(1);
    expect(row).toBeDefined();
    expect(row!.campaignVersionId).toBe(SEED_VERSION_ID);
    expect(row!.status).toBe('active');
    expect(row!.tokenHash).toBe(hashDraftToken(result!.draftToken));
    expect(row!.tokenHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('returns null for an unknown campaign slug', async () => {
    const service = new DrizzleClaimDraftService(handle!.db);
    const result = await service.create('no-such-campaign');

    expect(result).toBeNull();
  });
});
