import { sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  boolean,
  check,
  date,
  foreignKey,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';

const timestamps = {
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
};

export const campaignStatusEnum = pgEnum('campaign_status', [
  'draft',
  'scheduled',
  'active',
  'paused',
  'closed',
]);
export const campaignVersionStatusEnum = pgEnum('campaign_version_status', [
  'draft',
  'published',
  'retired',
]);
export const lotEligibilityStatusEnum = pgEnum('lot_eligibility_status', [
  'affected',
  'not_affected',
  'manual_review',
]);
export const evidenceCategoryEnum = pgEnum('evidence_category', [
  'product_photo',
  'proof_of_purchase',
  'incident_evidence',
]);

export const campaignVersions = pgTable(
  'campaign_versions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    campaignId: uuid('campaign_id')
      .notNull()
      .references((): AnyPgColumn => recallCampaigns.id, { onDelete: 'cascade' }),
    versionNumber: integer('version_number').notNull(),
    status: campaignVersionStatusEnum('status').notNull().default('draft'),
    schemaVersion: varchar('schema_version', { length: 40 }).notNull().default('phase1-v1'),
    // M1 nullable for legacy versions; M3 makes published versions require both fields.
    privacyNoticeVersion: varchar('privacy_notice_version', { length: 80 }),
    privacyNoticeUrl: text('privacy_notice_url'),
    publishedAt: timestamp('published_at', { withTimezone: true, mode: 'date' }),
    retiredAt: timestamp('retired_at', { withTimezone: true, mode: 'date' }),
    // T4.3 (O4): publish-gate record. `approvals` carries the structured
    // sign-off snapshot (business / legal_compliance / cpsc_if_applicable)
    // captured when the version was published; `publishedBy` is the actor.
    // Publishing is atomic: a version can only become `published` when every
    // required content piece is present and all approvals are recorded.
    publishedBy: varchar('published_by', { length: 160 }),
    approvals: jsonb('approvals')
      .$type<
        Array<{
          role: 'business' | 'legal_compliance' | 'cpsc_if_applicable';
          approvedBy: string;
          approvedAt: string;
        }>
      >()
      .default([]),
    ...timestamps,
  },
  (table) => [
    uniqueIndex('campaign_versions_campaign_version_uidx').on(
      table.campaignId,
      table.versionNumber,
    ),
    uniqueIndex('campaign_versions_campaign_id_id_uidx').on(table.campaignId, table.id),
    index('campaign_versions_campaign_status_idx').on(table.campaignId, table.status),
    check('campaign_versions_positive_version_chk', sql`${table.versionNumber} > 0`),
  ],
);

export const recallCampaigns = pgTable(
  'recall_campaigns',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    slug: varchar('slug', { length: 100 }).notNull(),
    code: varchar('code', { length: 40 }).notNull(),
    status: campaignStatusEnum('status').notNull().default('draft'),
    defaultLocale: varchar('default_locale', { length: 16 }).notNull().default('en-US'),
    publishedVersionId: uuid('published_version_id'),
    isTestData: boolean('is_test_data').notNull().default(false),
    launchAt: timestamp('launch_at', { withTimezone: true, mode: 'date' }),
    closeAt: timestamp('close_at', { withTimezone: true, mode: 'date' }),
    ...timestamps,
  },
  (table) => [
    uniqueIndex('recall_campaigns_slug_uidx').on(table.slug),
    uniqueIndex('recall_campaigns_code_uidx').on(table.code),
    foreignKey({
      name: 'recall_campaigns_published_version_owner_fk',
      columns: [table.id, table.publishedVersionId],
      foreignColumns: [campaignVersions.campaignId, campaignVersions.id],
    }),
    index('recall_campaigns_status_launch_idx').on(table.status, table.launchAt),
    check('recall_campaigns_slug_format_chk', sql`${table.slug} ~ '^[a-z0-9]+(-[a-z0-9]+)*$'`),
    check(
      'recall_campaigns_close_after_launch_chk',
      sql`${table.closeAt} is null or ${table.launchAt} is null or ${table.closeAt} > ${table.launchAt}`,
    ),
  ],
);

