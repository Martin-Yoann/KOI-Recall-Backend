// Opt-in integration proof for the full Hono -> Drizzle -> PostgreSQL Claim path.
// Runs only when RUN_DB_INTEGRATION=true AND DATABASE_URL is set.
import 'dotenv/config';

import { randomUUID } from 'node:crypto';

import { afterAll, afterEach, describe, expect, it } from 'vitest';

import { createApp } from '../src/app.js';
import { createApplicationRegistry } from '../src/composition.js';
import { loadConfig } from '../src/config/env.js';
import { claimSubmissionResponseSchema } from '../src/contracts/toc.js';
import { createDatabase, type DatabaseHandle } from '../src/db/client.js';
import { NodeSensitiveDataCrypto } from '../src/platform/crypto/node-sensitive-data-crypto.js';
import {
  cleanupClaimFixture,
  createClaimFixture,
  loadAggregate,
  type ClaimFixture,
} from './helpers/case-fixture.js';

const SEED_SLUG = 'music-lollipop-demo-2026';
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

describe.skipIf(!enabled)('Claim HTTP integration', () => {
  let fixture: ClaimFixture | undefined;

  afterEach(async () => {
    if (fixture) await cleanupClaimFixture(handle!, fixture);
    fixture = undefined;
  });

  afterAll(async () => {
    await handle?.close();
  });

  it('submits a seeded claim through Hono app.request', async () => {
    fixture = await createClaimFixture(handle!);
    const crypto = new NodeSensitiveDataCrypto(config.FIELD_ENCRYPTION_KEY!, config.HASH_PEPPER!);
    const registry = createApplicationRegistry(handle!, undefined, crypto);
    const app = createApp({ config, registry });

    const response = await app.request(`/v1/recall-campaigns/${SEED_SLUG}/claims`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': randomUUID(),
      },
      body: JSON.stringify(fixture.body({ incidentAnswer: 'no' })),
    });

    expect(response.status).toBe(201);
    const body = claimSubmissionResponseSchema.parse(await response.json());
    const aggregate = await loadAggregate(handle!, body.caseReference);
    expect(body.caseReference).toMatch(/^KOI-[A-Z0-9]{4}-[A-Z0-9]{8}$/);
    expect(body.emailStatus).toBe('queued');
    expect(aggregate.draft?.status).toBe('submitted');
    expect(aggregate.documents).toHaveLength(2);

    process.stdout.write(
      [
        `status=${response.status}`,
        `caseReference=${body.caseReference}`,
        `emailStatus=${body.emailStatus}`,
        `draftStatus=${aggregate.draft?.status}`,
        `linkedDocuments=${aggregate.documents.length}`,
      ].join('\n') + '\n',
    );
  });
});
