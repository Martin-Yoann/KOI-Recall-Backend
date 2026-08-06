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
export const documentUploadStatusEnum = pgEnum('document_upload_status', [
  'authorized',
  'uploaded',
  'verified',
  'linked',
  'rejected',
  'deletion_pending',
  'deleted',
]);
export const malwareScanStatusEnum = pgEnum('malware_scan_status', [
  'pending',
  'clean',
  'infected',
  'failed',
  'not_run',
]);
export const reportabilityReviewStatusEnum = pgEnum('reportability_review_status', [
  'pending',
  'filed',
  'documented_non_reportable',
]);
export const communicationStatusEnum = pgEnum('communication_status', [
  'queued',
  'sending',
  'sent',
  'delivered',
  'bounced',
  'failed',
]);
export const outboxStatusEnum = pgEnum('outbox_status', [
  'pending',
  'processing',
  'succeeded',
  'failed',
  'dead_letter',
]);
export const webhookStatusEnum = pgEnum('webhook_status', [
  'received',
  'processing',
  'processed',
  'failed',
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
    publishedAt: timestamp('published_at', { withTimezone: true, mode: 'date' }),
    retiredAt: timestamp('retired_at', { withTimezone: true, mode: 'date' }),
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

export const documentUploads = pgTable(
  'document_uploads',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    draftId: uuid('draft_id').references(() => claimDrafts.id, { onDelete: 'set null' }),
    caseId: uuid('case_id').references(() => recallCases.id, { onDelete: 'cascade' }),
    category: evidenceCategoryEnum('category').notNull(),
    categorySlot: integer('category_slot'),
    storagePathname: text('storage_pathname').notNull(),
    originalFileName: varchar('original_file_name', { length: 255 }).notNull(),
    declaredMimeType: varchar('declared_mime_type', { length: 120 }).notNull(),
    detectedMimeType: varchar('detected_mime_type', { length: 120 }),
    sizeBytes: integer('size_bytes').notNull(),
    sha256: varchar('sha256', { length: 64 }),
    uploadStatus: documentUploadStatusEnum('upload_status').notNull().default('authorized'),
    scanStatus: malwareScanStatusEnum('scan_status').notNull().default('pending'),
    uploadedAt: timestamp('uploaded_at', { withTimezone: true, mode: 'date' }),
    linkedAt: timestamp('linked_at', { withTimezone: true, mode: 'date' }),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }).notNull(),
    ...timestamps,
  },
  (table) => [
    uniqueIndex('document_uploads_storage_pathname_uidx').on(table.storagePathname),
    uniqueIndex('document_uploads_draft_category_slot_uidx').on(
      table.draftId,
      table.category,
      table.categorySlot,
    ),
    index('document_uploads_draft_status_idx').on(table.draftId, table.uploadStatus),
    index('document_uploads_case_category_idx').on(table.caseId, table.category),
    index('document_uploads_cleanup_idx').on(table.uploadStatus, table.expiresAt),
    check(
      'document_uploads_owner_chk',
      sql`${table.draftId} is not null or ${table.caseId} is not null`,
    ),
    check('document_uploads_size_chk', sql`${table.sizeBytes} > 0`),
    check(
      'document_uploads_category_slot_chk',
      sql`${table.categorySlot} is null or ${table.categorySlot} > 0`,
    ),
    check(
      'document_uploads_sha256_format_chk',
      sql`${table.sha256} is null or ${table.sha256} ~ '^[a-f0-9]{64}$'`,
    ),
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

export const incidents = pgTable(
  'incidents',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    caseId: uuid('case_id')
      .notNull()
      .references(() => recallCases.id, { onDelete: 'restrict' }),
    answer: varchar('answer', { length: 16 }).notNull(),
    eventTypes: text('event_types').array().notNull(),
    narrativeKeyVersion: varchar('narrative_key_version', { length: 40 }).notNull(),
    narrativeEncrypted: text('narrative_encrypted').notNull(),
    occurredAt: timestamp('occurred_at', { withTimezone: true, mode: 'date' }),
    occurredDateUnknown: boolean('occurred_date_unknown').notNull().default(false),
    injurySeverity: varchar('injury_severity', { length: 40 }),
    medicalTreatment: varchar('medical_treatment', { length: 40 }),
    usedAsIntended: varchar('used_as_intended', { length: 16 }),
    companyObtainedAt: timestamp('company_obtained_at', {
      withTimezone: true,
      mode: 'date',
    }).notNull(),
    ...timestamps,
  },
  (table) => [
    uniqueIndex('incidents_case_uidx').on(table.caseId),
    index('incidents_company_obtained_idx').on(table.companyObtainedAt),
    check('incidents_answer_chk', sql`${table.answer} in ('yes', 'unsure')`),
    check(
      'incidents_date_known_chk',
      sql`${table.occurredAt} is not null or ${table.occurredDateUnknown} = true`,
    ),
    check('incidents_event_types_chk', sql`cardinality(${table.eventTypes}) > 0`),
  ],
);

