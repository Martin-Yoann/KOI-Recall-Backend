// Opt-in integration test for the real database Claim write path.
// Runs only when RUN_DB_INTEGRATION=true AND DATABASE_URL is set.
import 'dotenv/config';

import { randomUUID } from 'node:crypto';

import { and, eq, inArray, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createDatabase, type DatabaseHandle } from '../src/db/client.js';
import {
  campaignEvidenceRequirements,
  campaignMessageTemplates,
  campaignProductLots,
  campaignProducts,
  campaignRemedyOptions,
  campaignVersions,
  caseConsumers,
  claimDrafts,
  documentUploads,
  idempotencyRecords,
  incidents,
  outboxEvents,
  recallCampaigns,
  recallCases,
  reportabilityReviews,
} from '../src/db/schema/index.js';
import { DrizzleCaseService } from '../src/modules/cases/drizzle-case-service.js';
import { DrizzleClaimDraftService } from '../src/modules/claim-drafts/drizzle-claim-draft-service.js';
import { DrizzleDocumentService } from '../src/modules/documents/drizzle-document-service.js';
import { NotImplementedPrivateBlobAdapter } from '../src/platform/blob/not-implemented.js';
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

interface BoundedPause {
  entered: Promise<void>;
  wait: () => Promise<void>;
  release: () => void;
  fail: () => void;
}

function createBoundedPause(timeoutMs = 1000): BoundedPause {
  let entered = false;
  let settled = false;
  let resolveEntered!: () => void;
  let rejectEntered!: (error: Error) => void;
  let resolveRelease!: () => void;
  let rejectRelease!: (error: Error) => void;
  const enteredPromise = new Promise<void>((resolve, reject) => {
    resolveEntered = resolve;
    rejectEntered = reject;
  });
  const released = new Promise<void>((resolve, reject) => {
    resolveRelease = resolve;
    rejectRelease = reject;
  });
  void enteredPromise.catch(() => undefined);
  void released.catch(() => undefined);
  const timeout = setTimeout(() => {
    if (settled) return;
    settled = true;
    const error = new Error(CONCURRENT_GATE_TIMEOUT_MESSAGE);
    if (!entered) rejectEntered(error);
    rejectRelease(error);
  }, timeoutMs);

  return {
    entered: enteredPromise,
    wait: () => {
      if (!entered) {
        entered = true;
        resolveEntered();
      }
      return released;
    },
    release: () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolveRelease();
    },
    fail: () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      const error = new Error(CONCURRENT_GATE_ABORT_MESSAGE);
      if (!entered) rejectEntered(error);
      rejectRelease(error);
    },
  };
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