export const campaignLocalizations = pgTable(
  'campaign_localizations',
  {
    campaignVersionId: uuid('campaign_version_id')
      .notNull()
      .references(() => campaignVersions.id, { onDelete: 'cascade' }),
    locale: varchar('locale', { length: 16 }).notNull(),
    title: varchar('title', { length: 240 }).notNull(),
    summary: text('summary').notNull(),
    hazard: text('hazard').notNull(),
    immediateAction: text('immediate_action').notNull(),
    remedySummary: text('remedy_summary').notNull(),
    supportEmail: varchar('support_email', { length: 254 }).notNull(),
    supportPhone: varchar('support_phone', { length: 40 }).notNull(),
    supportHours: varchar('support_hours', { length: 200 }).notNull(),
    faq: jsonb('faq')
      .$type<Array<{ topic: string; question: string; answer: string }>>()
      .notNull()
      .default([]),
    ...timestamps,
  },
  (table) => [
    primaryKey({
      columns: [table.campaignVersionId, table.locale],
      name: 'campaign_localizations_pk',
    }),
    index('campaign_localizations_locale_idx').on(table.locale),
  ],
);

export const campaignProducts = pgTable(
  'campaign_products',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    campaignVersionId: uuid('campaign_version_id')
      .notNull()
      .references(() => campaignVersions.id, { onDelete: 'cascade' }),
    sku: varchar('sku', { length: 120 }).notNull(),
    brand: varchar('brand', { length: 160 }).notNull(),
    name: varchar('name', { length: 240 }).notNull(),
    attributes: jsonb('attributes').$type<Record<string, unknown>>().notNull().default({}),
    sortOrder: integer('sort_order').notNull().default(0),
    ...timestamps,
  },
  (table) => [
    uniqueIndex('campaign_products_version_sku_uidx').on(table.campaignVersionId, table.sku),
    index('campaign_products_version_sort_idx').on(table.campaignVersionId, table.sortOrder),
  ],
);

/**
 * A physical variant of a campaign product — a specific Model / Style /
 * packaging version / applicability window. ADR-0001 §2.1. Lets the catalogue
 * express "the same SKU/UPC maps to JSM-18A and JSM-18D", the real-world
 * ambiguity the flat attributes model could not.
 */
export const campaignProductVariants = pgTable(
  'campaign_product_variants',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    campaignProductId: uuid('campaign_product_id')
      .notNull()
      .references(() => campaignProducts.id, { onDelete: 'cascade' }),
    model: varchar('model', { length: 120 }).notNull(),
    style: varchar('style', { length: 120 }),
    applicableFrom: date('applicable_from', { mode: 'string' }),
    applicableTo: date('applicable_to', { mode: 'string' }),
    attributes: jsonb('attributes').$type<Record<string, unknown>>().notNull().default({}),
    ...timestamps,
  },
  (table) => [
    uniqueIndex('campaign_product_variants_product_model_uidx').on(
      table.campaignProductId,
      table.model,
    ),
    index('campaign_product_variants_product_idx').on(table.campaignProductId),
  ],
);

/**
 * Identifier type for {@link campaignProductIdentifiers}. ADR-0001 §2.2.
 * `other` keeps the set open for future identifier kinds without a schema change.
 */
export const productIdentifierTypeEnum = pgEnum('product_identifier_type', [
  'sku',
  'unit_upc',
  'gtin14',
  'model',
  'style',
  'other',
]);

/**
 * A multi-valued, deliberately non-globally-unique identifier attached to a
 * variant. ADR-0001 §2.2. Identifiers MAY repeat across variants because
 * ambiguity (e.g. one UPC shared by two Models) is a business fact; the Policy
 * turns multi-candidate matches into manual_review rather than picking one.
 * Queries match on `normalized_value`; `raw_value` is preserved for display.
 */
