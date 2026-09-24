// Opt-in integration test for the escalation closure gate (P0-B).
//
// An open escalation means the case is with legal, a regulator or the media. Closing the
// case would take it back out of that conversation, so no role may do it — force
// included. That is the property these cases pin.
import 'dotenv/config';

import { randomUUID } from 'node:crypto';

import { and, eq, isNull } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDatabase, type DatabaseHandle } from '../src/db/client.js';
import {
  campaignVersions,
  caseEscalations,
  caseEvents,
  recallCases,
  staffUsers,
} from '../src/db/schema/index.js';
import { DrizzleAdminService } from '../src/modules/admin/drizzle-admin-service.js';
import { NodeSensitiveDataCrypto } from '../src/platform/crypto/node-sensitive-data-crypto.js';
import { assertLocalIntegrationDatabase } from './helpers/db-guard.js';

assertLocalIntegrationDatabase(process.env.DATABASE_URL);

const enabled = process.env.RUN_DB_INTEGRATION === 'true' && Boolean(process.env.DATABASE_URL);
const handle: DatabaseHandle | null = enabled
  ? createDatabase(process.env.DATABASE_URL as string)
  : null;

const SEEDED_CAMPAIGN_ID = '2bdac8b0-73d8-4e38-a7e2-98fd5608788a';
const crypto = new NodeSensitiveDataCrypto(
  Buffer.alloc(32, 1).toString('base64'),
  Buffer.alloc(32, 2).toString('base64'),
);

describe.skipIf(!enabled)(
  'escalation closure gate (database integration)',
  { timeout: 120_000 },
  () => {
    let admin: DrizzleAdminService;
    let staffUserId: string;
    let campaignVersionId: string;

    beforeAll(async () => {
      admin = new DrizzleAdminService({
        db: handle!.db,
        crypto,
        consumerWebBaseUrl: 'https://example.test',
      });
      const [staff] = await handle!.db.select({ id: staffUsers.id }).from(staffUsers).limit(1);
      const [version] = await handle!.db
        .select({ id: campaignVersions.id })
        .from(campaignVersions)
        .limit(1);
      if (!staff || !version) throw new Error('Seed data is required.');
      staffUserId = staff.id;
      campaignVersionId = version.id;
    });

    afterAll(async () => {
      await handle?.close();
    });

    /** A bare case: the gate is about escalations, not about the rest of the workflow. */
    async function makeCase() {
      const publicReference = `KOI-ESC1-${randomUUID().replace(/-/g, '').slice(0, 8).toUpperCase()}`;
      const [row] = await handle!.db
        .insert(recallCases)
        .values({
          publicReference,
          campaignId: SEEDED_CAMPAIGN_ID,
          campaignVersionId,
          locale: 'en-US',
        })
        .returning({ id: recallCases.id });
      return { caseId: row!.id, publicReference };
    }

    async function openEscalation(caseId: string, category: 'legal' | 'regulator' = 'legal') {
      const [row] = await handle!.db
        .insert(caseEscalations)
        .values({
          caseId,
          category,
          reason: 'Counsel asked for the file to be held while they review it.',
          openedByStaffUserId: staffUserId,
        })
        .returning({ id: caseEscalations.id });
      return row!.id;
    }

    it('refuses to close a case with an open escalation, force included', async () => {
      const { caseId, publicReference } = await makeCase();
      const escalationId = await openEscalation(caseId);

      // `bypassWorkflow` is the ADMIN force path. The gate sits outside it, so force
      // must fail exactly as the ordinary path does.
      await expect(
        admin.transitionCaseStatus(
          publicReference,
          'closed',
          staffUserId,
          'Closing during an escalation gate test.',
          true,
        ),
      ).rejects.toThrow(/open escalation/i);

      await handle!.db.delete(caseEscalations).where(eq(caseEscalations.id, escalationId));
      await handle!.db.delete(recallCases).where(eq(recallCases.id, caseId));
    });

    it('stops being about the escalation once it is closed', async () => {
      const { caseId, publicReference } = await makeCase();
      const escalationId = await openEscalation(caseId, 'regulator');

      // Closing the escalation records what closed it — the schema refuses a closure
      // with nothing behind it, so this is the only way to reach the state.
      await handle!.db
        .update(caseEscalations)
        .set({
          closedAt: new Date(),
          closedByStaffUserId: staffUserId,
          closureEvidence: 'Regulator confirmed by email that no further action is needed.',
          updatedAt: new Date(),
        })
        .where(eq(caseEscalations.id, escalationId));

      const [stillOpen] = await handle!.db
        .select({ id: caseEscalations.id })
        .from(caseEscalations)
        .where(and(eq(caseEscalations.caseId, caseId), isNull(caseEscalations.closedAt)));
      expect(stillOpen).toBeUndefined();

      // The transition may still be refused — a fresh case is not at closure_review —
      // but not for this reason, which is what shows the gate is about open escalations
      // rather than about the case having had one.
      const refusal = await admin
        .transitionCaseStatus(
          publicReference,
          'closed',
          staffUserId,
          'Closing after the escalation was closed.',
          true,
        )
        .then(
          () => null,
          (error: unknown) => (error instanceof Error ? error.message : String(error)),
        );
      // The differential: with the escalation open the same call is refused; with it
      // closed the same call goes through. So the gate is about open escalations, not
      // about a case having had one.
      expect(refusal).toBeNull();

      // The transition wrote a case event, which is why the case cannot simply be
      // deleted — the same ordering the claim fixtures use.
      await handle!.db.delete(caseEvents).where(eq(caseEvents.caseId, caseId));
      await handle!.db.delete(caseEscalations).where(eq(caseEscalations.id, escalationId));
      await handle!.db.delete(recallCases).where(eq(recallCases.id, caseId));
    });
  },
);
