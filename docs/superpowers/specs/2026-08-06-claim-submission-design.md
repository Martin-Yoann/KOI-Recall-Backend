# Claim Submission and Field Encryption Design

Date: 2026-08-06
Branch: `main`
Status: Approved for written-spec review

## Goal

Implement `POST /v1/recall-campaigns/{slug}/claims` as the Phase 1 consumer-flow
completion point. A successful request must atomically create a durable Recall
Case, protect sensitive consumer and incident data, link verified evidence,
record consent and incident-review state, queue the confirmation communication,
and return the existing OpenAPI response.

This work also removes the current `RequestInit.duplex` TypeScript build blocker.
The public request and response contract remains unchanged.

## Approved Decisions

### Initial admin access model

Phase 1 uses one authorized backend-user permission level. Authorized backend
users may view and export complete Case data. Phase 1 does not implement separate
full-value and masked-value roles, field-level permissions, or masked display
variants.

Database clients do not receive encryption keys. Future admin viewing and export
operations must call backend application services that authorize the user,
decrypt only the requested records, and record an audit event. Admin read and
export endpoints themselves are outside this change.

### Transaction-capable Neon driver

Claim submission spans multiple related tables and cannot leave partial Cases.
The current `drizzle-orm/neon-http` driver explicitly does not support
interactive transactions, so the Neon path will move to
`drizzle-orm/neon-serverless` with `@neondatabase/serverless` `Pool`. Local and
other standard PostgreSQL URLs continue to use `drizzle-orm/node-postgres`.

Both database paths must expose the same transaction-capable Drizzle surface.
The Neon deployment must use a pooled Neon connection string appropriate for
serverless workloads. Database handles must expose an explicit close operation
for tests and long-running local processes; request handlers must not create a
new pool per request.

Alternatives considered and rejected:

- Using node-postgres for both local and Neon would simplify the type surface,
  but would move the deployment away from the existing Neon serverless adapter
  and require separate serverless pool tuning.
- Keeping Neon HTTP and using batches or a stored procedure would preserve the
  driver, but would move conditional validation and idempotency into a harder to
  maintain SQL workflow.

## Field Encryption

Implement a Node.js `SensitiveDataCryptoPort` adapter with these properties:

- AES-256-GCM with a fresh 96-bit nonce for every encrypted value.
- Authenticated ciphertext encoding that includes algorithm and key version, so
  values such as encrypted order numbers remain self-describing even where the
  table has no separate key-version column.
- A base64-encoded 32-byte `FIELD_ENCRYPTION_KEY` as the current encryption key.
- A base64-encoded `HASH_PEPPER` containing at least 32 random bytes.
- Key version `v1` for this release. The envelope and existing schema
  `key_version` columns preserve the extension point for a future keyring and
  rotation process; multi-key rotation tooling is not part of this change.
- HMAC-SHA-256 with a separately configured `HASH_PEPPER` for stable equality
  lookup hashes. The encryption key and lookup pepper must not be the same
  secret.
- Authentication failures, malformed envelopes, and unknown key versions fail
  closed and never return partial plaintext.

Normalize values before lookup hashing:

- Email: trim and lowercase.
- Address: canonical JSON with trimmed string fields and uppercase country code.
- Order number: trim and uppercase.
- Idempotency key: use the exact validated header value; store only its HMAC.

Encrypt these values before persistence:

- Consumer first name, last name, email, optional phone, and mailing address.
- Optional order number.
- Full normalized submission snapshot.
- Incident narrative.
- Confirmation-email recipient.

No plaintext sensitive value, raw draft token, encryption key, pepper, or full
request body may be written to logs, error details, analytics, outbox payloads,
or idempotency records.

When `DATABASE_URL` is configured but either encryption secret is absent, the
existing Campaign, product-check, Draft, and document services remain available;
Claim submission remains a `501 Not Implemented` capability. This preserves the
current partial-development workflow while making the production requirement
explicit.