export const campaignProductIdentifiers = pgTable(
  'campaign_product_identifiers',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    variantId: uuid('variant_id')
      .notNull()
      .references(() => campaignProductVariants.id, { onDelete: 'cascade' }),
    identifierType: productIdentifierTypeEnum('identifier_type').notNull(),
    rawValue: varchar('raw_value', { length: 160 }).notNull(),
    normalizedValue: varchar('normalized_value', { length: 160 }).notNull(),
    ...timestamps,
  },
  (table) => [
    uniqueIndex('campaign_product_identifiers_variant_type_value_uidx').on(
      table.variantId,
      table.identifierType,
      table.normalizedValue,
    ),
    index('campaign_product_identifiers_lookup_idx').on(
      table.identifierType,
      table.normalizedValue,
    ),
  ],
);

export const campaignProductLots = pgTable(
  'campaign_product_lots',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    campaignProductId: uuid('campaign_product_id')
      .notNull()
      .references(() => campaignProducts.id, { onDelete: 'cascade' }),
    lotCode: varchar('lot_code', { length: 80 }).notNull(),
    dateCode: varchar('date_code', { length: 40 }).notNull(),
    eligibilityStatus: lotEligibilityStatusEnum('eligibility_status').notNull().default('affected'),
    attributes: jsonb('attributes').$type<Record<string, unknown>>().notNull().default({}),
    ...timestamps,
  },
  (table) => [
    uniqueIndex('campaign_product_lots_identity_uidx').on(
      table.campaignProductId,
      table.lotCode,
      table.dateCode,
    ),
    index('campaign_product_lots_lookup_idx').on(table.lotCode, table.dateCode),
  ],
);

export const campaignRemedyOptions = pgTable(
  'campaign_remedy_options',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    campaignVersionId: uuid('campaign_version_id')
      .notNull()
      .references(() => campaignVersions.id, { onDelete: 'cascade' }),
    code: varchar('code', { length: 60 }).notNull(),
    displayName: varchar('display_name', { length: 160 }).notNull(),
    requiresMailingAddress: boolean('requires_mailing_address').notNull().default(true),
    active: boolean('active').notNull().default(true),
    sortOrder: integer('sort_order').notNull().default(0),
    ...timestamps,
  },
  (table) => [
    uniqueIndex('campaign_remedy_options_version_code_uidx').on(
      table.campaignVersionId,
      table.code,
    ),
  ],
);

export const campaignEvidenceRequirements = pgTable(
  'campaign_evidence_requirements',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    campaignVersionId: uuid('campaign_version_id')
      .notNull()
      .references(() => campaignVersions.id, { onDelete: 'cascade' }),
    category: evidenceCategoryEnum('category').notNull(),
    required: boolean('required').notNull().default(false),
    minimumFiles: integer('minimum_files').notNull().default(0),
    maximumFiles: integer('maximum_files').notNull().default(1),
    allowedMimeTypes: text('allowed_mime_types').array().notNull(),
    maximumFileSizeBytes: integer('maximum_file_size_bytes').notNull(),
    instructions: text('instructions').notNull(),
    ...timestamps,
  },
  (table) => [
    uniqueIndex('campaign_evidence_requirements_version_category_uidx').on(
      table.campaignVersionId,
      table.category,
    ),
    check(
      'campaign_evidence_requirements_count_chk',
      sql`${table.minimumFiles} >= 0 and ${table.maximumFiles} >= ${table.minimumFiles}`,
    ),
    check('campaign_evidence_requirements_size_chk', sql`${table.maximumFileSizeBytes} > 0`),
  ],
);

export const campaignMessageTemplates = pgTable(
  'campaign_message_templates',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    campaignVersionId: uuid('campaign_version_id')
      .notNull()
      .references(() => campaignVersions.id, { onDelete: 'cascade' }),
    locale: varchar('locale', { length: 16 }).notNull(),
    templateType: varchar('template_type', { length: 80 }).notNull(),
    version: integer('version').notNull(),
    subject: varchar('subject', { length: 240 }).notNull(),
    htmlBody: text('html_body').notNull(),
    textBody: text('text_body').notNull(),
    active: boolean('active').notNull().default(true),
    ...timestamps,
  },
  (table) => [
    uniqueIndex('campaign_message_templates_identity_uidx').on(
      table.campaignVersionId,
      table.locale,
      table.templateType,
      table.version,
    ),
    check('campaign_message_templates_positive_version_chk', sql`${table.version} > 0`),
  ],
);
