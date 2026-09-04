// Opt-in integration proof for the H1-trimmed legacy lookup (§9.9 whitelist).
// Runs only when RUN_DB_INTEGRATION=true AND DATABASE_URL is set.
import 'dotenv/config';

import { randomUUID } from 'node:crypto';

import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../src/app.js';
import { createApplicationRegistry } from '../src/composition.js';
import { loadConfig } from '../src/config/env.js';
import { createDatabase, type DatabaseHandle } from '../src/db/client.js';
import { campaignVersions, recallCampaigns } from '../src/db/schema/index.js';
import { NodeSensitiveDataCrypto } from '../src/platform/crypto/node-sensitive-data-crypto.js';
import {
  cleanupClaimFixture,
  createClaimFixture,
  type ClaimFixture,
} from './helpers/case-fixture.js';

const SEED_SLUG = 'music-lollipop-demo-2026';
// The fixture body submits this exact phone; submission stores it verbatim.
const SUBMITTED_PHONE = '+1-555-010-2026';
// The consent textVersion the fixture sends; the campaign version must carry
// the same value or the submission is rejected as stale.
const CONSENT_TEXT_VERSION = '2026-08-04';

const enabled = process.env.RUN_DB_INTEGRATION === 'true' && Boolean(process.env.DATABASE_URL);
const handle: DatabaseHandle | null = enabled
  ? createDatabase(process.env.DATABASE_URL as string)
  : null;
const config = loadConfig({
  DATABASE_URL: process.env.DATABASE_URL,
  CORS_ALLOWED_ORIGINS: 'http://localhost:3000',
  FIELD_ENCRYPTION_KEY: Buffer.alloc(32, 11).toString('base64'),
  HASH_PEPPER: Buffer.alloc(32, 12).toString('base64'),
});

