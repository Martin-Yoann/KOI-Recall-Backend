// Opt-in integration proof for the full Hono -> Drizzle -> PostgreSQL Claim path.
// Runs only when RUN_DB_INTEGRATION=true AND DATABASE_URL is set.
import 'dotenv/config';

import { randomUUID } from 'node:crypto';

import { eq } from 'drizzle-orm';
import { afterAll, afterEach, describe, expect, it } from 'vitest';

import { createApp } from '../src/app.js';
import { createApplicationRegistry } from '../src/composition.js';
import { loadConfig } from '../src/config/env.js';
import { claimSubmissionResponseSchema } from '../src/contracts/toc.js';
import { createDatabase, type DatabaseHandle } from '../src/db/client.js';
import { caseConsumers } from '../src/db/schema/index.js';
import { NodeSensitiveDataCrypto } from '../src/platform/crypto/node-sensitive-data-crypto.js';
import {
  cleanupClaimFixture,
  countCasesForDraft,
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

  it('submits and idempotently replays a seeded claim through Hono app.request', async () => {
    fixture = await createClaimFixture(handle!);
    const crypto = new NodeSensitiveDataCrypto(config.FIELD_ENCRYPTION_KEY!, config.HASH_PEPPER!);
    const registry = createApplicationRegistry(handle!, undefined, crypto);
    const app = createApp({ config, registry });
    const idempotencyKey = randomUUID();
    const uniqueEmail = `http-${randomUUID()}@example.com`;
    const uniqueOrderNumber = `HTTP-${randomUUID()}`;
    const baseBody = fixture.body({ incidentAnswer: 'no' });
    const claimBody = {
      ...baseBody,
      consumer: { ...baseBody.consumer, email: uniqueEmail },
      products: baseBody.products.map((product, index) =>
        index === 0 ? { ...product, orderNumber: uniqueOrderNumber } : product,
      ),
    };
    const payload = JSON.stringify(claimBody);

    const response = await app.request(`/v1/recall-campaigns/${SEED_SLUG}/claims`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': idempotencyKey,
      },
      body: payload,
    });

    expect(response.status).toBe(201);
    const body = claimSubmissionResponseSchema.parse(await response.json());
    const firstAggregate = await loadAggregate(handle!, body.caseReference);
    expect(body.caseReference).toMatch(/^KOI-[A-Z0-9]{4}-[A-Z0-9]{8}$/);
    expect(body.emailStatus).toBe('queued');
    expect(firstAggregate.draft?.status).toBe('submitted');
    expect(firstAggregate.documents).toHaveLength(2);
    expect(firstAggregate.communications).toHaveLength(1);
    expect(firstAggregate.communications[0]).toMatchObject({
      caseId: firstAggregate.case.id,
      channel: 'email',
      status: 'queued',
      providerMessageId: null,
      providerErrorCode: null,
      sentAt: null,
      deliveredAt: null,
    });
    expect(firstAggregate.communications[0]?.recipientEncrypted).toMatch(/^enc\.v1\.aes-256-gcm\./);
    expect(firstAggregate.outbox).toHaveLength(1);
    expect(firstAggregate.outbox[0]).toMatchObject({
      aggregateType: 'recall_case',
      aggregateId: firstAggregate.case.id,
      eventType: 'claim.confirmation.requested',
      status: 'pending',
      attempts: 0,
      lockedAt: null,
      lastErrorCode: null,
      processedAt: null,
    });
    expect(firstAggregate.outbox[0]?.payload).toEqual({
      communicationId: firstAggregate.communications[0]?.id,
      caseId: firstAggregate.case.id,
    });
    expect(firstAggregate.idempotency).toHaveLength(1);
    expect(firstAggregate.idempotency[0]).toMatchObject({
      endpoint: `/v1/recall-campaigns/${SEED_SLUG}/claims`,
      statusCode: 201,
      responseBody: body,
      caseId: firstAggregate.case.id,
    });
    expect(firstAggregate.idempotency[0]?.keyHash).toMatch(/^[a-f0-9]{64}$/);
    expect(firstAggregate.idempotency[0]?.requestHash).toMatch(/^[a-f0-9]{64}$/);

    const storedDeliveryMetadata = JSON.stringify({
      communication: firstAggregate.communications[0],
      outbox: firstAggregate.outbox[0],
      idempotency: firstAggregate.idempotency[0],
    });
    for (const plaintext of [
      'Taylor',
      uniqueEmail,
      '100 Example Street',
      uniqueOrderNumber,
      fixture.draftToken,
      '"subject"',
      '"htmlBody"',
      '"textBody"',
    ]) {
      expect(storedDeliveryMetadata).not.toContain(plaintext);
    }

    const replayResponse = await app.request(`/v1/recall-campaigns/${SEED_SLUG}/claims`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': idempotencyKey,
      },
      body: payload,
    });
    expect(replayResponse.status).toBe(201);
    const replayBody = claimSubmissionResponseSchema.parse(await replayResponse.json());
    expect(replayBody).toEqual(body);

    await expect(countCasesForDraft(handle!, fixture.draftId)).resolves.toBe(1);
    const casesForConsumer = await handle!.db
      .select({ caseId: caseConsumers.caseId })
      .from(caseConsumers)
      .where(eq(caseConsumers.emailLookupHash, await crypto.lookupHash(uniqueEmail)));
    expect(casesForConsumer).toHaveLength(1);
    expect(casesForConsumer[0]?.caseId).toBe(firstAggregate.case.id);
    const replayAggregate = await loadAggregate(handle!, body.caseReference);
    expect(replayAggregate.communications).toHaveLength(1);
    expect(replayAggregate.outbox).toHaveLength(1);
    expect(replayAggregate.idempotency).toHaveLength(1);

    process.stdout.write(
      [
        `status=${response.status}`,
        `replayStatus=${replayResponse.status}`,
        `caseReference=${body.caseReference}`,
        `emailStatus=${body.emailStatus}`,
        `draftStatus=${replayAggregate.draft?.status}`,
        `linkedDocuments=${replayAggregate.documents.length}`,
        `communications=${replayAggregate.communications.length}`,
        `outboxEvents=${replayAggregate.outbox.length}`,
        `idempotencyRecords=${replayAggregate.idempotency.length}`,
      ].join('\n') + '\n',
    );
  });
});
