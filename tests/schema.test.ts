import { readFile } from 'node:fs/promises';

import { getTableName } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';

import * as schema from '../src/db/schema/index.js';

const expectedTables = [
  'recall_campaigns',
  'campaign_versions',
  'campaign_localizations',
  'campaign_products',
  'campaign_product_lots',
  'campaign_remedy_options',
  'campaign_evidence_requirements',
  'campaign_message_templates',
  'claim_drafts',
  'document_uploads',
  'recall_cases',
  'case_consumers',
  'claimed_products',
  'case_consents',
  'submission_snapshots',
  'incidents',
  'reportability_reviews',
  'case_events',
  'communications',
  'outbox_events',
  'idempotency_records',
  'webhook_events',
] as const;

const schemaTables = [
  schema.recallCampaigns,
  schema.campaignVersions,
  schema.campaignLocalizations,
  schema.campaignProducts,
  schema.campaignProductLots,
  schema.campaignRemedyOptions,
  schema.campaignEvidenceRequirements,
  schema.campaignMessageTemplates,
  schema.claimDrafts,
  schema.documentUploads,
  schema.recallCases,
  schema.caseConsumers,
  schema.claimedProducts,
  schema.caseConsents,
  schema.submissionSnapshots,
  schema.incidents,
  schema.reportabilityReviews,
  schema.caseEvents,
  schema.communications,
  schema.outboxEvents,
  schema.idempotencyRecords,
  schema.webhookEvents,
];

describe('database design', () => {
  it('declares all 22 Phase 1 tables', () => {
    expect(schemaTables.map(getTableName)).toEqual(expectedTables);
  });

  it('generates explicit PostgreSQL foreign keys, enums, indexes, constraints and UTC times', async () => {
    const migration = await readFile('drizzle/0000_adorable_sue_storm.sql', 'utf8');

    expect(migration.match(/CREATE TABLE/g) ?? []).toHaveLength(22);
    expect(migration).toContain('CREATE TYPE "public"."campaign_status" AS ENUM');
    expect(migration).toContain('FOREIGN KEY');
    expect(migration).toContain('CREATE UNIQUE INDEX');
    expect(migration).toContain('CREATE INDEX');
    expect(migration).toContain('CONSTRAINT "document_uploads_owner_chk" CHECK');
    expect(migration).toContain('timestamp with time zone');
    expect(migration).not.toMatch(/timestamp without time zone/i);
  });

  it('keeps the synthetic seed English-only and protected from production use', async () => {
    const seed = await readFile('src/db/seed.ts', 'utf8');

    expect(seed).toContain("slug: 'music-lollipop-demo-2026'");
    expect(seed).toContain("locale: 'en-US'");
    expect(seed).not.toContain("locale: 'es-US'");
    expect(seed).toContain("APP_ENV === 'production'");
    expect(seed).toContain("category: 'product_photo'");
    expect(seed).toContain("category: 'proof_of_purchase'");
  });
});
