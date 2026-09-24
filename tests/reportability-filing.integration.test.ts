// Opt-in integration test for the filing-basis constraint (P0-B).
//
// `reportability_reviews_filed_chk` was extended to require the filing receipt, and it
// was added NOT VALID so the reviews already filed in a live database — which have no
// receipt and never can — do not block the migration. The property this pins is that
// NOT VALID exempts only those old rows: a new or updated row must still carry the
// receipt, and the database is what says so, not the service that happens to be
// calling it.
import 'dotenv/config';

import { randomUUID } from 'node:crypto';

import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDatabase, type DatabaseHandle } from '../src/db/client.js';
import {
  campaignVersions,
  incidents,
  recallCases,
  reportabilityReviews,
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
  Buffer.alloc(32, 3).toString('base64'),
  Buffer.alloc(32, 4).toString('base64'),
);

describe.skipIf(!enabled)(
  'reportability filing basis (database integration)',
  { timeout: 120_000 },
  () => {
    let campaignVersionId: string;
    let staffUserId: string;
    let reviewId: string;

    beforeAll(async () => {
      const [version] = await handle!.db
        .select({ id: campaignVersions.id })
        .from(campaignVersions)
        .limit(1);
      const [staff] = await handle!.db.select({ id: staffUsers.id }).from(staffUsers).limit(1);
      if (!version || !staff) throw new Error('Seed data is required.');
      campaignVersionId = version.id;
      staffUserId = staff.id;

      const publicReference = `KOI-FIL1-${randomUUID().replace(/-/g, '').slice(0, 8).toUpperCase()}`;
      const [caseRow] = await handle!.db
        .insert(recallCases)
        .values({
          publicReference,
          campaignId: SEEDED_CAMPAIGN_ID,
          campaignVersionId,
          locale: 'en-US',
        })
        .returning({ id: recallCases.id });

      const [incident] = await handle!.db
        .insert(incidents)
        .values({
          caseId: caseRow!.id,
          answer: 'yes',
          eventTypes: ['ingestion'],
          narrativeKeyVersion: 'v1',
          narrativeEncrypted: 'enc.v1.aes-256-gcm.placeholder',
          // `incidents_date_known_chk` wants a date when the date is known, so
          // `occurred_date_unknown` cannot stand in for one.
          occurredAt: new Date('2026-09-01T00:00:00.000Z'),
          companyObtainedAt: new Date(),
        })
        .returning({ id: incidents.id });

      const [review] = await handle!.db
        .insert(reportabilityReviews)
        .values({ incidentId: incident!.id, status: 'pending' })
        .returning({ id: reportabilityReviews.id });
      reviewId = review!.id;
    });

    afterAll(async () => {
      if (!handle) return;
      const [review] = await handle.db
        .select({ incidentId: reportabilityReviews.incidentId })
        .from(reportabilityReviews)
        .where(eq(reportabilityReviews.id, reviewId));
      if (review) {
        await handle.db.delete(reportabilityReviews).where(eq(reportabilityReviews.id, reviewId));
        await handle.db.delete(incidents).where(eq(incidents.id, review.incidentId));
      }
      await handle.close();
    });

    it('lets the database refuse a filed review that carries no receipt', async () => {
      // Written straight through the table, past the service, so the refusal can only
      // be the constraint. Drizzle wraps the driver error, and the constraint name
      // lives in the cause chain, so the whole chain is searched rather than the
      // wrapper's message.
      const failure = await handle!.db
        .execute(
          // `decision_chk` is satisfied too, so that the only thing left to refuse
          // this row is the constraint under test — otherwise a different constraint
          // firing first would make the case pass for the wrong reason.
          sql`update reportability_reviews
              set status = 'filed',
                  cpsc_reference = 'CPSC-2026-0002',
                  filed_at = now(),
                  decision_at = now(),
                  rationale_encrypted = 'enc.v1.aes-256-gcm.placeholder'
              where id = ${reviewId}`,
        )
        .then(
          () => null,
          (error: unknown) => error,
        );

      expect(failure).not.toBeNull();
      let current: unknown = failure;
      const messages: string[] = [];
      for (let depth = 0; depth < 5 && current; depth += 1) {
        if (current instanceof Error) {
          messages.push(current.message);
          current = current.cause;
          continue;
        }
        // The serverless driver throws its own error shape, which is not an Error
        // instance but does carry `message`.
        const carrier = current as { message?: unknown; cause?: unknown };
        messages.push(typeof carrier.message === 'string' ? carrier.message : 'unknown error');
        current = carrier.cause;
      }
      expect(messages.join(' | ')).toMatch(/reportability_reviews_filed_chk/);
    });

    it('accepts the same update once the receipt is there', async () => {
      const service = new DrizzleAdminService({
        db: handle!.db,
        crypto,
        consumerWebBaseUrl: 'https://example.test',
      });

      await service.closeReportabilityReview(reviewId, {
        outcome: 'filed',
        reviewerId: staffUserId,
        rationale: 'Filed after completing the Section 15(b) analysis with counsel.',
        cpscReference: 'CPSC-2026-0002',
        filedAt: '2026-09-01',
        filingEvidence: 'Submission receipt 4QZ-2, acknowledged the same day.',
      });

      const [row] = await handle!.db
        .select({
          status: reportabilityReviews.status,
          filedAt: reportabilityReviews.filedAt,
          evidence: reportabilityReviews.filingEvidenceEncrypted,
        })
        .from(reportabilityReviews)
        .where(eq(reportabilityReviews.id, reviewId));
      expect(row!.status).toBe('filed');
      expect(row!.filedAt!.toISOString()).toBe('2026-09-01T00:00:00.000Z');
      expect(row!.evidence!.startsWith('enc.v1.aes-256-gcm.')).toBe(true);
      await expect(crypto.decrypt({ keyVersion: 'v1', value: row!.evidence! })).resolves.toBe(
        'Submission receipt 4QZ-2, acknowledged the same day.',
      );
    });
  },
);