async function createTemporaryCampaign() {
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
  const campaignId = randomUUID();
  const campaignVersionId = randomUUID();
  const productId = randomUUID();
  const slug = `claim-scope-${suffix}`;
  await handle!.db.insert(recallCampaigns).values({
    id: campaignId,
    slug,
    code: `SCOPE-${suffix}`,
    status: 'active',
    defaultLocale: 'en-US',
    isTestData: true,
  });
  await handle!.db.insert(campaignVersions).values({
    id: campaignVersionId,
    campaignId,
    versionNumber: 1,
    status: 'published',
    publishedAt: new Date(),
  });
  await handle!.db
    .update(recallCampaigns)
    .set({ publishedVersionId: campaignVersionId })
    .where(eq(recallCampaigns.id, campaignId));
  await handle!.db.insert(campaignProducts).values({
    id: productId,
    campaignVersionId,
    sku: `SCOPE-${suffix}`,
    brand: 'KOI Test',
    name: 'Scoped idempotency fixture',
    attributes: { shapes: ['Bear'], flavors: ['Peach'] },
  });
  await handle!.db.insert(campaignProductLots).values({
    campaignProductId: productId,
    lotCode: 'ML-2406-A',
    dateCode: '06/2024',
    eligibilityStatus: 'affected',
  });
  await handle!.db.insert(campaignRemedyOptions).values({
    campaignVersionId,
    code: 'replacement',
    displayName: 'Replacement',
    active: true,
  });
  await handle!.db.insert(campaignEvidenceRequirements).values([
    {
      campaignVersionId,
      category: 'product_photo',
      required: true,
      minimumFiles: 1,
      maximumFiles: 2,
      allowedMimeTypes: ['image/jpeg'],
      maximumFileSizeBytes: 5_000_000,
      instructions: 'Upload one product photo.',
    },
    {
      campaignVersionId,
      category: 'proof_of_purchase',
      required: true,
      minimumFiles: 1,
      maximumFiles: 1,
      allowedMimeTypes: ['application/pdf'],
      maximumFileSizeBytes: 5_000_000,
      instructions: 'Upload one receipt.',
    },
  ]);
  await handle!.db.insert(campaignMessageTemplates).values({
    campaignVersionId,
    locale: 'en-US',
    templateType: 'claim_confirmation',
    version: 1,
    subject: 'Claim received',
    htmlBody: '<p>Claim received.</p>',
    textBody: 'Claim received.',
    active: true,
  });

  return {
    slug,
    productId,
    cleanup: async () => {
      await handle!.db
        .update(recallCampaigns)
        .set({ publishedVersionId: null })
        .where(eq(recallCampaigns.id, campaignId));
      await handle!.db.delete(recallCampaigns).where(eq(recallCampaigns.id, campaignId));
    },
  };
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
    name: 'hides Campaign ownership when the Draft token is invalid',
    error: DraftExpiredOrInvalidError,
    setup: (claimFixture) => {
      const body = claimFixture.body();
      return Promise.resolve({
        command: claimFixture.command({
          campaignSlug: 'another-campaign',
          body: {
            ...body,
            draftToken: 'invalid-token-that-is-still-at-least-32-characters',
          },
        }),
      });
    },
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
    const normalizedEmail = 'taylor@example.com';
    const baseBody = fixture!.body({ incidentAnswer: 'no' });
    const result = await service.submit({
      campaignSlug: 'music-lollipop-demo-2026',
      idempotencyKey: randomUUID(),
      body: {
        ...baseBody,
        consumer: { ...baseBody.consumer, email: 'Taylor@Example.COM' },
      },
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
    expect(aggregate.consumers[0]?.emailLookupHash).toBe(await crypto.lookupHash(normalizedEmail));
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
    expect(aggregate.communications[0]?.recipientEncrypted).not.toBe(
      aggregate.consumers[0]?.emailEncrypted,
    );
    await expect(
      crypto.decrypt({
        keyVersion: aggregate.consumers[0]!.keyVersion,
        value: aggregate.consumers[0]!.emailEncrypted,
      }),
    ).resolves.toBe(normalizedEmail);
    await expect(
      crypto.decrypt({
        keyVersion: aggregate.communications[0]!.recipientKeyVersion,
        value: aggregate.communications[0]!.recipientEncrypted,
      }),
    ).resolves.toBe(normalizedEmail);
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

  it('atomically recycles an expired Idempotency-Key for a new Draft', async () => {
    const service = new DrizzleCaseService(handle!, crypto);
    const idempotencyKey = randomUUID();
    const keyHash = await crypto.lookupHash(idempotencyKey);
    const first = await service.submit(fixture!.command({ idempotencyKey }));
    await handle!.db
      .update(idempotencyRecords)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(
        and(
          eq(idempotencyRecords.endpoint, '/v1/recall-campaigns/music-lollipop-demo-2026/claims'),
          eq(idempotencyRecords.keyHash, keyHash),
        ),
      );
    const secondFixture = await createClaimFixture(handle!);

    try {
      const second = await service.submit(secondFixture.command({ idempotencyKey }));

      expect(second.caseReference).not.toBe(first.caseReference);
      await expect(countCasesForDraft(handle!, fixture!.draftId)).resolves.toBe(1);
      await expect(countCasesForDraft(handle!, secondFixture.draftId)).resolves.toBe(1);
      const records = await handle!.db
        .select({ caseId: idempotencyRecords.caseId, expiresAt: idempotencyRecords.expiresAt })
        .from(idempotencyRecords)
        .where(
          and(
            eq(idempotencyRecords.endpoint, '/v1/recall-campaigns/music-lollipop-demo-2026/claims'),
            eq(idempotencyRecords.keyHash, keyHash),
          ),
        );
      expect(records).toHaveLength(1);
      expect(records[0]?.caseId).toBe((await loadAggregate(handle!, second.caseReference)).case.id);
      expect(records[0]!.expiresAt.getTime()).toBeGreaterThan(Date.now());
    } finally {
      await cleanupClaimFixture(handle!, secondFixture);
    }
  });

  it('allows exactly one concurrent winner when recycling an expired Idempotency-Key', async () => {
    const idempotencyKey = randomUUID();
    const keyHash = await crypto.lookupHash(idempotencyKey);
    await new DrizzleCaseService(handle!, crypto).submit(fixture!.command({ idempotencyKey }));
    await handle!.db
      .update(idempotencyRecords)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(
        and(
          eq(idempotencyRecords.endpoint, '/v1/recall-campaigns/music-lollipop-demo-2026/claims'),
          eq(idempotencyRecords.keyHash, keyHash),
        ),
      );
    const secondFixture = await createClaimFixture(handle!);
    const thirdFixture = await createClaimFixture(handle!);
    const transactionGate = createFailSafeGate(2);
    const service = new DrizzleCaseService(
      withTransactionBarrier(handle!, transactionGate),
      crypto,
    );

    try {
      const results = await Promise.allSettled([
        runGateParticipant(
          () => service.submit(secondFixture.command({ idempotencyKey })),
          [transactionGate],
        ),
        runGateParticipant(
          () => service.submit(thirdFixture.command({ idempotencyKey })),
          [transactionGate],
        ),
      ]);
      const fulfilled = results.filter((result) => result.status === 'fulfilled');
      const rejected = results.filter((result) => result.status === 'rejected');

      expect(transactionGate.arrivals).toBe(2);
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect(rejected[0]?.reason).toBeInstanceOf(ClaimConflictError);
      expect(
        (await countCasesForDraft(handle!, secondFixture.draftId)) +
          (await countCasesForDraft(handle!, thirdFixture.draftId)),
      ).toBe(1);
      const records = await handle!.db
        .select({ id: idempotencyRecords.id })
        .from(idempotencyRecords)
        .where(
          and(
            eq(idempotencyRecords.endpoint, '/v1/recall-campaigns/music-lollipop-demo-2026/claims'),
            eq(idempotencyRecords.keyHash, keyHash),
          ),
        );
      expect(records).toHaveLength(1);
    } finally {
      transactionGate.fail();
      await cleanupClaimFixture(handle!, secondFixture);
      await cleanupClaimFixture(handle!, thirdFixture);
    }
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

  it('scopes one Idempotency-Key independently across two Campaign endpoints', async () => {
    const temporaryCampaign = await createTemporaryCampaign();
    const secondFixture = await createClaimFixture(handle!, {
      campaignSlug: temporaryCampaign.slug,
      productId: temporaryCampaign.productId,
    });
    const idempotencyKey = randomUUID();
    const service = new DrizzleCaseService(handle!, crypto);

    try {
      const first = await service.submit(fixture!.command({ idempotencyKey }));
      const second = await service.submit(secondFixture.command({ idempotencyKey }));
      const firstAggregate = await loadAggregate(handle!, first.caseReference);
      const secondAggregate = await loadAggregate(handle!, second.caseReference);

      expect(first.caseReference).not.toBe(second.caseReference);
      expect(firstAggregate.idempotency[0]?.endpoint).toBe(
        '/v1/recall-campaigns/music-lollipop-demo-2026/claims',
      );
      expect(secondAggregate.idempotency[0]?.endpoint).toBe(
        `/v1/recall-campaigns/${temporaryCampaign.slug}/claims`,
      );
      expect(firstAggregate.outbox).toHaveLength(1);
      expect(secondAggregate.outbox).toHaveLength(1);
      expect(firstAggregate.outbox[0]?.deduplicationKey).not.toBe(
        secondAggregate.outbox[0]?.deduplicationKey,
      );
    } finally {
      await cleanupClaimFixture(handle!, secondFixture);
      await temporaryCampaign.cleanup();
    }
  });

  it('returns a Claim conflict when a submitted Draft is retried with a new key', async () => {
    const service = new DrizzleCaseService(handle!, crypto);
    await service.submit(fixture!.command({ idempotencyKey: randomUUID() }));

    await expect(
      service.submit(fixture!.command({ idempotencyKey: randomUUID() })),
    ).rejects.toBeInstanceOf(ClaimConflictError);
    await expect(countCasesForDraft(handle!, fixture!.draftId)).resolves.toBe(1);
  });

  it('never marks a Document for deletion after Claim association wins the Draft lock', async () => {
    const claimPause = createBoundedPause();
    let deletionEnteredResolve!: () => void;
    let deletionEnteredReject!: (error: Error) => void;
    let deletionEntered = false;
    const deletionStarted = new Promise<void>((resolve, reject) => {
      deletionEnteredResolve = resolve;
      deletionEnteredReject = reject;
    });
    void deletionStarted.catch(() => undefined);
    const notifyDeletionEntered = (): void => {
      if (deletionEntered) return;
      deletionEntered = true;
      deletionEnteredResolve();
    };
    const deletionTimeout = setTimeout(() => {
      if (!deletionEntered) deletionEnteredReject(new Error(CONCURRENT_GATE_TIMEOUT_MESSAGE));
    }, 1000);
    const observedTransaction: DatabaseHandle['transaction'] = (work) => {
      notifyDeletionEntered();
      return handle!.transaction(work);
    };
    const documentService = new DrizzleDocumentService(
      handle!.db,
      new NotImplementedPrivateBlobAdapter(),
      observedTransaction,
    );
    const claimService = new DrizzleCaseService(handle!, crypto, undefined, claimPause.wait);

    await new DrizzleClaimDraftService(handle!.db).assertActive(
      fixture!.draftId,
      fixture!.draftToken,
    );
    const claim = claimService.submit(fixture!.command());
    try {
      await claimPause.entered;
      const deletion = documentService.scheduleDraftDocumentDeletion(
        fixture!.draftId,
        fixture!.documentIds[0]!,
        fixture!.draftToken,
      );
      await deletionStarted;
      claimPause.release();

      const [claimResult, deletionResult] = await Promise.allSettled([claim, deletion]);
      expect(claimResult.status).toBe('fulfilled');
      expect(deletionResult.status).toBe('rejected');
      if (deletionResult.status !== 'rejected') {
        throw new Error('Expected deletion to reject after Claim association.');
      }
      expect(deletionResult.reason).toBeInstanceOf(DraftExpiredOrInvalidError);
      const [document] = await handle!.db
        .select({
          draftId: documentUploads.draftId,
          caseId: documentUploads.caseId,
          uploadStatus: documentUploads.uploadStatus,
        })
        .from(documentUploads)
        .where(eq(documentUploads.id, fixture!.documentIds[0]!));
      expect(document).toMatchObject({
        draftId: null,
        uploadStatus: 'linked',
      });
      expect(document?.caseId).not.toBeNull();
    } finally {
      clearTimeout(deletionTimeout);
      claimPause.release();
    }
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
    expect(rejected[0]?.reason).toBeInstanceOf(ClaimConflictError);
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

  it('persists a manual-review Product result and routes the Case to triage', async () => {
    const lotId = randomUUID();
    const body = fixture!.body();
    await handle!.db.insert(campaignProductLots).values({
      id: lotId,
      campaignProductId: body.products[0]!.campaignProductId,
      lotCode: `MANUAL-${lotId.slice(0, 8)}`,
      dateCode: '08/2026',
      eligibilityStatus: 'manual_review',
    });

    try {
      const result = await new DrizzleCaseService(handle!, crypto).submit(
        fixture!.command({
          body: {
            ...body,
            products: [
              {
                ...body.products[0]!,
                lotCode: `MANUAL-${lotId.slice(0, 8)}`,
                dateCode: '08/2026',
              },
            ],
          },
        }),
      );
      const aggregate = await loadAggregate(handle!, result.caseReference);

      expect(aggregate.case.status).toBe('triage');
      expect(aggregate.products).toHaveLength(1);
      expect(aggregate.products[0]?.checkResult).toBe('manual_review');
    } finally {
      await handle!.db.delete(campaignProductLots).where(eq(campaignProductLots.id, lotId));
    }
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
    const forcedReference = uniqueCaseReference();
    const deduplicationKey = `claim-confirmation:${forcedReference}`;
    await handle!.db.insert(outboxEvents).values({
      aggregateType: 'test',
      aggregateId: randomUUID(),
      eventType: 'test.conflict',
      deduplicationKey,
      payload: {},
    });

    try {
      await expect(
        new DrizzleCaseService(handle!, crypto, () => forcedReference).submit(command),
      ).rejects.toMatchObject({ cause: { code: '23505' } });
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