## Claim Service Boundary

Change `CaseService.submit` to accept the validated claim command and return a
typed `ClaimSubmissionResponse`. Add `DrizzleCaseService`, using the database and
crypto ports. It owns the complete submission transaction because the Case,
incident, communication, document, idempotency, and outbox writes form one
aggregate operation.

The Hono route will:

1. Receive the already Zod-validated path, header, and body values.
2. Call `CaseService.submit`.
3. Parse the service result with `claimSubmissionResponseSchema` at the HTTP
   boundary.
4. Return HTTP 201 with the parsed response.

The route must no longer unconditionally return the current 501 response after
the service call.

## Submission Flow

### Preparation outside the transaction

Perform deterministic, non-database work before opening the transaction:

- Canonicalize the validated request and compute its SHA-256 request hash.
- Hash the idempotency key with the lookup pepper.
- Encrypt consumer fields, optional order numbers, the submission snapshot, and
  incident narrative.
- Generate the candidate Case UUID, public reference, and timestamps.

An initial idempotency lookup may return a previously committed response without
opening a transaction. The request hash must match; otherwise return 409.

### Transactional validation

Use a PostgreSQL transaction and lock the Draft row for update. Within that
transaction:

1. Verify the Draft exists, its token hash matches, it is active and unexpired,
   and its Campaign matches the path slug.
2. Verify the Campaign remains active. Use the Campaign version pinned to the
   Draft even if a newer version has since been published.
3. Verify every submitted `campaignProductId` belongs to the pinned version.
   Re-run the product matcher and persist its result. A preliminary
   `not_matched` or `manual_review` result does not reject the Claim; it routes
   the Case to triage.
4. Verify the requested Remedy is active for the pinned version.
5. Reject duplicate document IDs. Verify every referenced document belongs to
   the Draft and has `verified` status. Recalculate each evidence category's
   minimum and maximum counts from the pinned Campaign requirements.
6. Verify both required consent types are present exactly once and accepted.
7. Resolve the active confirmation message template for the pinned version and
   locale. A missing template is a server configuration error, not a consumer
   validation error.

### Atomic writes

After validation, write all of the following before committing:

- `recall_cases` with `submitted` status, or `triage` when any product needs
  review or `incidentAnswer` is `unsure`.
- `case_consumers` with encrypted values and lookup hashes.
- One `claimed_products` row per submitted product.
- One `case_consents` row per required consent.
- One encrypted `submission_snapshots` row.
- For `yes` or `unsure`, one `incidents` row and one pending
  `reportability_reviews` row. For `unsure`, absent event types normalize to
  `unknown`; an absent date normalizes to `occurredDateUnknown=true` so the
  persisted record satisfies the database invariant.
- Link each referenced `document_uploads` row to the Case, clear its Draft
  ownership and category slot, set status to `linked`, and set `linked_at`.
- Mark the Draft `submitted` and set `submitted_case_id`.
- Add a `case_events` submission audit event containing only non-sensitive
  identifiers and status metadata.
- Add a queued `communications` record with an encrypted recipient.
- Add a pending `outbox_events` record for confirmation delivery. Its payload
  contains record identifiers, not the plaintext recipient or message body.
- Add the completed `idempotency_records` response with a finite expiry.

`emailStatus: queued` means the transaction committed a communication and
outbox record. It does not mean Resend accepted or delivered the email.

### Concurrency and replay

- The Draft row lock serializes attempts to submit the same Draft with different
  idempotency keys. After the first commit, another attempt returns 409 unless it
  is a valid replay of the committed idempotency record.
- The existing unique `(endpoint, key_hash)` constraint is the final concurrency
  guard for the same key used by simultaneous requests.
- If the final idempotency insert loses a unique-key race, roll back the losing
  transaction, load the winning record, and return its response only when the
  request hash matches; otherwise return 409.
- Public-reference generation uses cryptographically secure randomness and
  retries a bounded number of times on the dedicated unique constraint.

