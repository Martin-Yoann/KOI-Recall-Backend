import { sql } from 'drizzle-orm';
import {
  check,
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

import { evidenceCategoryEnum } from './campaigns.js';
import { claimDrafts, recallCases } from './claims.js';

const timestamps = {
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
};

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
