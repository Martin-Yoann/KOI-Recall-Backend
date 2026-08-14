import {
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

const timestamps = {
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
};

/**
 * Consumer (end-user) account status. Mirrors the staff lifecycle: `active`
 * allows login/session use; `disabled` blocks login but preserves the row so
 * historically submitted claims keep referencing a real consumer id.
 */
export const consumerStatusEnum = pgEnum('consumer_status', ['active', 'disabled']);

export const consumerSessionStatusEnum = pgEnum('consumer_session_status', [
  'active',
  'revoked',
  'expired',
]);

/**
 * Consumer accounts for the public web app (Phase 2). Email lookup is by HMAC
 * hash (same pattern as staff_users) so we never query on plaintext email.
 * Passwords use the same scrypt envelope as staff (`staff/password.ts`).
 */
export const consumerUsers = pgTable(
  'consumer_users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    emailLookupHash: varchar('email_lookup_hash', { length: 128 }).notNull(),
    email: text('email').notNull(),
    displayName: varchar('display_name', { length: 160 }).notNull(),
    /** Profile avatar as base64 data-URL (JPEG/PNG/WebP), max ~512 KiB. Null = initials fallback. */
    avatarDataUrl: text('avatar_data_url'),
    passwordHash: text('password_hash').notNull(),
    status: consumerStatusEnum('status').notNull().default('active'),
    lastLoginAt: timestamp('last_login_at', { withTimezone: true, mode: 'date' }),
    failedLoginAttempts: integer('failed_login_attempts').notNull().default(0),
    ...timestamps,
  },
  (table) => [uniqueIndex('consumer_users_email_lookup_hash_uidx').on(table.emailLookupHash)],
);

/**
 * Consumer bearer sessions. The opaque token is returned once at login; only
 * its SHA-256 hash is stored (capability-token pattern, same as staff_sessions).
 */
export const consumerSessions = pgTable(
  'consumer_sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => consumerUsers.id, { onDelete: 'cascade' }),
    tokenHash: varchar('token_hash', { length: 128 }).notNull(),
    status: consumerSessionStatusEnum('status').notNull().default('active'),
    issuedAt: timestamp('issued_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }).notNull(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true, mode: 'date' }),
    revokedAt: timestamp('revoked_at', { withTimezone: true, mode: 'date' }),
    ...timestamps,
  },
  (table) => [
    uniqueIndex('consumer_sessions_token_hash_uidx').on(table.tokenHash),
    index('consumer_sessions_user_status_idx').on(table.userId, table.status),
  ],
);
