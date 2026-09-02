import { sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  pgTable,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';

import { caseResolutions } from './resolutions.js';
import { staffUsers } from './staff.js';

export const refundExportBatches = pgTable(
  'refund_export_batches',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    requestedByStaffUserId: uuid('requested_by_staff_user_id')
      .notNull()
      .references(() => staffUsers.id, { onDelete: 'restrict' }),
    purpose: varchar('purpose', { length: 500 }).notNull(),
    rowCount: integer('row_count').notNull(),
    fileSha256: varchar('file_sha256', { length: 64 }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => [
    check('refund_export_batches_row_count_chk', sql`${table.rowCount} > 0`),
    check('refund_export_batches_sha256_chk', sql`${table.fileSha256} ~ '^[a-f0-9]{64}$'`),
    index('refund_export_batches_created_idx').on(table.createdAt),
  ],
);

export const refundExportItems = pgTable(
  'refund_export_items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    exportBatchId: uuid('export_batch_id')
      .notNull()
      .references(() => refundExportBatches.id, { onDelete: 'restrict' }),
    caseResolutionId: uuid('case_resolution_id')
      .notNull()
      .references(() => caseResolutions.id, { onDelete: 'restrict' }),
    resolutionVersion: integer('resolution_version').notNull(),
    rowSha256: varchar('row_sha256', { length: 64 }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('refund_export_items_batch_resolution_uidx').on(
      table.exportBatchId,
      table.caseResolutionId,
    ),
    index('refund_export_items_resolution_created_idx').on(table.caseResolutionId, table.createdAt),
    check('refund_export_items_sha256_chk', sql`${table.rowSha256} ~ '^[a-f0-9]{64}$'`),
    check('refund_export_items_version_chk', sql`${table.resolutionVersion} > 0`),
  ],
);