No partial Case, linked document, incident, or queued email may remain when any
transactional step fails.

## Error Mapping

Use the existing Problem Details envelope and request ID.

- `400`: request schema failure, handled before the service.
- `404`: Campaign path does not identify the Draft's public Campaign.
- `409`: idempotency key reused with a different request, Draft already
  submitted, or a concurrent state conflict.
- `410`: Draft token invalid, Draft expired, or Draft no longer active.
- `422`: invalid product ownership, Remedy, evidence set, document status, or
  required consent.
- `501`: database or encryption provider not configured.
- `503`: database availability or connection failure.
- `500`: missing Campaign-owned configuration, invalid service response,
  cryptographic failure, or other unexpected server fault.

Consumer-facing errors must not reveal whether a Draft ID exists, ciphertext
contents, database constraint names, provider response bodies, or secret
configuration values.

## Initial Admin and Export Boundary

This change supplies reversible encryption and decryption but does not add an
admin API. When admin Case reads and exports are implemented later, Phase 1 will
use one authorization gate with full-value access:

- No separate masked/full roles or field-level policies.
- Decryption only in backend application services after authentication and
  authorization.
- Full-value views and exports create audit records with actor, time, purpose,
  selection scope, and record count.
- Export artifacts are short-lived and access-controlled.
- Raw SQL access and database backups remain ciphertext-only.

This boundary avoids premature RBAC complexity without weakening the database
breach boundary.

## Test Strategy

Follow red-green-refactor for each behavior.

### Crypto tests

- Encrypt/decrypt round trip for Unicode and empty optional values where
  allowed by the caller.
- Same plaintext produces different ciphertext because nonces are random.
- Tampered ciphertext, malformed envelopes, and unknown versions fail closed.
- Lookup hashes are stable for normalized equivalents and differ for different
  values.
- Invalid encryption-key and pepper configuration is rejected.

### HTTP and contract tests

- Valid service response returns 201 and satisfies
  `claimSubmissionResponseSchema`.
- Invalid service output becomes 500 rather than a contract-invalid 201.
- Domain failures map to 404, 409, 410, and 422 Problem Details.
- Missing providers retain 501 behavior.

### Database and transaction tests

- Driver selection uses Neon Serverless Pool for Neon and node-postgres locally;
  both expose working transactions.
- A valid Claim persists the complete aggregate and returns a public reference.
- Same idempotency key and same request replays the original response without
  duplicate rows.
- Same key with a different request returns 409.
- Concurrent submission of the same Draft creates exactly one Case.
- A forced failure after partial writes rolls back the entire aggregate.
- Product, Remedy, evidence, document, consent, and Draft-state violations leave
  the database unchanged.
- `yes` and `unsure` create pending incident review; `no` creates no incident.
- Only referenced verified documents become linked.
- The database contains no submitted plaintext PII, incident narrative, order
  number, raw draft token, or email recipient.

Database integration tests remain opt-in through `RUN_DB_INTEGRATION=true` and
must be run against the local PostgreSQL test database before completion.

### Completion checks

- Full Vitest suite and enabled database integration suite.
- TypeScript typecheck, including removal of the `RequestInit.duplex` error.
- ESLint and Prettier on task-owned files.
- OpenAPI consistency and Drizzle schema checks.
- Direct Hono `app.request()` proof of a 201 Claim response against seeded local
  data.

## Documentation and Operational Changes

Update the README and Phase 1 API/architecture documents to state:

- Claim submission is database-backed when the database and encryption secrets
  are configured.
- Confirmation email is queued locally but Resend delivery and its webhook
  remain unimplemented.
- Draft cleanup and physical Blob deletion remain separate follow-up work.
- The required encryption key format and secret-separation rule.
- Neon deployments require the transaction-capable serverless pool path.

Do not add real credentials, deploy Vercel, send email, implement admin APIs, or
change the public Claim contract in this work.
