// Opt-in integration test for the real database Claim write path.
// Runs only when RUN_DB_INTEGRATION=true AND DATABASE_URL is set.
import 'dotenv/config';

import { randomUUID } from 'node:crypto';

import { and, eq, inArray, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createDatabase, type DatabaseHandle } from '../src/db/client.js';
import {
  campaignMessageTemplates,
  campaignRemedyOptions,
  caseConsumers,
  claimDrafts,
  documentUploads,
  idempotencyRecords,
  incidents,
  outboxEvents,
  recallCases,
  reportabilityReviews,
} from '../src/db/schema/index.js';
import { DrizzleCaseService } from '../src/modules/cases/drizzle-case-service.js';
import { NodeSensitiveDataCrypto } from '../src/platform/crypto/node-sensitive-data-crypto.js';
import {
  ClaimConflictError,
  ClaimValidationError,
  DraftExpiredOrInvalidError,
  ResourceNotFoundError,
} from '../src/shared/errors.js';
import {
  cleanupClaimFixture,
  countCasesForDraft,
  createClaimFixture,
  loadAggregate,
  loadDraftStatus,
  type ClaimFixture,
} from './helpers/case-fixture.js';

const enabled = process.env.RUN_DB_INTEGRATION === 'true' && Boolean(process.env.DATABASE_URL);
const handle: DatabaseHandle | null = enabled
  ? createDatabase(process.env.DATABASE_URL as string)
  : null;
const crypto = new NodeSensitiveDataCrypto(
  Buffer.alloc(32, 1).toString('base64'),
  Buffer.alloc(32, 2).toString('base64'),
);

const CONCURRENT_GATE_TIMEOUT_MESSAGE = 'Concurrent test gate timed out waiting for participants.';
const CONCURRENT_GATE_ABORT_MESSAGE = 'Concurrent test gate aborted because a participant failed.';

interface FailSafeGate {
  readonly arrivals: number;
  wait: () => Promise<void>;
  fail: () => void;
}

function createFailSafeGate(
  parties: number,
  timeoutMs = 1000,
  onRelease: () => void = () => undefined,
): FailSafeGate {
  let arrivals = 0;
  let settled = false;
  let resolveGate!: () => void;
  let rejectGate!: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => {
    resolveGate = resolve;
    rejectGate = reject;
  });
  void ready.catch(() => undefined);

  const rejectAll = (message: string): void => {
    if (settled) return;
    settled = true;
    clearTimeout(timeout);
    rejectGate(new Error(message));
  };
  const timeout = setTimeout(() => {
    rejectAll(CONCURRENT_GATE_TIMEOUT_MESSAGE);
  }, timeoutMs);

  return {
    get arrivals() {
      return arrivals;
    },
    wait: () => {
      if (!settled) {
        arrivals += 1;
        if (arrivals === parties) {
          try {
            onRelease();
          } catch {
            rejectAll(CONCURRENT_GATE_ABORT_MESSAGE);
            return ready;
          }
          settled = true;
          clearTimeout(timeout);
          resolveGate();
        }
      }
      return ready;
    },
    fail: () => {
      rejectAll(CONCURRENT_GATE_ABORT_MESSAGE);
    },
  };
}

function withTransactionBarrier(base: DatabaseHandle, gate: FailSafeGate): DatabaseHandle {
  const transaction: DatabaseHandle['transaction'] = (work) =>
    base.transaction(async (tx) => {
      await gate.wait();
      return work(tx);
    });
  return { ...base, transaction };
}

async function runGateParticipant<T>(
  operation: () => Promise<T>,
  gates: FailSafeGate[],
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    for (const gate of gates) gate.fail();
    throw error;
  }
}

async function countCasesForEmail(email: string): Promise<number> {
  const emailLookupHash = await crypto.lookupHash(email);
  const rows = await handle!.db
    .select({ id: recallCases.id })
    .from(recallCases)
    .innerJoin(caseConsumers, eq(caseConsumers.caseId, recallCases.id))
    .where(eq(caseConsumers.emailLookupHash, emailLookupHash));
  return rows.length;
}

function uniqueCaseReference(): string {
  const token = randomUUID().replaceAll('-', '').toUpperCase();
  return `KOI-${token.slice(0, 4)}-${token.slice(4, 12)}`;
}

