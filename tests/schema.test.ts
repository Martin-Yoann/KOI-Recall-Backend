import { readFile, readdir } from 'node:fs/promises';

import { getTableName } from 'drizzle-orm';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';

import * as schema from '../src/db/schema/index.js';

const expectedTables = [
  'recall_campaigns',
  'campaign_versions',
  'campaign_localizations',
  'campaign_products',
  'campaign_product_variants',
  'campaign_product_identifiers',
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
  schema.campaignProductVariants,
  schema.campaignProductIdentifiers,
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
  it('declares all 24 Phase 1 tables (22 base + 2 identity model, ADR-0001)', () => {
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

  it('binds a published version to its owning campaign', async () => {
    const versionConfig = getTableConfig(schema.campaignVersions);
    const campaignConfig = getTableConfig(schema.recallCampaigns);
    const ownershipIndex = versionConfig.indexes.find(
      (index) => index.config.name === 'campaign_versions_campaign_id_id_uidx',
    );
    const ownershipForeignKey = campaignConfig.foreignKeys.find(
      (foreignKey) => foreignKey.getName() === 'recall_campaigns_published_version_owner_fk',
    );

    expect(
      ownershipIndex?.config.columns.map((column) => ('name' in column ? column.name : undefined)),
    ).toEqual(['campaign_id', 'id']);
    expect(ownershipForeignKey?.reference().columns.map((column) => column.name)).toEqual([
      'id',
      'published_version_id',
    ]);
    expect(ownershipForeignKey?.reference().foreignColumns.map((column) => column.name)).toEqual([
      'campaign_id',
      'id',
    ]);

    const migration = await readFile('drizzle/0001_campaign_version_ownership.sql', 'utf8').catch(
      () => '',
    );
    expect(migration).toContain('recall_campaigns_published_version_owner_fk');
    const ownershipIndexPosition = migration.indexOf(
      'CREATE UNIQUE INDEX "campaign_versions_campaign_id_id_uidx"',
    );
    const ownershipForeignKeyPosition = migration.indexOf(
      'ADD CONSTRAINT "recall_campaigns_published_version_owner_fk"',
    );
    expect(ownershipIndexPosition).toBeGreaterThanOrEqual(0);
    expect(ownershipForeignKeyPosition).toBeGreaterThan(ownershipIndexPosition);
  });

  it('persists staff login lockout state in schema and migrations', async () => {
    const staffConfig = getTableConfig(schema.staffUsers);
    expect(staffConfig.columns.map((column) => column.name)).toEqual(
      expect.arrayContaining(['failed_login_attempts', 'locked_until']),
    );

    const migrationFiles = (await readdir('drizzle')).filter((file) => file.endsWith('.sql'));
    const migrations = (
      await Promise.all(migrationFiles.map((file) => readFile(`drizzle/${file}`, 'utf8')))
    ).join('\n');
    expect(migrations).toContain(
      'ALTER TABLE "staff_users" ADD COLUMN "failed_login_attempts" integer DEFAULT 0 NOT NULL',
    );
    expect(migrations).toContain(
      'ALTER TABLE "staff_users" ADD COLUMN "locked_until" timestamp with time zone',
    );
  });

  it('models product identity with variants and multi-valued identifiers (ADR-0001)', async () => {
    // Variants: model is unique per product, so one product can carry JSM-18A
    // and JSM-18D as separate rows — the ambiguity the flat attributes model
    // could not express.
    const variantConfig = getTableConfig(schema.campaignProductVariants);
    const variantUnique = variantConfig.indexes.find(
      (ix) => ix.config.name === 'campaign_product_variants_product_model_uidx',
    );
    expect(variantUnique?.config.unique).toBe(true);
    expect(variantUnique?.config.columns.map((c) => ('name' in c ? c.name : undefined))).toEqual([
      'campaign_product_id',
      'model',
    ]);

    // Identifiers: a lookup index on (type, normalized_value) but NO global
    // unique constraint — the same UPC across two variants is a business fact
    // the Policy resolves as manual_review, not a constraint violation.
    const identifierConfig = getTableConfig(schema.campaignProductIdentifiers);
    const identifierUnique = identifierConfig.indexes.find(
      (ix) => ix.config.name === 'campaign_product_identifiers_variant_type_value_uidx',
    );
    expect(identifierUnique?.config.unique).toBe(true);
    expect(identifierUnique?.config.columns.map((c) => ('name' in c ? c.name : undefined))).toEqual(
      ['variant_id', 'identifier_type', 'normalized_value'],
    );
    const allIdentifierIndexes = identifierConfig.indexes.map((ix) => ix.config.unique);
    // Exactly one unique index, scoped to the variant — never globally unique.
    expect(allIdentifierIndexes.filter(Boolean)).toHaveLength(1);

    const migration = await readFile('drizzle/0003_yummy_nightcrawler.sql', 'utf8');
    expect(migration).toContain('CREATE TYPE "public"."product_identifier_type"');
    expect(migration).toContain('CREATE TYPE "public"."identification_mode"');
    expect(migration).toContain('campaign_product_identifiers_lookup_idx');
    // claimed_products gained audit columns (M1 nullable, old NOT NULL kept).
    expect(migration).toContain('ALTER TABLE "claimed_products" ADD COLUMN "matched_variant_ids"');
    expect(migration).toContain('ALTER TABLE "claimed_products" ADD COLUMN "identification_mode"');
    expect(migration).toContain('ALTER TABLE "claimed_products" ADD COLUMN "reason_codes"');
    expect(migration).toContain('ALTER TABLE "claimed_products" ADD COLUMN "input_snapshot"');
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
