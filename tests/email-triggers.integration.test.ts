// Opt-in integration test for the consumer-email touchpoints 02 / 04 / 05 /
// 06 / 07 / 08. Runs only when RUN_DB_INTEGRATION=true AND DATABASE_URL is set.
import 'dotenv/config';

import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createDatabase, type DatabaseHandle } from '../src/db/client.js';
import { communications, staffUsers, templateVersions } from '../src/db/schema/index.js';
import { DrizzleAdminService } from '../src/modules/admin/drizzle-admin-service.js';
import { DrizzleCaseService } from '../src/modules/cases/drizzle-case-service.js';
import { EmailTriggerService } from '../src/modules/communications/email-trigger-service.js';
import { DrizzleCommunicationQueueService } from '../src/modules/communications/queue-service.js';
import { DrizzleCaseResolutionService } from '../src/modules/resolutions/drizzle-case-resolution-service.js';
import { NodeSensitiveDataCrypto } from '../src/platform/crypto/node-sensitive-data-crypto.js';
import {
  cleanupClaimFixture,
  createClaimFixture,
  loadAggregate,
  type ClaimFixture,
} from './helpers/case-fixture.js';

const enabled = process.env.RUN_DB_INTEGRATION === 'true' && Boolean(process.env.DATABASE_URL);
const handle: DatabaseHandle | null = enabled
  ? createDatabase(process.env.DATABASE_URL as string)
  : null;
const crypto = new NodeSensitiveDataCrypto(
  Buffer.alloc(32, 3).toString('base64'),
  Buffer.alloc(32, 4).toString('base64'),
);

const STAFF_ID = '33333333-3333-4333-8333-333333333333';
const WEB_BASE_URL = 'https://web.example';

/**
 * Fallback template rows (version 1) so the trigger path resolves a version in
 * any database. `onConflictDoNothing` guarantees the real seeded templates are
 * never overwritten; `setup-templates.ts` still owns the production copy.
 */
const FALLBACK_TEMPLATES: ReadonlyArray<{ templateKey: string; body: string }> = [
  { templateKey: 'need_info', body: '{{requestedInformation}} {{actionUrl}}' },
  { templateKey: 'claim_rejected', body: '{{reason}}' },
  {
    templateKey: 'refund_completed',
    body: '{{refundAmount}} {{refundCurrency}} {{referenceLine}}',
  },
  { templateKey: 'shipment_shipped', body: '{{trackingNumber}}' },
  { templateKey: 'case_completed', body: '{{completedResolutionLabel}}' },
  { templateKey: 'case_closed', body: '{{closureReason}}' },
];

