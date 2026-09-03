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

import { campaignRemedyOptions } from './campaigns.js';
import { recallCases } from './claims.js';
import { staffUsers } from './staff.js';

const timestamps = {
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
};

/**
 * The outcome the consumer requested (ADR redesign §6.2). A single Resolution
 * row per Recall Case tracks the requested preference and the operationally
 * approved decision. The enum is deliberately closed — no free-form string.
 */
export const caseResolutionTypeEnum = pgEnum('case_resolution_type', ['replacement', 'refund']);

/**
 * Resolution lifecycle. `exported` is intentionally NOT a status — an export is
 * an event, not a Resolution state, and a Resolution can be exported more than
 * once (ADR redesign §6.1). `cancelled` is terminal-ish: no return from
 * `externally_completed`, corrections go through new audited operations.
 */
export const caseResolutionStatusEnum = pgEnum('case_resolution_status', [
  'requested',
  'approved',
  'externally_completed',
  'cancelled',
]);

/**
 * Normalized Resolution for a Recall Case (ADR redesign §6.2). The consumer's
 * requested remedy is captured at submission; the operationally approved
 * outcome (and, for refunds, the amount/currency) is recorded on approval.
 *
 * M1: `requested_type` and `requested_remedy_option_id` are nullable — legacy
 * cases are backfilled in M2, then `requested_type` is tightened to NOT NULL
 * in M3. New claims always write a full row (see DrizzleCaseService.submit).
 *
 * Callers never mutate this table directly; `CaseResolutionModule` is the only
 * writer (optimistic versioning via `version`).
 */
export const caseResolutions = pgTable(
  'case_resolutions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    caseId: uuid('case_id')
      .notNull()
      .references(() => recallCases.id, { onDelete: 'restrict' }),
    requestedType: caseResolutionTypeEnum('requested_type'),
    requestedRemedyOptionId: uuid('requested_remedy_option_id').references(
      () => campaignRemedyOptions.id,
      { onDelete: 'restrict' },
    ),
    approvedType: caseResolutionTypeEnum('approved_type'),
    status: caseResolutionStatusEnum('status').notNull().default('requested'),
    /** Refund amount in the ISO 4217 minor unit (e.g. cents for USD). Positive. */
    refundAmountMinor: integer('refund_amount_minor'),
    /** Uppercase ISO 4217 currency code, required when the approved type is refund. */
    currency: varchar('currency', { length: 3 }),
    approvedByStaffUserId: uuid('approved_by_staff_user_id').references(() => staffUsers.id, {
      onDelete: 'set null',
    }),
    approvedAt: timestamp('approved_at', { withTimezone: true, mode: 'date' }),
    /** Encrypted approval rationale (may contain sensitive incident details). */
    approvalNoteEncrypted: text('approval_note_encrypted'),
    approvalNoteKeyVersion: varchar('approval_note_key_version', { length: 40 }),
    /** External business reference only — never a payment credential. */
    externalReference: varchar('external_reference', { length: 160 }),
    completionNoteEncrypted: text('completion_note_encrypted'),
    completionNoteKeyVersion: varchar('completion_note_key_version', { length: 40 }),
    completedByStaffUserId: uuid('completed_by_staff_user_id').references(() => staffUsers.id, {
      onDelete: 'set null',
    }),
    completedAt: timestamp('completed_at', { withTimezone: true, mode: 'date' }),
    /** Optimistic concurrency token; must be > 0. */
    version: integer('version').notNull().default(1),
    ...timestamps,
  },
  (table) => [
    // At most one Resolution per Recall Case.
    uniqueIndex('case_resolutions_case_uidx').on(table.caseId),
    index('case_resolutions_approved_idx').on(table.approvedType, table.status, table.approvedAt),
    index('case_resolutions_status_updated_idx').on(table.status, table.updatedAt),
    check('case_resolutions_version_chk', sql`${table.version} > 0`),
    // Currency, when present, must be a 3-letter uppercase ISO 4217 code.
    check(
      'case_resolutions_currency_chk',
      sql`${table.currency} is null or ${table.currency} ~ '^[A-Z]{3}$'`,
    ),
    // approved / externally_completed ⇒ approval fields are complete.
    check(
      'case_resolutions_approval_chk',
      sql`${table.status} not in ('approved', 'externally_completed')
          or (${table.approvedType} is not null
              and ${table.approvedByStaffUserId} is not null
              and ${table.approvedAt} is not null)`,
    ),
    // refund ⇒ amount + currency present and positive.
    check(
      'case_resolutions_refund_chk',
      sql`${table.approvedType} is distinct from 'refund'
          or (${table.refundAmountMinor} is not null
              and ${table.refundAmountMinor} > 0
              and ${table.currency} is not null)`,
    ),
    // replacement ⇒ amount + currency absent.
    check(
      'case_resolutions_replacement_chk',
      sql`${table.approvedType} is distinct from 'replacement'
          or (${table.refundAmountMinor} is null and ${table.currency} is null)`,
    ),
    // externally_completed ⇒ completion fields are complete.
    check(
      'case_resolutions_completion_chk',
      sql`${table.status} <> 'externally_completed'
          or (${table.completedByStaffUserId} is not null and ${table.completedAt} is not null)`,
    ),
  ],
);