async function insertReferenceCollisions(draftId: string, references: string[]): Promise<string[]> {
  const [draft] = await handle!.db
    .select({
      campaignId: claimDrafts.campaignId,
      campaignVersionId: claimDrafts.campaignVersionId,
    })
    .from(claimDrafts)
    .where(eq(claimDrafts.id, draftId));
  if (!draft) throw new Error('Fixture Draft was not found.');

  const caseIds = references.map(() => randomUUID());
  await handle!.db.insert(recallCases).values(
    references.map((publicReference, index) => ({
      id: caseIds[index]!,
      publicReference,
      campaignId: draft.campaignId,
      campaignVersionId: draft.campaignVersionId,
      submittedAt: new Date(),
    })),
  );
  return caseIds;
}

type ValidationSetup = (fixture: ClaimFixture) => Promise<{
  command: ReturnType<ClaimFixture['command']>;
  cleanup?: () => Promise<void>;
}>;

const validationCases: Array<{
  name: string;
  error:
    typeof ClaimValidationError | typeof DraftExpiredOrInvalidError | typeof ResourceNotFoundError;
  setup: ValidationSetup;
}> = [
  {
    name: 'rejects a Campaign slug that does not own the Draft',
    error: ResourceNotFoundError,
    setup: (claimFixture) =>
      Promise.resolve({ command: claimFixture.command({ campaignSlug: 'another-campaign' }) }),
  },
  {
    name: 'rejects an expired Draft',
    error: DraftExpiredOrInvalidError,
    setup: async (claimFixture) => {
      await handle!.db
        .update(claimDrafts)
        .set({ expiresAt: new Date(Date.now() - 1000) })
        .where(eq(claimDrafts.id, claimFixture.draftId));
      return { command: claimFixture.command() };
    },
  },
  {
    name: 'rejects a Product outside the pinned Campaign Version',
    error: ClaimValidationError,
    setup: (claimFixture) => {
      const body = claimFixture.body();
      return Promise.resolve({
        command: claimFixture.command({
          body: {
            ...body,
            products: [{ ...body.products[0]!, campaignProductId: randomUUID() }],
          },
        }),
      });
    },
  },
  {
    name: 'rejects an inactive Remedy',
    error: ClaimValidationError,
    setup: async (claimFixture) => {
      const remedyId = randomUUID();
      const [draft] = await handle!.db
        .select({ campaignVersionId: claimDrafts.campaignVersionId })
        .from(claimDrafts)
        .where(eq(claimDrafts.id, claimFixture.draftId));
      if (!draft) throw new Error('Fixture Draft was not found.');
      await handle!.db.insert(campaignRemedyOptions).values({
        id: remedyId,
        campaignVersionId: draft.campaignVersionId,
        code: `inactive-${remedyId}`,
        displayName: 'Inactive test remedy',
        active: false,
      });
      return {
        command: claimFixture.command({
          body: claimFixture.body({ remedyCode: `inactive-${remedyId}` }),
        }),
        cleanup: async () => {
          await handle!.db
            .delete(campaignRemedyOptions)
            .where(eq(campaignRemedyOptions.id, remedyId));
        },
      };
    },
  },
  {
    name: 'rejects duplicate Document IDs',
    error: ClaimValidationError,
    setup: (claimFixture) =>
      Promise.resolve({
        command: claimFixture.command({
          body: claimFixture.body({
            documentIds: [claimFixture.documentIds[0]!, claimFixture.documentIds[0]!],
          }),
        }),
      }),
  },
  {
    name: 'rejects a Document that is not verified',
    error: ClaimValidationError,
    setup: async (claimFixture) => {
      await handle!.db
        .update(documentUploads)
        .set({ uploadStatus: 'uploaded' })
        .where(eq(documentUploads.id, claimFixture.documentIds[1]!));
      return { command: claimFixture.command() };
    },
  },
  {
    name: 'rejects Documents missing a required evidence category',
    error: ClaimValidationError,
    setup: async (claimFixture) => {
      await handle!.db
        .update(documentUploads)
        .set({ category: 'product_photo', categorySlot: 2 })
        .where(eq(documentUploads.id, claimFixture.documentIds[1]!));
      return { command: claimFixture.command() };
    },
  },
  {
    name: 'rejects a duplicate required Consent',
    error: ClaimValidationError,
    setup: (claimFixture) =>
      Promise.resolve({
        command: claimFixture.command({
          body: claimFixture.body({
            consents: [
              { type: 'privacy_notice', textVersion: '2026-08-04', accepted: true },
              { type: 'privacy_notice', textVersion: '2026-08-04', accepted: true },
            ],
          }),
        }),
      }),
  },
];

