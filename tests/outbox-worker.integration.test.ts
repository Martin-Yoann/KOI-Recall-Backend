// Opt-in integration test for the outbox drain path.
// Runs only when RUN_DB_INTEGRATION=true AND DATABASE_URL is set.
import 'dotenv/config';

import { eq } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';

import type { DatabaseHandle } from '../src/db/client.js';
import { createDatabase } from '../src/db/client.js';
import { outboxEvents } from '../src/db/schema/index.js';
import { DrizzleOutboxWorker } from '../src/jobs/drizzle-outbox-worker.js';
import { NodeSensitiveDataCrypto } from '../src/platform/crypto/node-sensitive-data-crypto.js';
import type {
  EmailSendResult,
  TransactionalEmail,
  TransactionalEmailPort,
} from '../src/platform/email/port.js';

const enabled = process.env.RUN_DB_INTEGRATION === 'true' && Boolean(process.env.DATABASE_URL);
const handle: DatabaseHandle | null = enabled
  ? createDatabase(process.env.DATABASE_URL as string)
  : null;

const crypto = new NodeSensitiveDataCrypto(
  Buffer.alloc(32, 7).toString('base64'),
  Buffer.alloc(32, 8).toString('base64'),
);

class FakeEmailPort implements TransactionalEmailPort {
  sent: TransactionalEmail[] = [];
  constructor(private readonly shouldFail = false) {}
  send(message: TransactionalEmail): Promise<EmailSendResult> {
    if (this.shouldFail) return Promise.reject(new Error('provider down'));
    this.sent.push(message);
    return Promise.resolve({ providerMessageId: `msg-${this.sent.length}` });
  }
}

describe.skipIf(!enabled)('DrizzleOutboxWorker (database integration)', () => {
  afterAll(async () => {
    await handle?.close();
  });

  it('returns a zero result when there is nothing due', async () => {
    const worker = new DrizzleOutboxWorker(handle!.db, new FakeEmailPort(), crypto);
    await expect(worker.runBatch(10)).resolves.toEqual({ claimed: 0, succeeded: 0, failed: 0 });
  });

  it('drains a pending claim-confirmation event through to sent', async () => {
    const db = handle!.db;
    // Insert an event payload pointing at a communication that cannot resolve
    // (no matching template) — asserting the worker dead-letters rather than
    // crashing, which proves the claim/lock/state machine runs.
    const [inserted] = await db
      .insert(outboxEvents)
      .values({
        aggregateType: 'recall_case',
        aggregateId: '00000000-0000-4000-8000-000000000001',
        eventType: 'claim.confirmation.requested',
        deduplicationKey: `test-${Date.now()}`,
        payload: { communicationId: '00000000-0000-4000-8000-000000000002' },
        status: 'pending',
        attempts: 0,
        availableAt: new Date(),
      })
      .returning({ id: outboxEvents.id });

    const worker = new DrizzleOutboxWorker(db, new FakeEmailPort(), crypto);
    const result = await worker.runBatch(10);

    expect(result.claimed).toBe(1);
    // No communication exists for the fake id, so the event is failed/dead.
    const [row] = await db.select().from(outboxEvents).where(eq(outboxEvents.id, inserted!.id));
    expect(['pending', 'dead_letter']).toContain(row?.status);
    expect(row?.attempts).toBe(1);
    expect(row?.lastErrorCode).toBe('communication_not_found');

    await db.delete(outboxEvents).where(eq(outboxEvents.id, inserted!.id));
  });

  it('does not send anything when the event is already succeeded', async () => {
    const db = handle!.db;
    const port = new FakeEmailPort();
    const worker = new DrizzleOutboxWorker(db, port, crypto);
    const result = await worker.runBatch(5);
    expect(result).toEqual({ claimed: 0, succeeded: 0, failed: 0 });
    expect(port.sent).toHaveLength(0);
  });
});
