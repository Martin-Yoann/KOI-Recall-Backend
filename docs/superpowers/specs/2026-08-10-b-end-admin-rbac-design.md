# B-end Admin RBAC Upgrade Design

Date: 2026-08-10
Branch: `main`
Status: Implemented (B1–B9 done, 2026-08-11; M2 dual-mode active, M3 cutover pending operator migration)

## Goal

Upgrade the internal-operations (B-end) surface from the current single-role
single-secret model (`ADMIN_API_KEY`) to a staff-identity + fixed-role RBAC +
two-tier PII + cross-surface audit model. This operationalizes the "Initial
admin and export boundary" promise in the Claim submission design
(`docs/superpowers/specs/2026-08-06-claim-submission-design.md`, "Initial
admin and export boundary") and the deferred "multi-level RBAC / field
masking" item from `docs/optimization-plan-v1.md` §1.

ADR-0004 records the architectural decisions. This document specifies the
schema, endpoints, middleware, migration, and task breakdown.

## Decisions (from user, recorded in ADR-0004)

1. **Identity**: database principals (`staff_users`) + session tokens
   (opaque, server-stored hash). NOT static API keys, NOT body-declared.
2. **RBAC granularity**: fixed roles (`viewer` / `reviewer` / `compliance` /
   `administrator`), role→permission mapping hardcoded. NOT fine-grained
   scopes, NOT ABAC.
3. **PII visibility**: two tiers — masked by default, raw requires privilege
   (`case.detail.read_pii_raw`), each raw view writes audit. NOT all-raw,
   NOT all-masked.
4. **Deliverable**: ADR + design draft first, code after review.

## Scope

In scope: new `staff_users` / `staff_sessions` / `admin_audit_events` tables;
staff-auth middleware; permission matrix; masked/raw PII split in case detail;
assignment; status transitions; audit on all authorized writes + raw-PII reads;
login/logout/refresh endpoints; a minimal administrator bootstrap path.

Out of scope (deferred): SSO/OIDC; field-level permissions; CPSC auto-filing;
audit retention/archival policy; permission-management UI (roles are code-fixed).

---

## Schema

New file `src/db/schema/staff.ts`. New tables:

### `staff_users`

| column                      | type                                    | notes                                                                                              |
| --------------------------- | --------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `id`                        | uuid PK                                 |                                                                                                    |
| `email_lookup_hash`         | varchar(128) not null, unique           | HMAC-SHA-256(email normalized), reuses `HASH_PEPPER`                                               |
| `email`                     | text not null                           | plaintext for display only (internal tool)                                                         |
| `display_name`              | varchar(160) not null                   |                                                                                                    |
| `role`                      | staff_role enum not null                | `viewer`/`reviewer`/`compliance`/`administrator`                                                   |
| `status`                    | varchar(16) not null default `'active'` | `active`/`disabled`                                                                                |
| `password_hash`             | text                                    | `node:crypto.scrypt` encoded hash (N/r/p + salt + digest); nullable only for future SSO-only users |
| `password_changed_at`       | timestamptz                             |                                                                                                    |
| `last_login_at`             | timestamptz                             |                                                                                                    |
| `created_at` / `updated_at` | timestamptz                             | shared `timestamps` helper                                                                         |

Indexes: `uniqueIndex(staff_users_email_lookup_hash_uidx)` on `email_lookup_hash`.

### `staff_sessions`

| column                   | type                                                 | notes                                |
| ------------------------ | ---------------------------------------------------- | ------------------------------------ |
| `id`                     | uuid PK                                              |                                      |
| `user_id`                | uuid not null FK → `staff_users.id` onDelete cascade |                                      |
| `token_hash`             | varchar(128) not null, unique                        | `SHA-256(opaque token)`              |
| `status`                 | varchar(16) not null default `'active'`              | `active`/`revoked`/`expired`         |
| `issued_at`              | timestamptz not null default now()                   |                                      |
| `expires_at`             | timestamptz not null                                 | hard ceiling, default +7d from issue |
| `last_used_at`           | timestamptz                                          | sliding refresh updates this         |
| `revoked_at`             | timestamptz                                          |                                      |
| `issued_ip_hash`         | varchar(128)                                         | HMAC of issuing IP, audit/security   |
| `issued_user_agent_hash` | varchar(128)                                         |                                      |

Indexes: `uniqueIndex(staff_sessions_token_hash_uidx)`; `index(staff_sessions_user_status_idx)` on `(user_id, status)` for bulk-revoke.

### `admin_audit_events`

| column            | type                                         | notes                                                                   |
| ----------------- | -------------------------------------------- | ----------------------------------------------------------------------- |
| `id`              | uuid PK                                      |                                                                         |
| `actor_user_id`   | uuid FK → `staff_users.id` onDelete set null | nullable: system/legacy/pre-bootstrap                                   |
| `actor_role`      | varchar(24)                                  | role snapshot at action time                                            |
| `action`          | varchar(80) not null                         | e.g. `pii.view_raw`, `review.close`, `case.export`, `staff.role.change` |
| `resource_type`   | varchar(40)                                  | `case`/`review`/`user`/`session`                                        |
| `resource_id`     | varchar(160)                                 | caseReference / reviewId / userId                                       |
| `outcome`         | varchar(16) not null                         | `success`/`denied`/`error`                                              |
| `reason_code`     | varchar(80)                                  |                                                                         |
| `metadata`        | jsonb default `{}`                           | selection scope, field set, row count                                   |
| `occurred_at`     | timestamptz not null default now()           |                                                                         |
| `ip_address_hash` | varchar(128)                                 |                                                                         |
| `user_agent_hash` | varchar(128)                                 |                                                                         |

Indexes: `index(admin_audit_events_actor_occurred_idx)` on `(actor_user_id, occurred_at)`;
`index(admin_audit_events_resource_idx)` on `(resource_type, resource_id)`;
`index(admin_audit_events_action_occurred_idx)` on `(action, occurred_at)`.

> Separate from `case_events` (`operations.ts:46`): `case_events` is the
> **case-timeline** view (consumer-facing lifecycle); `admin_audit_events`
> is the **operations/compliance** view (who accessed/changed what). They
> complement, do not duplicate.

### `recall_cases` additions

| column                      | type                                         | notes    |
| --------------------------- | -------------------------------------------- | -------- |
| `assigned_to_staff_user_id` | uuid FK → `staff_users.id` onDelete set null | nullable |
| `assigned_at`               | timestamptz                                  |          |

Index: `index(recall_cases_assignee_idx)` on `(assigned_to_staff_user_id, status)`.

> `queue` stays derived from `status`+`incidentFlag` (as in
> `drizzle-admin-service.ts:17-43`); no new queue column. Assignment is
> orthogonal to queue.

### Enums

`staff_role` pgEnum: `viewer`, `reviewer`, `compliance`, `administrator`.

### Barrel re-export

Add `staff` to `src/db/schema/index.ts` barrel (`staff_users`, `staff_sessions`,
`admin_audit_events`, `staffRoleEnum`).

---

## Permission Matrix

Hardcoded in `src/modules/staff/permissions.ts` (pure function, unit-tested):

```ts
export type StaffRole = 'viewer' | 'reviewer' | 'compliance' | 'administrator';

export type Permission =
  | 'case.queue.read'
  | 'case.detail.read' // masked PII
  | 'case.detail.read_pii_raw' // raw PII + audit
  | 'case.export'
  | 'case.assign'
  | 'case.status.transition'
  | 'review.close'
  | 'audit.read'
  | 'staff.manage';

const ROLE_PERMISSIONS: Record<StaffRole, ReadonlySet<Permission>> = {
  viewer: new Set(['case.queue.read', 'case.detail.read']),
  reviewer: new Set([
    'case.queue.read',
    'case.detail.read',
    'case.assign',
    'case.status.transition',
  ]),
  compliance: new Set([
    'case.queue.read',
    'case.detail.read',
    'case.detail.read_pii_raw',
    'case.export',
    'case.assign',
    'case.status.transition',
    'review.close',
  ]),
  administrator: new Set(/* all permissions */),
};

export function hasPermission(role: StaffRole, perm: Permission): boolean {
  return ROLE_PERMISSIONS[role]?.has(perm) ?? false;
}
```

> `case.detail.read_pii_raw` is **not** implied by `case.detail.read`. A
> `reviewer` sees masked PII only. This is the two-tier PII decision.

---

## PII Masking

Pure function in `src/modules/admin/pii-masking.ts` (no DB, unit-tested):

```ts
maskEmail('jane.doe@example.com'); // 'j***@e*****.com'
maskPhone('+15551234567'); // '+1 ••• ••• 4567'
maskName('Jane'); // 'J•'
maskAddress({ city, state, country }); // city/state/country only; street/postal masked
```

Case detail service method signature (PII tier decided by caller's permission):

```ts
getCaseDetail(
  caseRef: string,
  viewer: StaffPrincipal,
): Promise<{ case: CaseDetail; piiTier: 'masked' | 'raw' }>
```

- If `hasPermission(viewer.role, 'case.detail.read_pii_raw')` → decrypt, tier `raw`, write `admin_audit_events` (action `pii.view_raw`).
- Else → decrypt then mask, tier `masked`, **no** audit row.

Decrypt-then-mask ensures masked output reflects real data without leaking
raw; masking is cheap string work.

---

## Staff Auth Middleware

New `src/middleware/staff-auth.ts`, applied to `/admin/*` (per-group, like
the rate limiter on `/v1/*`):

1. Extract `Authorization: Bearer <token>`.
2. Compute `SHA-256(token)`, look up `staff_sessions` by `token_hash` where
   `status='active'` and `expires_at > now()` and joined user `status='active'`.
3. On miss → 401 Problem Details.
4. On hit → build `StaffPrincipal { userId, role, displayName, sessionId }`,
   set `context.set('principal', principal)`, bump `last_used_at` (sliding
   refresh, capped at `expires_at`).
5. `next()`.

Extend `AppEnv` (`src/middleware/request-context.ts:3-9`):

```ts
export interface AppEnv {
  Variables: {
    requestId: string;
    clientSource: string;
    principal?: StaffPrincipal; // NEW
  };
}
```

Existing `/internal/*` (cron) and `/webhooks/*` stay on their own auth
(`CRON_SECRET` / provider signatures) — staff-auth is `/admin/*` only.

---

## Endpoints

All under `/admin/*`, not part of public OpenAPI (consistent with current
admin routes). Session endpoints are unauthenticated for login only.

### Session (new)

| Method + Path                  | Permission          | Body / Result                                                                       |
| ------------------------------ | ------------------- | ----------------------------------------------------------------------------------- |
| `POST /admin/sessions`         | (none — login)      | `{ email, password }` → `{ token, expiresAt }` (token shown once); 401 on bad creds |
| `DELETE /admin/sessions`       | (any authenticated) | revoke current session → 204                                                        |
| `POST /admin/sessions/refresh` | (any authenticated) | extend `last_used_at`/re-issue if near expiry → `{ token, expiresAt }`              |

> Login does **not** require a principal (chicken-and-egg). Login is rate-limited
> aggressively (per-IP bucket). **Multi-instance caveat**: the existing
> `InMemoryRateLimiter` (`src/middleware/rate-limit.ts:75-79`) only works for
> single-instance Vercel Node functions — under multiple instances its counts
> fragment and the limit is effectively bypassed. For login brute-force
> protection to hold in production (multi-instance), this must move to a shared
> store (Upstash Redis / Vercel KV). Until that shared store exists, treat the
> login rate limit as a preview-grade control and add DB-level per-account
> lockout (failed-attempt counter on `staff_users`, enforced at login) as the
> correctness backstop that does not depend on instance count.

### Staff management (new, `staff.manage`)

| Method + Path                        | Permission     | Body / Result                                                                                                     |
| ------------------------------------ | -------------- | ----------------------------------------------------------------------------------------------------------------- |
| `GET /admin/staff`                   | `staff.manage` | list users (id, email, displayName, role, status, lastLoginAt)                                                    |
| `POST /admin/staff`                  | `staff.manage` | `{ email, displayName, role, password }` → create user; 409 if email exists                                       |
| `PATCH /admin/staff/:id`             | `staff.manage` | `{ role?, status?, displayName? }`; role/status change writes audit `staff.role.change` and revokes user sessions |
| `DELETE /admin/sessions/by-user/:id` | `staff.manage` | revoke all sessions of a user (disable/role-down)                                                                 |

### Case surface (existing + new)

| Method + Path                                 | Permission               | Change                                                                              |
| --------------------------------------------- | ------------------------ | ----------------------------------------------------------------------------------- |
| `GET /admin/cases`                            | `case.queue.read`        | unchanged shape; auth moves from `requireAdminKey` to staff-auth + permission check |
| `GET /admin/cases/export`                     | `case.export`            | writes audit (`case.export`, metadata: row count, filters); auth as above           |
| `GET /admin/cases/:caseRef`                   | `case.detail.read`       | **new** — case detail, PII tier by `read_pii_raw`; raw tier writes audit            |
| `POST /admin/cases/:caseRef/assign`           | `case.assign`            | **new** — `{ staffUserId }` sets `assigned_to_staff_user_id` + audit                |
| `POST /admin/cases/:caseRef/status`           | `case.status.transition` | **new** — `{ status }` legal-transition check + audit + case_event                  |
| `POST /admin/reportability-reviews/:id/close` | `review.close`           | unchanged logic; `reviewerId` now sourced from principal; writes audit              |

### Audit (new)

| Method + Path             | Permission   | Body / Result                                              |
| ------------------------- | ------------ | ---------------------------------------------------------- |
| `GET /admin/audit-events` | `audit.read` | query by actor / resource / action / date range, paginated |

### Error mapping (Problem Details, RFC 9457)

- `401` no/invalid session token.
- `403` valid session but lacking permission (writes `outcome=denied` audit).
- `404` case/review/user not found.
- `409` duplicate email, illegal status transition.
- `422` malformed input (reuses existing `ClaimValidationError`).
- `423` account disabled (optional; can fold into 401).
- `501` staff service not configured (consistent with existing 501-on-unwired
  pattern, `docs/.../unimplemented-method-error-type` memory).

---

## Audit Writing

Every authorized write, every raw-PII read, and every denied attempt writes
exactly one `admin_audit_events` row, synchronously in the same operation
(transaction for writes; post-decrypt for reads). `actor_role` is a snapshot
so historical records survive later role changes. The audit write itself
never fails the user request silently — on audit write error, fail the
operation (fail-closed for writes; for raw-PII read, deny the read).

---

## Administrator Bootstrap

There is no user at first deploy. Two equivalent options (pick during impl):

1. **CLI script** `scripts/bootstrap-staff.ts` — `pnpm staff:bootstrap`
   reads email + initial password (prompted, not args), creates the first
   `administrator`. Idempotent (409 if email exists).
2. **First-deploy env var** `STAFF_BOOTSTRAP_ADMIN_EMAIL` +
   `STAFF_BOOTSTRAP_ADMIN_PASSWORD` — on app start, if `staff_users` is
   empty and these are set, create the administrator once, then log a
   warning to clear them.

Prefer the CLI script — avoids plaintext password in env config and the
"did it run?" ambiguity.

---

## Migration (M1–M3, online, rollback-safe)

Follows the ADR-0003 four-stage online-migration discipline.

### M1 — Add (additive, zero behavior change)

- Add `staff_users`, `staff_sessions`, `admin_audit_events` tables.
- Add `assigned_to_staff_user_id` + `assigned_at` to `recall_cases` (nullable).
- Add `staff_role` enum.
- drizzle migration `0006_*.sql` (additive only; `generate` then `migrate`
  is a no-op the second time).
- No route/middleware change in M1. Existing `ADMIN_API_KEY` continues to gate
  `/admin/*`.

### M2 — Dual-mode (staff-auth alongside legacy key)

- Add staff-auth middleware; apply to `/admin/*` **in addition to** the
  existing `ADMIN_API_KEY` check: a request is authorized if **either** a
  valid staff session **or** the legacy `ADMIN_API_KEY` bearer is present.
- New endpoints (case detail, assign, status, sessions, staff mgmt, audit)
  require staff session (no legacy fallback) — they are net-new.
- Existing endpoints (`/admin/cases`, export, review close) accept either
  credential; if via staff session, enforce permission + write audit; if via
  legacy key, log a deprecation warning and proceed (no permission enforcement
  — backward compat).
- Bootstrap the first administrator (CLI).
- Run both paths in CI/preview. Migrate operators onto staff sessions.

### M3 — Cutover (remove legacy key)

- Remove the `ADMIN_API_KEY` dual-acceptance; `/admin/*` requires a valid
  staff session exclusively. Missing/unauthorized → 401.
- Remove `ADMIN_API_KEY` from `src/config/env.ts` (or keep as no-op for
  reference, marked deprecated).
- Backfill: leave existing discrete actor columns (`reviewer_id`, `actor_id`,
  `published_by`) as-is — no FK added, no data migration. New code writes
  both the legacy column (for continuity) and `admin_audit_events.actor_user_id`
  (FK, the source of truth going forward).

### Rollback

- M1/M2 are additive; reverting the route/middleware changes restores
  single-key behavior with no data loss.
- M3 is the one-way door; only cut over once all operators are confirmed on
  staff sessions in preview.

---

## Test Strategy (red-green-refactor)

### Pure-function unit tests

- `permissions.ts`: every `(role, permission)` pair matches the matrix;
  `read_pii_raw` not implied by `detail.read`.
- `pii-masking.ts`: email/phone/name/address masking for unicode, short
  inputs, missing optionals.
- `password.ts`: `node:crypto.scrypt` hash/verify round-trip (params at OWASP
  recommended N/r/p); wrong password fails constant-time; rejects
  empty/oversized; no native-module dependency introduced.

### Middleware tests (`app.request()`)

- No token → 401.
- Expired/revoked/disabled-user token → 401.
- Valid token sets `principal`; `last_used_at` updated.
- Permission-denied → 403 + `outcome=denied` audit row.

### HTTP/contract tests

- Login: correct creds → token + session row; wrong creds → 401; disabled
  user → 401; login rate-limited after N failures.
- Logout: revokes current session; subsequent use → 401.
- Case detail: reviewer → masked PII, no audit; compliance → raw PII + audit
  `pii.view_raw`.
- Export: writes `case.export` audit with row count.
- Assign / status transition: legal + illegal transitions; audit on legal,
  409 on illegal.
- Review close: `reviewerId` sourced from principal; audit written.
- Staff management: only `administrator`; role change revokes target user
  sessions.

### DB integration tests (`RUN_DB_INTEGRATION=true`)

- Schema invariants: unique email hash, unique token hash, FK behavior on
  user delete (`actor_user_id` set null, sessions cascade).
- `recall_cases.assigned_to_staff_user_id` FK onDelete set null.
- Audit row count and content for a representative flow.

### Completion checks

- `pnpm build` (typecheck + openapi:check + db:check) green.
- `pnpm lint`, `prettier --check` on task-owned files.
- Default Vitest + DB integration suite green.
- OpenAPI public contract (`/v1/*`) byte-unchanged (`openapi:check`).
- Manual proof: bootstrap admin → login → create reviewer → reviewer logs in
  → reviewer views case (masked) → compliance views same case (raw, audited).

---

## Documentation Updates

- `docs/adr/README.md`: add ADR-0004 to the index.
- `README.md`: replace the "single authorized backend role" / "no multi-level
  permissions" statements with the new model; note bootstrap command.
- `CONTEXT.md`: add terms (Staff User, Staff Session, Permission,
  Admin Audit Event, PII Masking, Assignment) to the ubiquitous language.
- `docs/phase-1/03-toc-api.md`: unchanged (admin routes are not part of the
  public ToC contract); add a note that admin surface is documented separately.

---

## Task Breakdown (proposed; full ticketing out of scope for this draft)

| ID  | Theme                                                                                                     | Depends on     |
| --- | --------------------------------------------------------------------------------------------------------- | -------------- |
| B1  | Schema: `staff_users` / `staff_sessions` / `admin_audit_events` + `recall_cases` additions + migration M1 | —              |
| B2  | `permissions.ts` + `password.ts` + `pii-masking.ts` pure modules + tests                                  | —              |
| B3  | staff-auth middleware + `AppEnv` extension + `StaffPrincipal`                                             | B1             |
| B4  | Staff/session service (`sessions.ts`, `drizzle-staff-service.ts`) + audit service                         | B1, B2         |
| B5  | Login/logout/refresh endpoints                                                                            | B3, B4         |
| B6  | Staff management endpoints + bootstrap CLI                                                                | B4, B5         |
| B7  | Migrate existing 3 admin endpoints to staff-auth + permission + audit (M2 dual-mode)                      | B3, B4         |
| B8  | Case detail (masked/raw) + assign + status transition endpoints                                           | B4, B7         |
| B9  | Audit read endpoint                                                                                       | B4             |
| B10 | M3 cutover: remove legacy `ADMIN_API_KEY`; docs updates                                                   | B6, B7, B8, B9 |

Critical path: B1 → B3 → B4 → B7 → B8. B2 is parallel. B5/B6 gate operator
onboarding. B10 is the one-way-door, done last.

---

## Deployment Notes (Vercel ecosystem fit)

This design was reviewed against the project's Vercel-ecosystem deployment
(Vercel Node Functions + Neon Serverless Pool + Vercel Private Blob + Resend
via Vercel Cron). Fit conclusions:

- **DB driver**: Neon serverless `Pool` already supports interactive
  transactions (`src/db/client.ts:24,65`), so session lookup + audit write in
  one transaction is feasible — no driver change needed.
- **Runtime**: Node Runtime (not Edge), Node 24 — `node:crypto` and the
  planned `scrypt` are built-in and usable; no native addon required.
- **Session token hashing** mirrors the existing claim-draft capability-token
  pattern (`crypto.getRandomValues` + `createHash('sha256')`,
  `src/modules/claim-drafts/tokens.ts`) — consistent with established
  convention.
- **Per-request DB cost**: protected routes (`/admin/*`, `/v1/*`) already hit
  the DB per request; adding one session lookup is consistent, not a new cost
  pattern.
- **Vercel Cron** (`vercel.json` has **no `crons` block** today): this design
  does not itself add a cron job, but future follow-ups (expired-session
  cleanup, audit archival) would reuse the `/internal/jobs/*` path. Those
  assume Vercel Cron is configured out-of-band (or a future `crons` entry is
  added to `vercel.json`); the code side (`requireCronSecret` +
  `FOR UPDATE SKIP LOCKED`) is already in place.
- **No new Vercel-ecosystem component introduced** (no KV/Edge Config/Postgres
  needed for the core design; a shared rate-limit store, if added later, is the
  only potential new component — see Open Question 3).

---

## Open Questions (for review)

1. **Session lifetime / refresh policy**: propose hard ceiling 7d, sliding
   `last_used_at` with no re-issue, force re-login after ceiling. Alternative:
   sliding re-issue (rotate token on activity). Prefer the simpler
   no-reissue default; confirm.
2. **Password policy**: propose min 12 chars, no complexity rules (NIST-style),
   hashed via `node:crypto.scrypt` (OWASP params) — **decided: scrypt, not
   argon2id, to avoid the repo's first native-module dependency** (see ADR-0004
   §2.1/§6-H). Confirm min length.
3. **Login rate limit**: propose per-IP bucket (5 / min) + per-email backoff
   (exponential after 5 fails, 15 min lock). **Multi-instance caveat**:
   `InMemoryRateLimiter` only holds under single-instance; for production
   brute-force protection add a DB-level per-account failed-attempt lockout
   (does not depend on instance count) and treat the IP-bucket limiter as
   preview-grade until a shared store (Upstash/Vercel KV) is wired. Confirm
   thresholds.
4. **Audit retention**: defer (out of scope here) or set a default (e.g.,
   retain 1y, then archive)? Propose defer.
5. **Disabled-user response**: 401 vs 423. Propose 401 to avoid revealing
   account state to brute-forcers.
