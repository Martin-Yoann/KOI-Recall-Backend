import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';

import { recallCases } from './claims.js';

const timestamps = {
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
};

export const reportabilityReviewStatusEnum = pgEnum('reportability_review_status', [
  'pending',
  'filed',
  'documented_non_reportable',
]);

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