describe.skipIf(!enabled)('Legacy consumer-auth lookup (H1 §9.9 whitelist)', () => {
  let fixture: ClaimFixture | undefined;
  let previousEncryptionKey: string | undefined;
  let previousPepper: string | undefined;
  let previousPrivacyNoticeVersion: string | null | undefined;

  // The consumer-auth routes read their crypto keys straight from process.env
  // while the submit path uses the config keys; the two must match for the
  // lookup's phone decrypt to round-trip.
  beforeAll(async () => {
    previousEncryptionKey = process.env.FIELD_ENCRYPTION_KEY;
    previousPepper = process.env.HASH_PEPPER;
    process.env.FIELD_ENCRYPTION_KEY = config.FIELD_ENCRYPTION_KEY;
    process.env.HASH_PEPPER = config.HASH_PEPPER;

    // The seeded demo campaign is synthetic and its published version may
    // predate the privacy-notice column (older local databases). Public
    // lookups match on the campaign's email lookup hash and submissions
    // require a privacy notice version, so patch both for this proof and
    // restore afterwards.
    await handle!.db
      .update(recallCampaigns)
      .set({ isTestData: false })
      .where(eq(recallCampaigns.slug, SEED_SLUG));
    const [campaign] = await handle!.db
      .select({ publishedVersionId: recallCampaigns.publishedVersionId })
      .from(recallCampaigns)
      .where(eq(recallCampaigns.slug, SEED_SLUG))
      .limit(1);
    if (campaign?.publishedVersionId) {
      const [version] = await handle!.db
        .select({ privacyNoticeVersion: campaignVersions.privacyNoticeVersion })
        .from(campaignVersions)
        .where(eq(campaignVersions.id, campaign.publishedVersionId))
        .limit(1);
      previousPrivacyNoticeVersion = version?.privacyNoticeVersion ?? null;
      if (previousPrivacyNoticeVersion !== CONSENT_TEXT_VERSION) {
        await handle!.db
          .update(campaignVersions)
          .set({ privacyNoticeVersion: CONSENT_TEXT_VERSION })
          .where(eq(campaignVersions.id, campaign.publishedVersionId));
      }
    }
  });

  afterAll(async () => {
    process.env.FIELD_ENCRYPTION_KEY = previousEncryptionKey;
    process.env.HASH_PEPPER = previousPepper;
    const [campaign] = await handle!.db
      .select({ publishedVersionId: recallCampaigns.publishedVersionId })
      .from(recallCampaigns)
      .where(eq(recallCampaigns.slug, SEED_SLUG))
      .limit(1);
    if (campaign?.publishedVersionId && previousPrivacyNoticeVersion !== undefined) {
      await handle!.db
        .update(campaignVersions)
        .set({ privacyNoticeVersion: previousPrivacyNoticeVersion })
        .where(eq(campaignVersions.id, campaign.publishedVersionId));
    }
    await handle!.db
      .update(recallCampaigns)
      .set({ isTestData: true })
      .where(eq(recallCampaigns.slug, SEED_SLUG));
    void handle?.close();
  });

  afterEach(async () => {
    if (fixture) await cleanupClaimFixture(handle!, fixture);
    fixture = undefined;
  });

  async function submitCase(): Promise<string> {
    fixture = await createClaimFixture(handle!);
    const crypto = new NodeSensitiveDataCrypto(config.FIELD_ENCRYPTION_KEY!, config.HASH_PEPPER!);
    const registry = createApplicationRegistry(handle!, undefined, crypto);
    const app = createApp({ config, registry });

    const baseBody = fixture.body({ incidentAnswer: 'no' });
    const claimBody = {
      ...baseBody,
      consumer: { ...baseBody.consumer, email: `lookup-${randomUUID()}@example.com` },
    };
    const response = await app.request(`/v1/recall-campaigns/${SEED_SLUG}/claims`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() },
      body: JSON.stringify(claimBody),
    });
    expect(response.status).toBe(201);
    return ((await response.json()) as { caseReference: string }).caseReference;
  }

  it('returns only the whitelisted public fields for a matching phone', async () => {
    const caseReference = await submitCase();
    const crypto = new NodeSensitiveDataCrypto(config.FIELD_ENCRYPTION_KEY!, config.HASH_PEPPER!);
    const registry = createApplicationRegistry(handle!, undefined, crypto);
    const app = createApp({ config, registry });

    const response = await app.request(
      `/v1/consumer-auth/lookup/${caseReference}?phone=${encodeURIComponent(SUBMITTED_PHONE)}`,
      { headers: { 'X-Request-Id': 'legacy-lookup-h1' } },
    );

    expect(response.status).toBe(200);
    const payload = (await response.json()) as Record<string, unknown>;
    expect(Object.keys(payload).sort()).toEqual([
      'approvedResolution',
      'campaignTitle',
      'caseReference',
      'consumerNextAction',
      'lastUpdatedAt',
      'publicStatus',
      'publicStatusLabel',
      'requestedResolution',
    ]);
    expect(payload.caseReference).toBe(caseReference);
    expect(payload.publicStatus).toBe('received');

    // §9.9 forbidden list: none of the trimmed PII may ever reappear, in
    // field names or serialized values.
    expect(JSON.stringify(payload)).not.toMatch(
      /consumerName|consumerEmail|consumerPhone|productName|lotCode|dateCode|refundAmount|Taylor|taylor|555-010/,
    );
  });

  it('renders the same 404 bytes for an unknown reference and a phone mismatch', async () => {
    const caseReference = await submitCase();
    const crypto = new NodeSensitiveDataCrypto(config.FIELD_ENCRYPTION_KEY!, config.HASH_PEPPER!);
    const registry = createApplicationRegistry(handle!, undefined, crypto);
    const app = createApp({ config, registry });

    const mismatch = await app.request(
      `/v1/consumer-auth/lookup/${caseReference}?phone=${encodeURIComponent('+1-555-010-9999')}`,
      { headers: { 'X-Request-Id': 'legacy-lookup-h1' } },
    );
    const unknown = await app.request(
      `/v1/consumer-auth/lookup/KOI-0000-00000000?phone=${encodeURIComponent(SUBMITTED_PHONE)}`,
      { headers: { 'X-Request-Id': 'legacy-lookup-h1' } },
    );

    expect(mismatch.status).toBe(404);
    expect(unknown.status).toBe(404);
    expect(await mismatch.text()).toEqual(await unknown.text());
  });
});
