// Opt-in integration test for the real database Claim write path.
// Runs only when RUN_DB_INTEGRATION=true AND DATABASE_URL is set.
import 'dotenv/config';

import { randomUUID } from 'node:crypto';

import { and, eq, inArray } from 'drizzle-orm';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createDatabase, type DatabaseHandle } from '../src/db/client.js';
import {
  campaignMessageTemplates,
  campaignRemedyOptions,
  claimDrafts,
  documentUploads,
  outboxEvents,
} from '../src/db/schema/index.js';
import { DrizzleCaseService } from '../src/modules/cases/drizzle-case-service.js';
import { NodeSensitiveDataCrypto } from '../src/platform/crypto/node-sensitive-data-crypto.js';
import {
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
    const command = fixture!.command({ idempotencyKey });
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
