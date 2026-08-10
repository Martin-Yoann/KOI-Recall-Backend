import { randomUUID } from 'node:crypto';

import { eq, inArray } from 'drizzle-orm';

import type { ClaimSubmissionRequest } from '../../src/contracts/toc.js';
import type { DatabaseHandle } from '../../src/db/client.js';
import {
  caseConsents,
  caseConsumers,
  caseEvents,
  claimedProducts,
  claimDrafts,
  communications,
  documentUploads,
  idempotencyRecords,
  incidents,
  outboxEvents,
  recallCases,
  reportabilityReviews,
  submissionSnapshots,
} from '../../src/db/schema/index.js';
import { DrizzleClaimDraftService } from '../../src/modules/claim-drafts/drizzle-claim-draft-service.js';
import type { ClaimSubmissionCommand } from '../../src/modules/cases/service.js';

const CAMPAIGN_SLUG = 'music-lollipop-demo-2026';
const PRODUCT_ID = '5e41d8b9-03c4-46d4-9b87-80c40cdfbde5';

export interface ClaimFixture {
  draftId: string;
  draftToken: string;
  documentIds: string[];
  body(overrides?: Partial<ClaimSubmissionRequest>): ClaimSubmissionRequest;
  command(overrides?: Partial<ClaimSubmissionCommand>): ClaimSubmissionCommand;
}

export interface ClaimFixtureOptions {
  campaignSlug?: string;
  productId?: string;
}

export async function createClaimFixture(
  handle: DatabaseHandle,
  options: ClaimFixtureOptions = {},
): Promise<ClaimFixture> {
  const campaignSlug = options.campaignSlug ?? CAMPAIGN_SLUG;
  const productId = options.productId ?? PRODUCT_ID;
  const draft = await new DrizzleClaimDraftService(handle.db).create(campaignSlug);
  if (!draft) throw new Error('Seeded Campaign is required for Claim integration tests.');

  const documentIds = [randomUUID(), randomUUID()];
  const expiresAt = new Date(Date.now() + 60 * 60 * 1000);
  try {
    await handle.db.insert(documentUploads).values([
      {
        id: documentIds[0],
        draftId: draft.draftId,
        category: 'product_photo',
        categorySlot: 1,
        storagePathname: `tests/${draft.draftId}/${documentIds[0]}/product.jpg`,
        originalFileName: 'product.jpg',
        declaredMimeType: 'image/jpeg',
        detectedMimeType: 'image/jpeg',
        sizeBytes: 1024,
        sha256: 'a'.repeat(64),
        uploadStatus: 'verified',
        scanStatus: 'clean',
        uploadedAt: new Date(),
        expiresAt,
      },
      {
        id: documentIds[1],
        draftId: draft.draftId,
        category: 'proof_of_purchase',
        categorySlot: 1,
        storagePathname: `tests/${draft.draftId}/${documentIds[1]}/receipt.pdf`,
        originalFileName: 'receipt.pdf',
        declaredMimeType: 'application/pdf',
        detectedMimeType: 'application/pdf',
        sizeBytes: 2048,
        sha256: 'b'.repeat(64),
        uploadStatus: 'verified',
        scanStatus: 'clean',
        uploadedAt: new Date(),
        expiresAt,
      },
    ]);
  } catch (error) {
    await handle.db.delete(claimDrafts).where(eq(claimDrafts.id, draft.draftId));
    throw error;
  }

  const body = (overrides: Partial<ClaimSubmissionRequest> = {}): ClaimSubmissionRequest => ({
    draftId: draft.draftId,
    draftToken: draft.draftToken,
    locale: 'en-US',
    consumer: {
      firstName: 'Taylor',
      lastName: 'Example',
      email: 'taylor@example.com',
      phone: '+1-555-010-2026',
      currentDeliveryAddress: {
        line1: '100 Example Street',
        line2: 'Unit 4',
        city: 'Austin',
        state: 'TX',
        postalCode: '78701',
        countryCode: 'US',
      },
    },
    products: [
      {
        campaignProductId: productId,
        quantity: 1,
        shape: 'Bear',
        flavor: 'Peach',
        lotCode: 'ML-2406-A',
        dateCode: '06/2024',
        identificationMode: 'product_identifiers',
        purchaseChannel: 'amazon',
        purchaseDate: '2026-07-15',
        orderNumber: 'ORDER-10001',
      },
    ],
    remedyCode: 'replacement',
    documentIds: [...documentIds],
    consents: [
      { type: 'privacy_notice', textVersion: '2026-08-04', accepted: true },
      { type: 'information_accuracy', textVersion: '2026-08-04', accepted: true },
    ],
    incidentAnswer: 'no',
    ...overrides,
  });

  const command = (overrides: Partial<ClaimSubmissionCommand> = {}): ClaimSubmissionCommand => ({
    campaignSlug,
    idempotencyKey: randomUUID(),
    body: body(),
    ...overrides,
  });

  return {
    draftId: draft.draftId,
    draftToken: draft.draftToken,
    documentIds,
    body,
    command,
  };
}

