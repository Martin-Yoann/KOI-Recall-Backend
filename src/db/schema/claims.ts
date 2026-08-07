import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  date,
  index,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';

import { campaignProducts, campaignVersions, recallCampaigns } from './campaigns.js';

const timestamps = {
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
};

export const claimDraftStatusEnum = pgEnum('claim_draft_status', [
  'active',
  'submitted',
  'expired',
  'abandoned',
]);
export const recallCaseStatusEnum = pgEnum('recall_case_status', [
  'submitted',
  'triage',
  'under_review',
  'need_info',
  'approved',
  'rejected',
  'duplicate',
  'withdrawn',
  'closure_review',
  'closed',
]);
export const recallCaseSubtypeEnum = pgEnum('recall_case_subtype', ['standard', 'injury_hazard']);
export const productCheckResultEnum = pgEnum('product_check_result', [
  'potential_match',
  'not_matched',
  'manual_review',
]);

export const recallCases = pgTable(
  'recall_cases',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    publicReference: varchar('public_reference', { length: 32 }).notNull(),
    campaignId: uuid('campaign_id')
      .notNull()
      .references(() => recallCampaigns.id, { onDelete: 'restrict' }),
    campaignVersionId: uuid('campaign_version_id')
      .notNull()
      .references(() => campaignVersions.id, { onDelete: 'restrict' }),
    locale: varchar('locale', { length: 16 }).notNull().default('en-US'),
    subtype: recallCaseSubtypeEnum('subtype').notNull().default('standard'),
    status: recallCaseStatusEnum('status').notNull().default('submitted'),
    duplicateFlag: boolean('duplicate_flag').notNull().default(false),
    incidentFlag: boolean('incident_flag').notNull().default(false),
    submittedAt: timestamp('submitted_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
    ...timestamps,
  },
  (table) => [
    uniqueIndex('recall_cases_public_reference_uidx').on(table.publicReference),
    index('recall_cases_campaign_submitted_idx').on(table.campaignId, table.submittedAt),
    index('recall_cases_campaign_status_idx').on(table.campaignId, table.status),
    check(
      'recall_cases_public_reference_format_chk',
      sql`${table.publicReference} ~ '^KOI-[A-Z0-9]{4}-[A-Z0-9]{8}$'`,
    ),
    check(
      'recall_cases_incident_subtype_chk',
      sql`${table.incidentFlag} = false or ${table.subtype} = 'injury_hazard'`,
    ),
  ],
);

export const claimDrafts = pgTable(
  'claim_drafts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    campaignId: uuid('campaign_id')
      .notNull()
      .references(() => recallCampaigns.id, { onDelete: 'cascade' }),
    campaignVersionId: uuid('campaign_version_id')
      .notNull()
      .references(() => campaignVersions.id, { onDelete: 'restrict' }),
    tokenHash: varchar('token_hash', { length: 128 }).notNull(),
    status: claimDraftStatusEnum('status').notNull().default('active'),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }).notNull(),
    submittedCaseId: uuid('submitted_case_id').references(() => recallCases.id, {
      onDelete: 'set null',
    }),
    ...timestamps,
  },
  (table) => [
    uniqueIndex('claim_drafts_token_hash_uidx').on(table.tokenHash),
    index('claim_drafts_expiry_status_idx').on(table.status, table.expiresAt),
    index('claim_drafts_campaign_created_idx').on(table.campaignId, table.createdAt),
  ],
);

export const caseConsumers = pgTable(
  'case_consumers',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    caseId: uuid('case_id')
      .notNull()
      .references(() => recallCases.id, { onDelete: 'cascade' }),
    keyVersion: varchar('key_version', { length: 40 }).notNull(),
    firstNameEncrypted: text('first_name_encrypted').notNull(),
    lastNameEncrypted: text('last_name_encrypted').notNull(),
    emailEncrypted: text('email_encrypted').notNull(),
    emailLookupHash: varchar('email_lookup_hash', { length: 128 }).notNull(),
    phoneEncrypted: text('phone_encrypted'),
    addressEncrypted: text('address_encrypted').notNull(),
    addressLookupHash: varchar('address_lookup_hash', { length: 128 }).notNull(),
    countryCode: varchar('country_code', { length: 2 }).notNull().default('US'),
    ...timestamps,
  },
  (table) => [
    uniqueIndex('case_consumers_case_uidx').on(table.caseId),
    index('case_consumers_email_lookup_idx').on(table.emailLookupHash),
    index('case_consumers_address_lookup_idx').on(table.addressLookupHash),
  ],
);

export const claimedProducts = pgTable(
  'claimed_products',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    caseId: uuid('case_id')
      .notNull()
      .references(() => recallCases.id, { onDelete: 'cascade' }),
    campaignProductId: uuid('campaign_product_id')
      .notNull()
      .references(() => campaignProducts.id, { onDelete: 'restrict' }),
    quantity: integer('quantity').notNull(),
    shape: varchar('shape', { length: 80 }).notNull(),
    flavor: varchar('flavor', { length: 80 }).notNull(),
    lotCode: varchar('lot_code', { length: 80 }).notNull(),
    dateCode: varchar('date_code', { length: 40 }).notNull(),
    purchaseChannel: varchar('purchase_channel', { length: 40 }).notNull(),
    purchaseDate: date('purchase_date', { mode: 'string' }),
    orderNumberEncrypted: text('order_number_encrypted'),
    orderNumberLookupHash: varchar('order_number_lookup_hash', { length: 128 }),
    checkResult: productCheckResultEnum('check_result').notNull(),
    ...timestamps,
  },
  (table) => [
    index('claimed_products_case_idx').on(table.caseId),
    index('claimed_products_lot_date_idx').on(table.lotCode, table.dateCode),
    index('claimed_products_order_lookup_idx').on(table.orderNumberLookupHash),
    check('claimed_products_quantity_chk', sql`${table.quantity} between 1 and 100`),
  ],
);

export const caseConsents = pgTable(
  'case_consents',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    caseId: uuid('case_id')
      .notNull()
      .references(() => recallCases.id, { onDelete: 'cascade' }),
    consentType: varchar('consent_type', { length: 80 }).notNull(),
    textVersion: varchar('text_version', { length: 80 }).notNull(),
    accepted: boolean('accepted').notNull(),
    acceptedAt: timestamp('accepted_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
    ipHash: varchar('ip_hash', { length: 128 }),
    userAgentHash: varchar('user_agent_hash', { length: 128 }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('case_consents_identity_uidx').on(
      table.caseId,
      table.consentType,
      table.textVersion,
    ),
    check('case_consents_accepted_chk', sql`${table.accepted} = true`),
  ],
);

export const submissionSnapshots = pgTable(
  'submission_snapshots',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    caseId: uuid('case_id')
      .notNull()
      .references(() => recallCases.id, { onDelete: 'restrict' }),
    schemaVersion: varchar('schema_version', { length: 40 }).notNull(),
    keyVersion: varchar('key_version', { length: 40 }).notNull(),
    encryptedPayload: text('encrypted_payload').notNull(),
    payloadSha256: varchar('payload_sha256', { length: 64 }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('submission_snapshots_case_uidx').on(table.caseId),
    check('submission_snapshots_sha256_format_chk', sql`${table.payloadSha256} ~ '^[a-f0-9]{64}$'`),
  ],
);