describe.skipIf(!enabled)('DrizzleCaseService (database integration)', () => {
  let fixture: ClaimFixture | undefined;

  beforeEach(async () => {
    fixture = await createClaimFixture(handle!);
  });

  afterEach(async () => {
    if (fixture) await cleanupClaimFixture(handle!, fixture);
    fixture = undefined;
  });

  afterAll(async () => {
    await handle?.close();
  });

  it('atomically persists a standard claim without plaintext sensitive data', async () => {
    const service = new DrizzleCaseService(handle!, crypto);
    const result = await service.submit({
      campaignSlug: 'music-lollipop-demo-2026',
      idempotencyKey: randomUUID(),
      body: fixture!.body({ incidentAnswer: 'no' }),
    });

    expect(result.caseReference).toMatch(/^KOI-[A-Z0-9]{4}-[A-Z0-9]{8}$/);
    expect(result.emailStatus).toBe('queued');

    const aggregate = await loadAggregate(handle!, result.caseReference);
    expect(aggregate.case.status).toBe('submitted');
    expect(aggregate.case.subtype).toBe('standard');
    expect(aggregate.case.incidentFlag).toBe(false);
    expect(aggregate.draft?.status).toBe('submitted');
    expect(aggregate.consumers).toHaveLength(1);
    expect(aggregate.products).toHaveLength(1);
    expect(aggregate.documents.every((row) => row.uploadStatus === 'linked')).toBe(true);
    expect(aggregate.consents).toHaveLength(2);
    expect(aggregate.snapshots).toHaveLength(1);
    expect(aggregate.events).toHaveLength(1);
    expect(aggregate.communications).toHaveLength(1);
    expect(aggregate.outbox).toHaveLength(1);
    expect(aggregate.idempotency).toHaveLength(1);
    expect(aggregate.incidents).toHaveLength(0);
    expect(aggregate.reviews).toHaveLength(0);
    expect(aggregate.consumers[0]?.emailLookupHash).toBe(
      await crypto.lookupHash('taylor@example.com'),
    );
    expect(aggregate.consumers[0]?.addressLookupHash).toBe(
      await crypto.lookupHash(
        '{"city":"Austin","countryCode":"US","line1":"100 Example Street","line2":"Unit 4","postalCode":"78701","state":"TX"}',
      ),
    );
    expect(aggregate.products[0]?.orderNumberLookupHash).toBe(
      await crypto.lookupHash('ORDER-10001'),
    );
    expect(aggregate.snapshots[0]?.schemaVersion).toBe('phase1-v1');
    expect(aggregate.communications[0]?.status).toBe('queued');
    expect(aggregate.outbox[0]?.eventType).toBe('claim.confirmation.requested');
    expect(aggregate.outbox[0]?.payload).toEqual({
      communicationId: aggregate.communications[0]?.id,
      caseId: aggregate.case.id,
    });
    expect(aggregate.events[0]?.data).toEqual({
      locale: 'en-US',
      productCount: 1,
      documentCount: 2,
      incidentAnswer: 'no',
    });

    const stored = JSON.stringify(aggregate);
    expect(stored).not.toContain('taylor@example.com');
    expect(stored).not.toContain('100 Example Street');
    expect(stored).not.toContain('ORDER-10001');
    expect(stored).not.toContain(fixture!.draftToken);
  });

  it('replays the original response for the same key and canonical request', async () => {
    const service = new DrizzleCaseService(handle!, crypto);
    const idempotencyKey = randomUUID();
    const command = fixture!.command({ idempotencyKey });

    const first = await service.submit(command);
    const replay = await service.submit({
      ...command,
      body: {
        ...command.body,
        consumer: {
          ...command.body.consumer,
          mailingAddress: { ...command.body.consumer.mailingAddress },
        },
      },
    });

    expect(replay).toEqual(first);
    await expect(countCasesForDraft(handle!, fixture!.draftId)).resolves.toBe(1);
    const [stored] = await handle!.db
      .select()
      .from(idempotencyRecords)
      .where(
        eq(idempotencyRecords.caseId, (await loadAggregate(handle!, first.caseReference)).case.id),
      );
    expect(stored?.responseBody).toEqual(first);
    const serialized = JSON.stringify(stored);
    expect(serialized).not.toContain(idempotencyKey);
    expect(serialized).not.toContain(fixture!.draftToken);
    expect(serialized).not.toContain(command.body.consumer.email);
    expect(serialized).not.toContain(command.body.consumer.mailingAddress.line1);
    expect(serialized).not.toContain(command.body.products[0]!.orderNumber!);
  });

  it('returns 409 when a key is reused with a different request', async () => {
    const service = new DrizzleCaseService(handle!, crypto);
    const command = fixture!.command({ idempotencyKey: randomUUID() });
    await service.submit(command);

    await expect(
      service.submit({
        ...command,
        body: { ...command.body, remedyCode: 'refund' },
      }),
    ).rejects.toBeInstanceOf(ClaimConflictError);
    await expect(countCasesForDraft(handle!, fixture!.draftId)).resolves.toBe(1);
  });

  it('opens both real PostgreSQL transactions before releasing concurrent work', async () => {
    let openTransactions = 0;
    let openTransactionsAtRelease = -1;
    const observedTransaction: DatabaseHandle['transaction'] = (work) =>
      handle!.transaction(async (tx) => {
        openTransactions += 1;
        try {
          return await work(tx);
        } finally {
          openTransactions -= 1;
        }
      });
    const transactionGate = createFailSafeGate(2, 1000, () => {
      openTransactionsAtRelease = openTransactions;
    });
    const synchronized = withTransactionBarrier(
      { ...handle!, transaction: observedTransaction },
      transactionGate,
    );

    await Promise.all([
      synchronized.transaction(async (tx) => {
        await tx.execute(sql`select pg_backend_pid()`);
      }),
      synchronized.transaction(async (tx) => {
        await tx.execute(sql`select pg_backend_pid()`);
      }),
    ]);

    expect(openTransactionsAtRelease).toBe(2);
  });

  it('rejects a real transaction gate when another participant never arrives', async () => {
    let openTransactions = 0;
    const observedTransaction: DatabaseHandle['transaction'] = (work) =>
      handle!.transaction(async (tx) => {
        openTransactions += 1;
        try {
          return await work(tx);
        } finally {
          openTransactions -= 1;
        }
      });
    const transactionGate = createFailSafeGate(2, 25);
    const synchronized = withTransactionBarrier(
      { ...handle!, transaction: observedTransaction },
      transactionGate,
    );
    const singleParticipant = synchronized.transaction(async (tx) => {
      await tx.execute(sql`select pg_backend_pid()`);
    });

    await expect(singleParticipant).rejects.toThrow(CONCURRENT_GATE_TIMEOUT_MESSAGE);
    expect(openTransactions).toBe(0);
    await expect(loadDraftStatus(handle!, fixture!.draftId)).resolves.toBe('active');
  });

  it('aborts an insert-gate participant when its peer fails before reaching the gate', async () => {
    const secondFixture = await createClaimFixture(handle!);
    const waitingEmail = `gate-rollback-${randomUUID()}@example.com`;
    const transactionGate = createFailSafeGate(2);
    const idempotencyInsertGate = createFailSafeGate(2);
    const service = new DrizzleCaseService(
      withTransactionBarrier(handle!, transactionGate),
      crypto,
      undefined,
      idempotencyInsertGate.wait,
    );
    const gates = [transactionGate, idempotencyInsertGate];
    const waiting = runGateParticipant(
      () =>
        service.submit(
          fixture!.command({
            body: fixture!.body({
              consumer: { ...fixture!.body().consumer, email: waitingEmail },
            }),
          }),
        ),
      gates,
    );
    const failing = runGateParticipant(
      () =>
        service.submit(
          secondFixture.command({
            body: secondFixture.body({ remedyCode: `missing-${randomUUID()}` }),
          }),
        ),
      gates,
    );

    try {
      const [waitingResult, failingResult] = await Promise.allSettled([waiting, failing]);
      expect(waitingResult.status).toBe('rejected');
      if (waitingResult.status !== 'rejected') throw new Error('Expected the waiter to reject.');
      expect(waitingResult.reason).toMatchObject({ message: CONCURRENT_GATE_ABORT_MESSAGE });
      expect(failingResult.status).toBe('rejected');
      if (failingResult.status !== 'rejected') {
        throw new Error('Expected the failing participant to reject.');
      }
      expect(failingResult.reason).toBeInstanceOf(ClaimValidationError);
      await expect(countCasesForDraft(handle!, fixture!.draftId)).resolves.toBe(0);
      await expect(countCasesForDraft(handle!, secondFixture.draftId)).resolves.toBe(0);
      await expect(countCasesForEmail(waitingEmail)).resolves.toBe(0);
      await expect(loadDraftStatus(handle!, fixture!.draftId)).resolves.toBe('active');
      await expect(loadDraftStatus(handle!, secondFixture.draftId)).resolves.toBe('active');
    } finally {
      await cleanupClaimFixture(handle!, secondFixture);
    }
  });

  it('creates exactly one aggregate for concurrent submission of one Draft', async () => {
    const email = `same-draft-${randomUUID()}@example.com`;
    const body = fixture!.body({
      consumer: { ...fixture!.body().consumer, email },
    });
    const transactionGate = createFailSafeGate(2);
    const service = new DrizzleCaseService(
      withTransactionBarrier(handle!, transactionGate),
      crypto,
    );

    const results = await Promise.allSettled([
      runGateParticipant(
        () => service.submit(fixture!.command({ idempotencyKey: randomUUID(), body })),
        [transactionGate],
      ),
      runGateParticipant(
        () => service.submit(fixture!.command({ idempotencyKey: randomUUID(), body })),
        [transactionGate],
      ),
    ]);

    const fulfilled = results.filter((result) => result.status === 'fulfilled');
    const rejected = results.filter((result) => result.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.reason).toBeInstanceOf(DraftExpiredOrInvalidError);
    await expect(countCasesForDraft(handle!, fixture!.draftId)).resolves.toBe(1);
    await expect(countCasesForEmail(email)).resolves.toBe(1);

    const aggregate = await loadAggregate(handle!, fulfilled[0]!.value.caseReference);
    expect(aggregate.consumers).toHaveLength(1);
    expect(aggregate.products).toHaveLength(1);
    expect(aggregate.documents).toHaveLength(2);
    expect(aggregate.consents).toHaveLength(2);
    expect(aggregate.snapshots).toHaveLength(1);
    expect(aggregate.incidents).toHaveLength(0);
    expect(aggregate.reviews).toHaveLength(0);
    expect(aggregate.events).toHaveLength(1);
    expect(aggregate.communications).toHaveLength(1);
    expect(aggregate.outbox).toHaveLength(1);
    expect(aggregate.idempotency).toHaveLength(1);
  });

  it('replays one result for concurrent requests with the same key and body', async () => {
    const email = `same-key-${randomUUID()}@example.com`;
    const command = fixture!.command({
      idempotencyKey: randomUUID(),
      body: fixture!.body({ consumer: { ...fixture!.body().consumer, email } }),
    });
    const transactionGate = createFailSafeGate(2);
    const service = new DrizzleCaseService(
      withTransactionBarrier(handle!, transactionGate),
      crypto,
    );

    const [first, second] = await Promise.all([
      runGateParticipant(() => service.submit(command), [transactionGate]),
      runGateParticipant(() => service.submit(command), [transactionGate]),
    ]);

    expect(second).toEqual(first);
    await expect(countCasesForDraft(handle!, fixture!.draftId)).resolves.toBe(1);
    await expect(countCasesForEmail(email)).resolves.toBe(1);
    const aggregate = await loadAggregate(handle!, first.caseReference);
    expect(aggregate.idempotency).toHaveLength(1);
    expect(aggregate.outbox).toHaveLength(1);
  });

  it('allows only one winner when one key is used concurrently for different Drafts', async () => {
    const secondFixture = await createClaimFixture(handle!);
    const idempotencyKey = randomUUID();
    const firstEmail = `first-${randomUUID()}@example.com`;
    const secondEmail = `second-${randomUUID()}@example.com`;
    const transactionGate = createFailSafeGate(2);
    const idempotencyInsertGate = createFailSafeGate(2);
    const service = new DrizzleCaseService(
      withTransactionBarrier(handle!, transactionGate),
      crypto,
      undefined,
      idempotencyInsertGate.wait,
    );
    const gates = [transactionGate, idempotencyInsertGate];

    try {
      const results = await Promise.allSettled([
        runGateParticipant(
          () =>
            service.submit(
              fixture!.command({
                idempotencyKey,
                body: fixture!.body({
                  consumer: { ...fixture!.body().consumer, email: firstEmail },
                }),
              }),
            ),
          gates,
        ),
        runGateParticipant(
          () =>
            service.submit(
              secondFixture.command({
                idempotencyKey,
                body: secondFixture.body({
                  consumer: { ...secondFixture.body().consumer, email: secondEmail },
                }),
              }),
            ),
          gates,
        ),
      ]);

      const fulfilled = results.filter((result) => result.status === 'fulfilled');
      const rejected = results.filter((result) => result.status === 'rejected');
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect(rejected[0]?.reason).toBeInstanceOf(ClaimConflictError);
      expect(idempotencyInsertGate.arrivals).toBe(2);
      expect((await countCasesForEmail(firstEmail)) + (await countCasesForEmail(secondEmail))).toBe(
        1,
      );
    } finally {
      await cleanupClaimFixture(handle!, secondFixture);
    }
  });

  it('retries a public Case Reference collision before dependent writes', async () => {
    const collisionReference = uniqueCaseReference();
    const freshReference = uniqueCaseReference();
    const collisionCaseIds = await insertReferenceCollisions(fixture!.draftId, [
      collisionReference,
    ]);
    const generated = [collisionReference, freshReference];
    const service = new DrizzleCaseService(handle!, crypto, () => generated.shift()!);

    try {
      const result = await service.submit(fixture!.command());

      expect(result.caseReference).toBe(freshReference);
      expect(generated).toHaveLength(0);
      const aggregate = await loadAggregate(handle!, freshReference);
      expect(aggregate.consumers).toHaveLength(1);
      expect(aggregate.idempotency).toHaveLength(1);
    } finally {
      await handle!.db.delete(recallCases).where(inArray(recallCases.id, collisionCaseIds));
    }
  });

  it('fails after three public Case Reference collisions and leaves the Draft active', async () => {
    const collisionReferences = [
      uniqueCaseReference(),
      uniqueCaseReference(),
      uniqueCaseReference(),
    ];
    const collisionCaseIds = await insertReferenceCollisions(fixture!.draftId, collisionReferences);
    const generated = [...collisionReferences];
    const service = new DrizzleCaseService(handle!, crypto, () => generated.shift()!);

    try {
      await expect(service.submit(fixture!.command())).rejects.toThrow(
        'Unable to allocate a unique Case Reference.',
      );
      expect(generated).toHaveLength(0);
      await expect(countCasesForDraft(handle!, fixture!.draftId)).resolves.toBe(0);
      await expect(loadDraftStatus(handle!, fixture!.draftId)).resolves.toBe('active');
    } finally {
      await handle!.db.delete(recallCases).where(inArray(recallCases.id, collisionCaseIds));
    }
  });

  it('persists yes as an encrypted incident with pending review', async () => {
    const narrative = 'A fictional minor injury occurred during use.';
    const result = await new DrizzleCaseService(handle!, crypto).submit({
      campaignSlug: 'music-lollipop-demo-2026',
      idempotencyKey: randomUUID(),
      body: fixture!.body({
        incidentAnswer: 'yes',
        incidentDetails: {
          eventTypes: ['injury'],
          narrative,
          occurredDateUnknown: true,
          injurySeverity: 'minor',
          medicalTreatment: 'first_aid',
        },
      }),
    });

    const aggregate = await loadAggregate(handle!, result.caseReference);
    expect(aggregate.case.subtype).toBe('injury_hazard');
    expect(aggregate.case.incidentFlag).toBe(true);
    expect(aggregate.incidents[0]).toMatchObject({
      answer: 'yes',
      eventTypes: ['injury'],
      occurredDateUnknown: true,
    });
    expect(aggregate.reviews[0]).toMatchObject({
      status: 'pending',
      decisionAt: null,
      cpscReference: null,
    });
    await expect(
      crypto.decrypt({
        keyVersion: aggregate.incidents[0]!.narrativeKeyVersion,
        value: aggregate.incidents[0]!.narrativeEncrypted,
      }),
    ).resolves.toBe(narrative);
    expect(JSON.stringify(aggregate)).not.toContain(narrative);
  });

  it('normalizes unsure without event type or date and routes to triage', async () => {
    const narrative = 'The consumer is unsure whether a safety incident occurred.';
    const result = await new DrizzleCaseService(handle!, crypto).submit({
      campaignSlug: 'music-lollipop-demo-2026',
      idempotencyKey: randomUUID(),
      body: fixture!.body({
        incidentAnswer: 'unsure',
        incidentDetails: {
          narrative,
          occurredDateUnknown: false,
        },
      }),
    });

    const aggregate = await loadAggregate(handle!, result.caseReference);
    expect(aggregate.case.status).toBe('triage');
    expect(aggregate.incidents[0]).toMatchObject({
      answer: 'unsure',
      eventTypes: ['unknown'],
      occurredDateUnknown: true,
    });
    expect(aggregate.reviews[0]).toMatchObject({
      status: 'pending',
      decisionAt: null,
      cpscReference: null,
    });
    await expect(
      crypto.decrypt({
        keyVersion: aggregate.incidents[0]!.narrativeKeyVersion,
        value: aggregate.incidents[0]!.narrativeEncrypted,
      }),
    ).resolves.toBe(narrative);
    expect(JSON.stringify(aggregate)).not.toContain(narrative);
  });

  it.each(validationCases)('$name and leaves the Draft active', async ({ error, setup }) => {
    const prepared = await setup(fixture!);
    try {
      await expect(
        new DrizzleCaseService(handle!, crypto).submit(prepared.command),
      ).rejects.toBeInstanceOf(error);
      await expect(countCasesForDraft(handle!, fixture!.draftId)).resolves.toBe(0);
      await expect(loadDraftStatus(handle!, fixture!.draftId)).resolves.toBe('active');
    } finally {
      await prepared.cleanup?.();
    }
  });

  it('persists a not-matched Product for triage instead of rejecting the Claim', async () => {
    const body = fixture!.body();
    const result = await new DrizzleCaseService(handle!, crypto).submit(
      fixture!.command({
        body: {
          ...body,
          products: [
            {
              ...body.products[0]!,
              lotCode: 'UNKNOWN-LOT',
              dateCode: '01/1999',
            },
          ],
        },
      }),
    );

    const aggregate = await loadAggregate(handle!, result.caseReference);
    expect(aggregate.case.status).toBe('triage');
    expect(aggregate.products).toHaveLength(1);
    expect(aggregate.products[0]?.checkResult).toBe('not_matched');
  });

  it('leaves an omitted verified Document owned by the Draft', async () => {
    const omittedDocumentId = randomUUID();
    fixture!.documentIds.push(omittedDocumentId);
    await handle!.db.insert(documentUploads).values({
      id: omittedDocumentId,
      draftId: fixture!.draftId,
      category: 'product_photo',
      categorySlot: 2,
      storagePathname: `tests/${fixture!.draftId}/${omittedDocumentId}/extra.jpg`,
      originalFileName: 'extra.jpg',
      declaredMimeType: 'image/jpeg',
      detectedMimeType: 'image/jpeg',
      sizeBytes: 512,
      sha256: 'c'.repeat(64),
      uploadStatus: 'verified',
      scanStatus: 'clean',
      uploadedAt: new Date(),
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    });

    await new DrizzleCaseService(handle!, crypto).submit(
      fixture!.command({
        body: fixture!.body({ documentIds: fixture!.documentIds.slice(0, 2) }),
      }),
    );

    const [omitted] = await handle!.db
      .select({
        draftId: documentUploads.draftId,
        caseId: documentUploads.caseId,
        uploadStatus: documentUploads.uploadStatus,
      })
      .from(documentUploads)
      .where(eq(documentUploads.id, omittedDocumentId));
    expect(omitted).toEqual({
      draftId: fixture!.draftId,
      caseId: null,
      uploadStatus: 'verified',
    });
  });

  it('rolls back all Case-owned writes when no active confirmation template exists', async () => {
    const [draft] = await handle!.db
      .select({ campaignVersionId: claimDrafts.campaignVersionId })
      .from(claimDrafts)
      .where(eq(claimDrafts.id, fixture!.draftId));
    if (!draft) throw new Error('Fixture Draft was not found.');
    const disabled = await handle!.db
      .update(campaignMessageTemplates)
      .set({ active: false })
      .where(
        and(
          eq(campaignMessageTemplates.campaignVersionId, draft.campaignVersionId),
          eq(campaignMessageTemplates.locale, 'en-US'),
          eq(campaignMessageTemplates.templateType, 'claim_confirmation'),
          eq(campaignMessageTemplates.active, true),
        ),
      )
      .returning({ id: campaignMessageTemplates.id });
    expect(disabled.length).toBeGreaterThan(0);

    try {
      await expect(
        new DrizzleCaseService(handle!, crypto).submit(fixture!.command()),
      ).rejects.toThrow('An active Claim confirmation template is required.');
      await expect(countCasesForDraft(handle!, fixture!.draftId)).resolves.toBe(0);
      await expect(loadDraftStatus(handle!, fixture!.draftId)).resolves.toBe('active');
    } finally {
      await handle!.db
        .update(campaignMessageTemplates)
        .set({ active: true })
        .where(
          inArray(
            campaignMessageTemplates.id,
            disabled.map((template) => template.id),
          ),
        );
    }
  });

  it('rolls back the aggregate when the Outbox unique constraint rejects its event', async () => {
    const idempotencyKey = randomUUID();
    const rollbackEmail = `rollback-${idempotencyKey}@example.com`;
    const command = fixture!.command({
      idempotencyKey,
      body: fixture!.body({
        consumer: { ...fixture!.body().consumer, email: rollbackEmail },
        incidentAnswer: 'yes',
        incidentDetails: {
          eventTypes: ['injury'],
          narrative: 'An incident that must roll back after the Outbox failure.',
          occurredDateUnknown: true,
          injurySeverity: 'minor',
          medicalTreatment: 'first_aid',
        },
      }),
    });
    const keyHash = await crypto.lookupHash(idempotencyKey);
    const deduplicationKey = `claim-confirmation:${keyHash}`;
    await handle!.db.insert(outboxEvents).values({
      aggregateType: 'test',
      aggregateId: randomUUID(),
      eventType: 'test.conflict',
      deduplicationKey,
      payload: {},
    });

    try {
      await expect(new DrizzleCaseService(handle!, crypto).submit(command)).rejects.toMatchObject({
        cause: { code: '23505' },
      });
      await expect(countCasesForDraft(handle!, fixture!.draftId)).resolves.toBe(0);
      await expect(loadDraftStatus(handle!, fixture!.draftId)).resolves.toBe('active');
      const rollbackEmailLookupHash = await crypto.lookupHash(rollbackEmail);
      const remainingCases = await handle!.db
        .select({ id: recallCases.id })
        .from(recallCases)
        .innerJoin(caseConsumers, eq(caseConsumers.caseId, recallCases.id))
        .where(eq(caseConsumers.emailLookupHash, rollbackEmailLookupHash));
      const remainingIncidentRows = await handle!.db
        .select({ id: incidents.id })
        .from(incidents)
        .innerJoin(recallCases, eq(recallCases.id, incidents.caseId))
        .innerJoin(caseConsumers, eq(caseConsumers.caseId, recallCases.id))
        .where(eq(caseConsumers.emailLookupHash, rollbackEmailLookupHash));
      const remainingReviewRows = await handle!.db
        .select({ id: reportabilityReviews.id })
        .from(reportabilityReviews)
        .innerJoin(incidents, eq(incidents.id, reportabilityReviews.incidentId))
        .innerJoin(recallCases, eq(recallCases.id, incidents.caseId))
        .innerJoin(caseConsumers, eq(caseConsumers.caseId, recallCases.id))
        .where(eq(caseConsumers.emailLookupHash, rollbackEmailLookupHash));
      expect(remainingCases).toHaveLength(0);
      expect(remainingIncidentRows).toHaveLength(0);
      expect(remainingReviewRows).toHaveLength(0);

      const documents = await handle!.db
        .select({
          draftId: documentUploads.draftId,
          caseId: documentUploads.caseId,
          uploadStatus: documentUploads.uploadStatus,
        })
        .from(documentUploads)
        .where(inArray(documentUploads.id, fixture!.documentIds));
      expect(documents).toHaveLength(2);
      expect(documents.every((document) => document.draftId === fixture!.draftId)).toBe(true);
      expect(documents.every((document) => document.caseId === null)).toBe(true);
      expect(documents.every((document) => document.uploadStatus === 'verified')).toBe(true);
    } finally {
      await handle!.db
        .delete(outboxEvents)
        .where(eq(outboxEvents.deduplicationKey, deduplicationKey));
    }
  });
});