export async function loadAggregate(handle: DatabaseHandle, caseReference: string) {
  const [caseRow] = await handle.db
    .select()
    .from(recallCases)
    .where(eq(recallCases.publicReference, caseReference))
    .limit(1);
  if (!caseRow) throw new Error(`Case ${caseReference} was not found.`);

  const caseId = caseRow.id;
  const [
    draftRows,
    consumers,
    products,
    documents,
    consents,
    snapshots,
    incidentRows,
    events,
    communicationRows,
    outbox,
    idempotency,
  ] = await Promise.all([
    handle.db.select().from(claimDrafts).where(eq(claimDrafts.submittedCaseId, caseId)),
    handle.db.select().from(caseConsumers).where(eq(caseConsumers.caseId, caseId)),
    handle.db.select().from(claimedProducts).where(eq(claimedProducts.caseId, caseId)),
    handle.db.select().from(documentUploads).where(eq(documentUploads.caseId, caseId)),
    handle.db.select().from(caseConsents).where(eq(caseConsents.caseId, caseId)),
    handle.db.select().from(submissionSnapshots).where(eq(submissionSnapshots.caseId, caseId)),
    handle.db.select().from(incidents).where(eq(incidents.caseId, caseId)),
    handle.db.select().from(caseEvents).where(eq(caseEvents.caseId, caseId)),
    handle.db.select().from(communications).where(eq(communications.caseId, caseId)),
    handle.db.select().from(outboxEvents).where(eq(outboxEvents.aggregateId, caseId)),
    handle.db.select().from(idempotencyRecords).where(eq(idempotencyRecords.caseId, caseId)),
  ]);
  const reviews =
    incidentRows.length > 0
      ? await handle.db
          .select()
          .from(reportabilityReviews)
          .where(
            inArray(
              reportabilityReviews.incidentId,
              incidentRows.map((incident) => incident.id),
            ),
          )
      : [];

  return {
    case: caseRow,
    draft: draftRows[0],
    consumers,
    products,
    documents,
    consents,
    snapshots,
    incidents: incidentRows,
    reviews,
    events,
    communications: communicationRows,
    outbox,
    idempotency,
  };
}

export async function countCasesForDraft(handle: DatabaseHandle, draftId: string): Promise<number> {
  const [draft] = await handle.db
    .select({ submittedCaseId: claimDrafts.submittedCaseId })
    .from(claimDrafts)
    .where(eq(claimDrafts.id, draftId))
    .limit(1);
  if (!draft?.submittedCaseId) return 0;

  const rows = await handle.db
    .select({ id: recallCases.id })
    .from(recallCases)
    .where(eq(recallCases.id, draft.submittedCaseId));
  return rows.length;
}

export async function loadDraftStatus(
  handle: DatabaseHandle,
  draftId: string,
): Promise<(typeof claimDrafts.$inferSelect)['status'] | null> {
  const [draft] = await handle.db
    .select({ status: claimDrafts.status })
    .from(claimDrafts)
    .where(eq(claimDrafts.id, draftId))
    .limit(1);
  return draft?.status ?? null;
}

export async function cleanupClaimFixture(
  handle: DatabaseHandle,
  fixture: ClaimFixture,
): Promise<void> {
  const [draft] = await handle.db
    .select({ submittedCaseId: claimDrafts.submittedCaseId })
    .from(claimDrafts)
    .where(eq(claimDrafts.id, fixture.draftId))
    .limit(1);
  const caseIds = draft?.submittedCaseId ? [draft.submittedCaseId] : [];

  if (caseIds.length > 0) {
    const incidentRows = await handle.db
      .select({ id: incidents.id })
      .from(incidents)
      .where(inArray(incidents.caseId, caseIds));
    await handle.db.delete(idempotencyRecords).where(inArray(idempotencyRecords.caseId, caseIds));
    await handle.db.delete(outboxEvents).where(inArray(outboxEvents.aggregateId, caseIds));
    await handle.db.delete(communications).where(inArray(communications.caseId, caseIds));
    await handle.db.delete(caseEvents).where(inArray(caseEvents.caseId, caseIds));
    if (incidentRows.length > 0) {
      await handle.db.delete(reportabilityReviews).where(
        inArray(
          reportabilityReviews.incidentId,
          incidentRows.map((incident) => incident.id),
        ),
      );
    }
    await handle.db.delete(incidents).where(inArray(incidents.caseId, caseIds));
    await handle.db.delete(submissionSnapshots).where(inArray(submissionSnapshots.caseId, caseIds));
    await handle.db.delete(caseConsents).where(inArray(caseConsents.caseId, caseIds));
    await handle.db.delete(claimedProducts).where(inArray(claimedProducts.caseId, caseIds));
    await handle.db.delete(caseConsumers).where(inArray(caseConsumers.caseId, caseIds));
  }

  await handle.db.delete(documentUploads).where(inArray(documentUploads.id, fixture.documentIds));
  if (caseIds.length > 0) {
    await handle.db.delete(recallCases).where(inArray(recallCases.id, caseIds));
  }
  await handle.db.delete(claimDrafts).where(eq(claimDrafts.id, fixture.draftId));
}
