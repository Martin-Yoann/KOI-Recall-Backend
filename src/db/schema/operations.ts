import { sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';

import { campaignMessageTemplates } from './campaigns.js';
import { recallCases } from './claims.js';

const timestamps = {
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
};

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