export const reportabilityReviews = pgTable(
  'reportability_reviews',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    incidentId: uuid('incident_id')
      .notNull()
      .references(() => incidents.id, { onDelete: 'restrict' }),
    status: reportabilityReviewStatusEnum('status').notNull().default('pending'),
    reviewerId: uuid('reviewer_id'),
    rationaleEncrypted: text('rationale_encrypted'),
    decisionAt: timestamp('decision_at', { withTimezone: true, mode: 'date' }),
    cpscReference: varchar('cpsc_reference', { length: 160 }),
    filedAt: timestamp('filed_at', { withTimezone: true, mode: 'date' }),
    ...timestamps,
  },
  (table) => [
    uniqueIndex('reportability_reviews_incident_uidx').on(table.incidentId),
    index('reportability_reviews_pending_idx').on(table.status, table.createdAt),
    check(
      'reportability_reviews_decision_chk',
      sql`${table.status} = 'pending' or (${table.decisionAt} is not null and ${table.rationaleEncrypted} is not null)`,
    ),
    check(
      'reportability_reviews_filed_chk',
      sql`${table.status} <> 'filed' or (${table.cpscReference} is not null and ${table.filedAt} is not null)`,
    ),
  ],
);

export const caseEvents = pgTable(
  'case_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    caseId: uuid('case_id')
      .notNull()
      .references(() => recallCases.id, { onDelete: 'restrict' }),
    eventType: varchar('event_type', { length: 100 }).notNull(),
    actorType: varchar('actor_type', { length: 40 }).notNull().default('system'),
    actorId: uuid('actor_id'),
    data: jsonb('data').$type<Record<string, unknown>>().notNull().default({}),
    occurredAt: timestamp('occurred_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
  },
  (table) => [index('case_events_case_occurred_idx').on(table.caseId, table.occurredAt)],
);

export const communications = pgTable(
  'communications',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    caseId: uuid('case_id')
      .notNull()
      .references(() => recallCases.id, { onDelete: 'restrict' }),
    templateId: uuid('template_id')
      .notNull()
      .references(() => campaignMessageTemplates.id, { onDelete: 'restrict' }),
    messageKey: varchar('message_key', { length: 160 }).notNull(),
    channel: varchar('channel', { length: 20 }).notNull().default('email'),
    recipientKeyVersion: varchar('recipient_key_version', { length: 40 }).notNull(),
    recipientEncrypted: text('recipient_encrypted').notNull(),
    status: communicationStatusEnum('status').notNull().default('queued'),
    providerMessageId: varchar('provider_message_id', { length: 160 }),
    providerErrorCode: varchar('provider_error_code', { length: 100 }),
    sentAt: timestamp('sent_at', { withTimezone: true, mode: 'date' }),
    deliveredAt: timestamp('delivered_at', { withTimezone: true, mode: 'date' }),
    ...timestamps,
  },
  (table) => [
    uniqueIndex('communications_message_key_uidx').on(table.messageKey),
    index('communications_case_status_idx').on(table.caseId, table.status),
    index('communications_provider_id_idx').on(table.providerMessageId),
  ],
);

export const outboxEvents = pgTable(
  'outbox_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    aggregateType: varchar('aggregate_type', { length: 80 }).notNull(),
    aggregateId: uuid('aggregate_id').notNull(),
    eventType: varchar('event_type', { length: 100 }).notNull(),
    deduplicationKey: varchar('deduplication_key', { length: 180 }).notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    status: outboxStatusEnum('status').notNull().default('pending'),
    attempts: integer('attempts').notNull().default(0),
    availableAt: timestamp('available_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
    lockedAt: timestamp('locked_at', { withTimezone: true, mode: 'date' }),
    lastErrorCode: varchar('last_error_code', { length: 100 }),
    processedAt: timestamp('processed_at', { withTimezone: true, mode: 'date' }),
    ...timestamps,
  },
  (table) => [
    uniqueIndex('outbox_events_deduplication_key_uidx').on(table.deduplicationKey),
    index('outbox_events_dispatch_idx').on(table.status, table.availableAt),
    check('outbox_events_attempts_chk', sql`${table.attempts} >= 0`),
  ],
);

export const idempotencyRecords = pgTable(
  'idempotency_records',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    endpoint: varchar('endpoint', { length: 160 }).notNull(),
    keyHash: varchar('key_hash', { length: 128 }).notNull(),
    requestHash: varchar('request_hash', { length: 64 }).notNull(),
    statusCode: integer('status_code').notNull(),
    responseBody: jsonb('response_body').$type<Record<string, unknown>>().notNull(),
    caseId: uuid('case_id').references(() => recallCases.id, { onDelete: 'set null' }),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('idempotency_records_endpoint_key_uidx').on(table.endpoint, table.keyHash),
    index('idempotency_records_expiry_idx').on(table.expiresAt),
    check('idempotency_records_request_hash_chk', sql`${table.requestHash} ~ '^[a-f0-9]{64}$'`),
    check('idempotency_records_status_code_chk', sql`${table.statusCode} between 200 and 599`),
  ],
);

export const webhookEvents = pgTable(
  'webhook_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    provider: varchar('provider', { length: 40 }).notNull(),
    providerEventId: varchar('provider_event_id', { length: 200 }).notNull(),
    eventType: varchar('event_type', { length: 120 }).notNull(),
    status: webhookStatusEnum('status').notNull().default('received'),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    receivedAt: timestamp('received_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
    processedAt: timestamp('processed_at', { withTimezone: true, mode: 'date' }),
    lastErrorCode: varchar('last_error_code', { length: 100 }),
  },
  (table) => [
    uniqueIndex('webhook_events_provider_event_uidx').on(table.provider, table.providerEventId),
    index('webhook_events_status_received_idx').on(table.status, table.receivedAt),
  ],
);
