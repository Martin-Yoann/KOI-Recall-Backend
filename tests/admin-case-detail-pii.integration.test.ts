import { assertLocalIntegrationDatabase } from './helpers/db-guard.js';
// Opt-in integration test for the admin case-detail read path when stored PII
// cannot be decrypted. Runs only when RUN_DB_INTEGRATION=true AND DATABASE_URL
// is set.
//
// This is the regression guard for a real outage: rows written into the shared
// database by an integration run (which constructs its own throwaway
// `Buffer.alloc` key) were unreadable by the application's key, and a single
// such row made every case-detail read answer 500 — one unreadable consumer
// took down the whole case view. The read must instead succeed and say plainly
// that the details are unreadable, which is not the same as the consumer
// leaving them blank.
import 'dotenv/config';

import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { ClaimSubmissionRequest } from '../src/contracts/toc.js';
import { createDatabase, type DatabaseHandle } from '../src/db/client.js';
import { DrizzleAdminService } from '../src/modules/admin/drizzle-admin-service.js';
import { DrizzleCaseService } from '../src/modules/cases/drizzle-case-service.js';
import { DrizzleCommunicationQueueService } from '../src/modules/communications/queue-service.js';
import { NodeSensitiveDataCrypto } from '../src/platform/crypto/node-sensitive-data-crypto.js';
import {
  cleanupClaimFixture,
  createClaimFixture,
  type ClaimFixture,
} from './helpers/case-fixture.js';

const enabled = process.env.RUN_DB_INTEGRATION === 'true' && Boolean(process.env.DATABASE_URL);

assertLocalIntegrationDatabase(process.env.DATABASE_URL);
const handle: DatabaseHandle | null = enabled
  ? createDatabase(process.env.DATABASE_URL as string)
  : null;

const PEPPER = Buffer.alloc(32, 2).toString('base64');
/** The key the Claim write path uses — what the fixture's rows are encrypted with. */
const writerCrypto = new NodeSensitiveDataCrypto(Buffer.alloc(32, 1).toString('base64'), PEPPER);
/** A different key, standing in for another environment or a rotated key. */
const foreignCrypto = new NodeSensitiveDataCrypto(Buffer.alloc(32, 7).toString('base64'), PEPPER);

const communicationQueue = new DrizzleCommunicationQueueService();

// The Neon round trips alone exceed the default budget: an abandoned attempt
// leaves a submitted case behind, because the fixture cleanup runs before the
// in-flight submission has recorded its case id.
describe.skipIf(!enabled)(
  'Admin case detail with unreadable consumer PII',
  { timeout: 120_000 },
  () => {
    let fixture: ClaimFixture | null = null;

    beforeEach(async () => {
      fixture = await createClaimFixture(handle!);
    });

    afterEach(async () => {
      if (fixture) await cleanupClaimFixture(handle!, fixture);
      fixture = null;
    });

    afterAll(async () => {
      await handle?.close();
    });

    const submitClaim = async (
      bodyOverrides: Partial<ClaimSubmissionRequest> = {},
    ): Promise<string> => {
      const service = new DrizzleCaseService(
        handle!,
        writerCrypto,
        undefined,
        undefined,
        undefined,
        false,
        communicationQueue,
      );
      const result = await service.submit(fixture!.command({ body: fixture!.body(bodyOverrides) }));
      return result.caseReference;
    };

    const adminService = (crypto: NodeSensitiveDataCrypto) =>
      new DrizzleAdminService({
        db: handle!.db,
        crypto,
        consumerWebBaseUrl: 'https://example.test',
      });

    it('returns the case with an explicit unreadable marker instead of failing the read', async () => {
      const caseReference = await submitClaim();

      const detail = await adminService(foreignCrypto).getCaseDetail({
        caseReference,
        viewerRole: 'MANAGER',
        piiLevel: 'masked',
      });

      // The read itself must succeed: the non-PII facts are what a reviewer works
      // from, and losing them to one unreadable row is the outage this guards.
      expect(detail).not.toBeNull();
      expect(detail!.caseReference).toBe(caseReference);
      expect(detail!.status).toBe('submitted');

      // ... and the consumer block must be honest rather than blank.
      expect(detail!.consumer.piiUnavailable).toBe(true);
      expect(detail!.consumer.firstName).toBeUndefined();
      expect(detail!.consumer.lastName).toBeUndefined();
      expect(detail!.consumer.email).toBeUndefined();
      expect(detail!.consumer.phone).toBeUndefined();
    });

    it('still renders masked PII when the key matches', async () => {
      const caseReference = await submitClaim();

      const detail = await adminService(writerCrypto).getCaseDetail({
        caseReference,
        viewerRole: 'MANAGER',
        piiLevel: 'masked',
      });

      // Guards against over-degrading: the readable path must not have been
      // turned into "unavailable" by the resilience added above.
      expect(detail).not.toBeNull();
      expect(detail!.consumer.piiUnavailable).toBeFalsy();
      expect(detail!.consumer.firstName).toBeTruthy();
      expect(detail!.consumer.email).toBeTruthy();
    });

    it('reports unreadable raw-tier incident detail without failing the read', async () => {
      // An incident is the only way to reach the raw-tier narrative columns, and
      // the contract requires details alongside a non-"no" answer.
      const caseReference = await submitClaim({
        incidentAnswer: 'yes',
        incidentDetails: {
          narrative: 'The handle separated from the candy while it was being eaten.',
          occurredDateUnknown: true,
        },
      });

      const detail = await adminService(foreignCrypto).getCaseDetail({
        caseReference,
        viewerRole: 'MANAGER',
        piiLevel: 'raw',
      });

      expect(detail).not.toBeNull();
      expect(detail!.incident).not.toBeNull();
      expect(detail!.incident!.piiUnavailable).toBe(true);
      expect(detail!.incident!.narrative).toBeUndefined();
    });
  },
);