// Remote (Neon) runs pay network latency on every statement, so the default
// 5s test timeout is not enough; the suite raises both test and hook budgets.
describe.skipIf(!enabled)(
  'consumer email touchpoints (real database)',
  { timeout: 180_000 },
  () => {
    let fixture: ClaimFixture | null = null;
    let caseReference: string;
    let caseId: string;
    let admin: DrizzleAdminService;
    let resolutions: DrizzleCaseResolutionService;

    beforeAll(async () => {
      await handle!.db
        .insert(templateVersions)
        .values(
          FALLBACK_TEMPLATES.map(({ templateKey, body }) => ({
            templateKey,
            locale: 'en-US',
            version: 1,
            subject: `${templateKey} {{caseReference}}`,
            htmlBody: `<p>${body}</p>`,
            textBody: body,
          })),
        )
        .onConflictDoNothing();
      // Resolution approval/audit rows reference a real staff user.
      await handle!.db
        .insert(staffUsers)
        .values({
          id: STAFF_ID,
          emailLookupHash: `test-${STAFF_ID}`,
          email: 'touchpoint-reviewer@example.com',
          displayName: 'Touchpoint Reviewer',
          role: 'ADMIN',
        })
        .onConflictDoNothing();
    }, 60_000);

    beforeEach(async () => {
      fixture = await createClaimFixture(handle!);
      const communicationQueue = new DrizzleCommunicationQueueService();
      const emailTrigger = new EmailTriggerService(communicationQueue);
      const submitted = await new DrizzleCaseService(
        handle!,
        crypto,
        new DrizzleCaseResolutionService(handle!, crypto, emailTrigger),
        undefined,
        undefined,
        false,
        communicationQueue,
      ).submit(fixture.command());
      caseReference = submitted.caseReference;
      caseId = (await loadAggregate(handle!, caseReference)).case.id;

      resolutions = new DrizzleCaseResolutionService(handle!, crypto, emailTrigger);
      admin = new DrizzleAdminService(
        handle!.db,
        crypto,
        resolutions,
        undefined,
        emailTrigger,
        WEB_BASE_URL,
      );
    }, 60_000);

    afterEach(async () => {
      if (fixture) await cleanupClaimFixture(handle!, fixture);
      fixture = null;
    }, 60_000);

    afterAll(async () => {
      await handle!.db.delete(staffUsers).where(eq(staffUsers.id, STAFF_ID));
      await handle?.close();
    }, 60_000);

    it('02 — enqueues the action-required email with the instruction and secure link', async () => {
      await admin.transitionCaseStatus(caseReference, 'under_review', STAFF_ID);
      await admin.transitionCaseStatus(
        caseReference,
        'need_info',
        STAFF_ID,
        'Please send a photo of the lot code.',
      );

      const aggregate = await loadAggregate(handle!, caseReference);
      const communication = aggregate.communications.find((row) =>
        row.messageKey.startsWith('case-action-required:'),
      );
      expect(communication).toBeDefined();

      const outbox = aggregate.outbox.find(
        (event) => event.deduplicationKey === communication!.messageKey,
      );
      expect(outbox?.eventType).toBe('case.action_required.requested');
      expect(outbox?.payload).toMatchObject({
        variables: {
          caseReference,
          requestedInformation: 'Please send a photo of the lot code.',
          actionUrl: `${WEB_BASE_URL}/dashboard/claims/${caseReference}`,
        },
      });
    });

    it('04 — enqueues the not-approved email with the consumer reason', async () => {
      await admin.transitionCaseStatus(
        caseReference,
        'rejected',
        STAFF_ID,
        'The product was outside the recalled lot range.',
      );

      const aggregate = await loadAggregate(handle!, caseReference);
      const communication = aggregate.communications.find((row) =>
        row.messageKey.startsWith('case-not-approved:'),
      );
      expect(communication).toBeDefined();

      const outbox = aggregate.outbox.find(
        (event) => event.deduplicationKey === communication!.messageKey,
      );
      expect(outbox?.eventType).toBe('case.not_approved.requested');
      expect(outbox?.payload).toMatchObject({
        variables: {
          caseReference,
          reason: 'The product was outside the recalled lot range.',
        },
      });
    });

    it('05 + 07 — refund completion, then closure, enqueue refund_completed then case_completed', async () => {
      await resolutions.approve({
        caseId,
        type: 'refund',
        refundAmountMinor: 1999,
        currency: 'USD',
        note: 'Approved after review of the purchase receipt.',
        expectedVersion: 1,
        actorUserId: STAFF_ID,
        actorRole: 'ADMIN',
      });
      await resolutions.recordExternalCompletion({
        caseId,
        note: 'Refund paid out via bank transfer.',
        externalReference: 'BANK-REF-77',
        expectedVersion: 2,
        actorUserId: STAFF_ID,
        actorRole: 'ADMIN',
      });

      await admin.transitionCaseStatus(caseReference, 'under_review', STAFF_ID);
      await admin.transitionCaseStatus(caseReference, 'approved', STAFF_ID);
      await admin.transitionCaseStatus(caseReference, 'closure_review', STAFF_ID);
      await admin.transitionCaseStatus(caseReference, 'closed', STAFF_ID);

      const aggregate = await loadAggregate(handle!, caseReference);

      const completion = aggregate.outbox.find(
        (event) => event.deduplicationKey === `res-complete:${caseId}`,
      );
      expect(completion?.eventType).toBe('resolution.completion.requested');
      expect(completion?.payload).toMatchObject({
        variables: {
          caseReference,
          refundAmount: '19.99',
          refundCurrency: 'USD',
          referenceLine: 'Reference: BANK-REF-77',
        },
      });

      const closureCommunication = aggregate.communications.find((row) =>
        row.messageKey.startsWith('case-completed:'),
      );
      expect(closureCommunication).toBeDefined();
      const closure = aggregate.outbox.find(
        (event) => event.deduplicationKey === closureCommunication!.messageKey,
      );
      expect(closure?.eventType).toBe('case.completed.requested');
      expect(closure?.payload).toMatchObject({
        variables: { caseReference, completedResolutionLabel: 'Refund' },
      });
    });

    it('06 — records the shipment fact, enqueues the shipped email, and replays idempotently', async () => {
      await resolutions.approve({
        caseId,
        type: 'replacement',
        note: 'Replacement approved for the recalled unit.',
        expectedVersion: 1,
        actorUserId: STAFF_ID,
        actorRole: 'ADMIN',
      });

      const shipped = await resolutions.recordShipment({
        caseId,
        trackingNumber: 'TRK-000-987',
        expectedVersion: 2,
        actorUserId: STAFF_ID,
        actorRole: 'ADMIN',
      });
      expect(shipped.trackingNumber).toBe('TRK-000-987');
      expect(shipped.shippedAt).not.toBeNull();
      expect(shipped.version).toBe(3);

      const aggregate = await loadAggregate(handle!, caseReference);
      const outbox = aggregate.outbox.find(
        (event) => event.deduplicationKey === `res-ship:${caseId}:TRK-000-987`,
      );
      expect(outbox?.eventType).toBe('replacement.shipment.requested');
      expect(outbox?.payload).toMatchObject({
        variables: { caseReference, trackingNumber: 'TRK-000-987' },
      });

      // Replaying the same shipment fact must not enqueue a second email (the
      // communication message key is unique) and must roll the version back.
      await expect(
        resolutions.recordShipment({
          caseId,
          trackingNumber: 'TRK-000-987',
          expectedVersion: 3,
          actorUserId: STAFF_ID,
          actorRole: 'ADMIN',
        }),
      ).rejects.toThrow();

      const replayed = await resolutions.getForCase(caseId);
      expect(replayed?.version).toBe(3);
      const communicationRows = await handle!.db
        .select()
        .from(communications)
        .where(eq(communications.caseId, caseId));
      expect(
        communicationRows.filter((row) => row.messageKey === `res-ship:${caseId}:TRK-000-987`),
      ).toHaveLength(1);
    });

    it('08 — withdrawn enqueues the closure email with the closure reason', async () => {
      await admin.transitionCaseStatus(
        caseReference,
        'withdrawn',
        STAFF_ID,
        'Withdrawn at the consumer request.',
      );

      const aggregate = await loadAggregate(handle!, caseReference);
      const communication = aggregate.communications.find((row) =>
        row.messageKey.startsWith('case-closed:'),
      );
      expect(communication).toBeDefined();
      const outbox = aggregate.outbox.find(
        (event) => event.deduplicationKey === communication!.messageKey,
      );
      expect(outbox?.eventType).toBe('case.closed.requested');
      expect(outbox?.payload).toMatchObject({
        variables: { caseReference, closureReason: 'Withdrawn at the consumer request.' },
      });
    });

    it('noise control — triage / under_review transitions send no email', async () => {
      await admin.transitionCaseStatus(caseReference, 'triage', STAFF_ID);
      await admin.transitionCaseStatus(caseReference, 'under_review', STAFF_ID);

      const aggregate = await loadAggregate(handle!, caseReference);
      // Only the submission-time claim_confirmation is present.
      expect(aggregate.communications).toHaveLength(1);
      expect(aggregate.communications[0]?.messageKey).toBe(`claim-confirmation:${caseReference}`);
    });
  },
);
