import { sql } from 'drizzle-orm';
import {
  check,
  index,
  jsonb,
  pgEnum,
  pgTable,
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

/**
 * Fixed staff roles (ADR-0004 §2.2). The role→permission mapping is hardcoded
 * in `src/modules/staff/permissions.ts`; the enum is deliberately not a
 * free-form string so the matrix stays closed.
 */
export const staffRoleEnum = pgEnum('staff_role', [
  'viewer',
  'reviewer',
  'compliance',
  'administrator',
]);

/**
 * Staff account status. `disabled` blocks login and session use but preserves
 * the user row for audit history (`admin_audit_events.actor_user_id` is
 * onDelete set null, so disabling — not deleting — keeps the reference while
 * stopping access).
 */
export const staffUserStatusEnum = pgEnum('staff_user_status', ['active', 'disabled']);

/**
 * Session lifecycle. `active` sessions are usable; `revoked` is a deliberate
 * end (logout / role-down / password change / admin force-revoke); `expired`
 * is set when the hard ceiling passes (may be left to a cleanup job).
 */
export const staffSessionStatusEnum = pgEnum('staff_session_status', [
  'active',
  'revoked',
  'expired',
]);

/**
 * Outcome of an authorized operation recorded in the audit log. `denied`
 * captures permission-denied attempts; `error` captures failed authorized
 * attempts (both still produce a row for accountability).
 */
export const auditOutcomeEnum = pgEnum('audit_outcome', ['success', 'denied', 'error']);

export const staffUsers = pgTable(
  'staff_users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** HMAC of the normalized email, unique — lookup is by hash, email column holds plaintext only for display. */
    emailLookupHash: varchar('email_lookup_hash', { length: 128 }).notNull(),
    email: text('email').notNull(),
    displayName: varchar('display_name', { length: 160 }).notNull(),
    role: staffRoleEnum('role').notNull(),
    status: staffUserStatusEnum('status').notNull().default('active'),
    /** `node:crypto.scrypt` encoded hash (ADR-0004 §2.1). Nullable for future SSO-only users. */
    passwordHash: text('password_hash'),
    passwordChangedAt: timestamp('password_changed_at', { withTimezone: true, mode: 'date' }),
    lastLoginAt: timestamp('last_login_at', { withTimezone: true, mode: 'date' }),
    ...timestamps,
  },
  (table) => [uniqueIndex('staff_users_email_lookup_hash_uidx').on(table.emailLookupHash)],
);

export const staffSessions = pgTable(
  'staff_sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => staffUsers.id, { onDelete: 'cascade' }),
    /** SHA-256 of the opaque bearer token — plaintext returned once at issue, never stored (capability-token pattern). */
    tokenHash: varchar('token_hash', { length: 128 }).notNull(),
    status: staffSessionStatusEnum('status').notNull().default('active'),
    issuedAt: timestamp('issued_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }).notNull(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true, mode: 'date' }),
    revokedAt: timestamp('revoked_at', { withTimezone: true, mode: 'date' }),
    issuedIpHash: varchar('issued_ip_hash', { length: 128 }),
    issuedUserAgentHash: varchar('issued_user_agent_hash', { length: 128 }),
    ...timestamps,
  },
  (table) => [
    uniqueIndex('staff_sessions_token_hash_uidx').on(table.tokenHash),
    index('staff_sessions_user_status_idx').on(table.userId, table.status),
  ],
);

export const adminAuditEvents = pgTable(
  'admin_audit_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /**
     * The acting staff user. onDelete set null so deleting (not disabling) a
     * user does not erase compliance history; legacy/pre-bootstrap rows are null.
     */
    actorUserId: uuid('actor_user_id').references(() => staffUsers.id, {
      onDelete: 'set null',
    }),
    /** Role snapshot at action time — survives later role changes for accurate history. */
    actorRole: varchar('actor_role', { length: 24 }),
    action: varchar('action', { length: 80 }).notNull(),
    resourceType: varchar('resource_type', { length: 40 }),
    resourceId: varchar('resource_id', { length: 160 }),
    outcome: auditOutcomeEnum('outcome').notNull(),
    reasonCode: varchar('reason_code', { length: 80 }),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
    occurredAt: timestamp('occurred_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
    ipAddressHash: varchar('ip_address_hash', { length: 128 }),
    userAgentHash: varchar('user_agent_hash', { length: 128 }),
  },
  (table) => [
    index('admin_audit_events_actor_occurred_idx').on(table.actorUserId, table.occurredAt),
    index('admin_audit_events_resource_idx').on(table.resourceType, table.resourceId),
    index('admin_audit_events_action_occurred_idx').on(table.action, table.occurredAt),
    check('admin_audit_events_action_nonempty_chk', sql`char_length(${table.action}) > 0`),
  ],
);
