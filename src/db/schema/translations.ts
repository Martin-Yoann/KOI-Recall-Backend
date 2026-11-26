import { sql } from 'drizzle-orm';
import { pgTable, uuid, varchar, integer, jsonb, timestamp, uniqueIndex, index, check } from 'drizzle-orm/pg-core';
import { campaignVersions } from './campaigns.js';
import type { TranslationContent, TranslationStatus } from '../../modules/campaigns/translation-content.js';

export const campaignTranslationRevisions = pgTable('campaign_translation_revisions', {
  id: uuid('id').primaryKey().defaultRandom(),
  campaignVersionId: uuid('campaign_version_id').notNull().references(() => campaignVersions.id, { onDelete: 'restrict' }),
  locale: varchar('locale', { length: 16 }).notNull(),
  revision: integer('revision').notNull(), editVersion: integer('edit_version').notNull().default(1),
  status: varchar('status', { length: 32 }).$type<TranslationStatus>().notNull().default('draft'),
  sourceHash: varchar('source_hash', { length: 64 }).notNull(),
  source: jsonb('source').$type<TranslationContent>().notNull(), content: jsonb('content').$type<TranslationContent>().notNull(),
  createdBy: varchar('created_by', { length: 160 }).notNull(), updatedBy: varchar('updated_by', { length: 160 }).notNull(),
  reviewedBy: varchar('reviewed_by', { length: 160 }), reviewReference: varchar('review_reference', { length: 2000 }),
  reviewedAt: timestamp('reviewed_at', { withTimezone: true, mode: 'date' }),
  publishedBy: varchar('published_by', { length: 160 }), publishedAt: timestamp('published_at', { withTimezone: true, mode: 'date' }),
  history: jsonb('history').$type<Array<{ action: string; actor: string; at: string; note?: string }>>().notNull().default([]),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex('translation_revision_uidx').on(t.campaignVersionId, t.locale, t.revision),
  uniqueIndex('translation_case_reference_uidx').on(t.id, t.campaignVersionId, t.locale),
  uniqueIndex('translation_published_uidx').on(t.campaignVersionId, t.locale).where(sql`${t.status} = 'published'`),
  uniqueIndex('translation_working_uidx').on(t.campaignVersionId, t.locale).where(sql`${t.status} in ('draft', 'submitted', 'approved')`),
  index('translation_version_idx').on(t.campaignVersionId),
  check('translation_locale_chk', sql`${t.locale} in ('es-US')`),
  check('translation_status_chk', sql`${t.status} in ('draft','submitted','approved','changes_requested','published','superseded')`),
  check('translation_revision_chk', sql`${t.revision} > 0 and ${t.editVersion} > 0`),
  check('translation_review_chk', sql`${t.status} not in ('approved','published','superseded') or (${t.reviewedBy} is not null and ${t.reviewedAt} is not null and ${t.reviewReference} is not null)`),
  check('translation_publish_chk', sql`${t.status} not in ('published','superseded') or (${t.publishedBy} is not null and ${t.publishedAt} is not null)`),
]);
