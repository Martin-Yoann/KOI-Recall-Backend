// Opt-in integration test for the escalation status (P0-B phase 2).
//
// Phase 1 taught every read path what `escalated` means; nothing wrote it. Phase 2 is
// the write, behind a switch that defaults to off so a deployed backend never writes a
// value older readers have not been taught yet. These cases pin both positions of that
// switch — the wiring, not just the comparison — plus the submission that must not
// change at all.
import 'dotenv/config';

import { randomUUID } from 'node:crypto';

import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createDatabase, type DatabaseHandle } from '../src/db/client.js';
import { DrizzleCaseService } from '../src/modules/cases/drizzle-case-service.js';
import { DrizzleCommunicationQueueService } from '../src/modules/communications/queue-service.js';
import { NodeSensitiveDataCrypto } from '../src/platform/crypto/node-sensitive-data-crypto.js';
import { assertLocalIntegrationDatabase } from './helpers/db-guard.js';
import {
  cleanupClaimFixture,
  createClaimFixture,
  loadAggregate,
  type ClaimFixture,
} from './helpers/case-fixture.js';

assertLocalIntegrationDatabase(process.env.DATABASE_URL);

const enabled = process.env.RUN_DB_INTEGRATION === 'true' && Boolean(process.env.DATABASE_URL);
const handle: DatabaseHandle | null = enabled
  ? createDatabase(process.env.DATABASE_URL as string)
  : null;

const CAMPAIGN_SLUG = 'music-lollipop-demo-2026';
const crypto = new NodeSensitiveDataCrypto(
  Buffer.alloc(32, 5).toString('base64'),
  Buffer.alloc(32, 6).toString('base64'),
);

/** A reported injury: an `unsure` answer would stay in triage, and that is deliberate. */
const INJURY = {
  narrative: 'The handle detached while my niece was unwrapping the lollipop and cut her finger.',
  occurredDateUnknown: true,
} as const;

describe.skipIf(!enabled)(
  'escalation status on submission (database integration)',
  { timeout: 180_000 },
  () => {
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

    /** The same construction the registry uses, with the phase-2 switch placed. */
    function serviceWith(incidentEscalatedStatus: boolean) {
      return new DrizzleCaseService(
        handle!,
        crypto,
        undefined,
        undefined,
        undefined,
        false,
        new DrizzleCommunicationQueueService(),
        false,
        incidentEscalatedStatus,
      );
    }

    it('starts a reported injury in escalated when the switch is on', async () => {
      const result = await serviceWith(true).submit({
        campaignSlug: CAMPAIGN_SLUG,
        idempotencyKey: randomUUID(),
        body: fixture!.body({ incidentAnswer: 'yes', incidentDetails: INJURY }),
      });

      const aggregate = await loadAggregate(handle!, result.caseReference);
      expect(aggregate.case.status).toBe('escalated');
      expect(aggregate.case.subtype).toBe('injury_hazard');
      expect(aggregate.case.incidentFlag).toBe(true);
      expect(aggregate.incidents).toHaveLength(1);
      expect(aggregate.reviews).toHaveLength(1);
      expect(aggregate.reviews[0]!.status).toBe('pending');
    });

    it('starts the same submission in submitted when the switch is off', async () => {
      // The control. Same payload, same code path: the only difference is the switch,
      // which is what makes the case above evidence about the switch rather than about
      // incident submissions in general.
      const result = await serviceWith(false).submit({
        campaignSlug: CAMPAIGN_SLUG,
        idempotencyKey: randomUUID(),
        body: fixture!.body({ incidentAnswer: 'yes', incidentDetails: INJURY }),
      });

      const aggregate = await loadAggregate(handle!, result.caseReference);
      expect(aggregate.case.status).toBe('submitted');
      expect(aggregate.case.subtype).toBe('injury_hazard');
      expect(aggregate.reviews).toHaveLength(1);
      expect(aggregate.reviews[0]!.status).toBe('pending');
    });

    it('leaves a submission with no incident alone even with the switch on', async () => {
      const result = await serviceWith(true).submit({
        campaignSlug: CAMPAIGN_SLUG,
        idempotencyKey: randomUUID(),
        body: fixture!.body({ incidentAnswer: 'no' }),
      });

      const aggregate = await loadAggregate(handle!, result.caseReference);
      expect(aggregate.case.status).toBe('submitted');
      expect(aggregate.case.subtype).toBe('standard');
      expect(aggregate.case.incidentFlag).toBe(false);
      expect(aggregate.incidents).toHaveLength(0);
      expect(aggregate.reviews).toHaveLength(0);
    });
  },
);
