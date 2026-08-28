# KOI Recall API

The public consumer-facing API for the KOI brand's product recall programme. Consumers look up active recall **campaigns**, run a preliminary **product check**, create an anonymous **claim draft**, attach **evidence** to it via direct upload, and **submit** it as a **recall case** for KOI to triage. This file is the project's shared language — use these terms exactly.

> **Status: draft skeleton.** Seeded from `src/db/schema/` and `src/contracts/toc.ts`. The canonical home for resolving terminology is a `/grill-with-docs` session; anything below marked _(confirm)_ is proposed, not settled. When you resolve a term, drop the _(confirm)_.

## Campaigns & catalogue

**Campaign**:
A single recall event for one or more products, identified by a `slug` (URL) and a human `code`. Has a lifecycle (`draft` → `scheduled` → `active` → `paused` → `closed`) and a published **campaign version**.
_Avoid_: recall, recall event (too generic — every table is a recall thing).

**Campaign version**:
An immutable snapshot of a campaign's localised content, products, remedy options, and evidence rules. Versioned by a positive `versionNumber`; only one is `published` per campaign at a time (others `draft` or `retired`).
_Avoid_: revision, edition.

**Localization**:
A locale-specific rendering of a campaign version (`title`, `summary`, `hazard`, `immediateAction`, `remedySummary`, support contacts, FAQ). Phase 1 ships `en-US` only; the model is multi-locale.
_Avoid_: translation, i18n entry.

**Lot** (campaign_product_lot):
A specific batch of a product under a campaign, identified by `lotCode` + `dateCode`, with an `eligibilityStatus` of `affected` / `not_affected` / `manual_review`.
_Avoid_: batch, run.

**Remedy option**:
A campaign-level resolution a consumer may choose (e.g. refund, replacement). Has a `code`, `displayName`, and whether it needs a mailing address.
_Avoid_: compensation, resolution, option.

**Evidence requirement**:
A per-category rule on a campaign version: how many files, which MIME types, max size. Categories are `product_photo`, `proof_of_purchase`, `incident_evidence`.
_Avoid_: upload rule, attachment rule.

## Product checks

**Product check**:
A _preliminary_, non-binding match test the consumer runs before opening a draft. Given product attributes + lot/date codes, returns `potential_match` / `not_matched` / `manual_review`. Not a final eligibility decision.
_Avoid_: eligibility check, product lookup.

## Claim lifecycle

**Claim**:
The consumer-facing name for a recall application, covering its draft and the recall case created on submission. It is not a separate operations record or a review stage before a case exists.
_Avoid_: separate claim approval, claim-to-case conversion after review.

**Claim draft** (claim_draft):
An expiring, anonymous workspace a consumer creates before submitting. Authorised by a one-time **draft token** (stored as `tokenHash`); has `active` / `submitted` / `expired` / `abandoned` status and an expiry. Holds the documents that become the eventual case's evidence.
_Avoid_: session, cart, claim-in-progress.

**Draft token**:
A secret string returned once at draft creation; the consumer sends it as `X-Draft-Token` to authorise draft-scoped operations (upload tokens, document delete). Never stored in clear — only its hash.
_Avoid_: draft key, draft secret, draft password.

**Upload token** (client-upload token):
A short-lived Vercel Private Blob credential the API mints so the browser uploads evidence _directly_ to blob storage, bypassing the Function. Bound to a draft, category, slot, and pathname prefix.
_Avoid_: upload URL, presigned URL (it's a token, not a URL), blob token.

**Document upload** (document_upload):
One evidence file attached to a draft or case. Tracks its own lifecycle (`authorized` → `uploaded` → `verified` → `linked`, or `rejected`/`deletion_pending`/`deleted`), malware scan, and storage pathname.
_Avoid_: attachment, file, evidence item.

**Recall case** (recall_case):
The submitted, durable record of a consumer's claim, created from a draft at submission without waiting for approval. Identified to the consumer by a `publicReference` (`KOI-XXXX-XXXXXXXX`), the same case carries the original application and its subsequent handling through the triage lifecycle (`submitted` → `triage` → `under_review` → `need_info` → `approved`/`rejected`/`duplicate`/`withdrawn` → `closure_review` → `closed`).
_Avoid_: ticket, claim (a draft + its case together are "the claim" to a consumer — in code keep them distinct), report.

**Public reference**:
The human-facing case ID shown to the consumer (`KOI-XXXX-XXXXXXXX`). Distinct from the internal UUID `id`.
_Avoid_: case number, reference number, case ID.

**Submission snapshot**:
An encrypted, immutable capture of exactly what was submitted for a case (`encryptedPayload` + `payloadSha256`). Created once at submission for audit.
_Avoid_: claim copy, record version.

## Incidents & reportability

**Incident**:
An adverse event a consumer may report with a claim (only when `incidentAnswer` is `yes`/`unsure`). Records event types, an encrypted narrative, severity, medical treatment, when it occurred. A case carries at most one.
_Avoid_: accident, event (generic), report.

**Reportability review**:
The internal decision of whether an incident must be filed with the regulator (CPSC). Status `pending` → `filed` (with `cpscReference`) or `documented_non_reportable`.
_Avoid_: compliance review, filing.

## Cross-cutting mechanics

**Outbox event** (transactional outbox):
A row written in the same transaction as a domain change, later drained by a cron job to the provider (Resend). Decouples submission success from email delivery. Deduped by `deduplicationKey`.
_Avoid_: queue message, event (too generic — use outbox event vs. case event vs. incident event deliberately).

**Case event**:
An append-only audit record on a case (`caseEvents` table) — who/what did what, when. The system's own event sourcing for a case, distinct from outbox events.
_Avoid_: log entry, audit log (too infra-flavoured).

**Webhook event**:
An inbound provider notification (`webhook_events`), deduped by `provider` + `providerEventId`. Currently `vercel-blob` (upload completion) and `resend` (email delivery).
_Avoid_: callback, notification.

**Idempotency record**:
Persisted result of a prior `Idempotency-Key`-tagged request, replayed verbatim on retry. Keyed by endpoint + hashed key, with a `requestHash` to detect payload drift.
_Avoid_: cache entry, dedup record.

## Privacy & security

**AEAD encryption**:
Application-layer authenticated encryption applied to PII at rest (consumer names, email, phone, address, narratives). Each ciphertext carries a `keyVersion`. The transparent column values are `*_encrypted`.
_Avoid_: field encryption (say AEAD — it implies authenticated), column encryption.

**Lookup hash** (peppered HMAC):
A deterministic, peppered HMAC of a PII value (`emailLookupHash`, `addressLookupHash`, `orderNumberLookupHash`) enabling dedup/lookup without exposing the plaintext. `HASH_PEPPER` is the secret.
_Avoid_: hash (too generic), index, digest.

**Masking**:
The logging convention that PII and storage pathnames are never logged in clear — emails/phones/addresses/tokens/pathnames are redacted or truncated before hitting logs.
_Avoid_: redaction (use masking in this codebase), scrubbing.

## B-end operations (ADR-0004)

**Staff user** (运营主体):
An internal operator with a `staff_users` row — email, display name, fixed `role`, status, and a `node:crypto.scrypt` password hash. The named principal behind every authorized B-end action. Email is looked up by peppered HMAC (`emailLookupHash`), stored plaintext only for display.
_Avoid_: account, login, user (too generic — say staff user to distinguish from consumers).

**Staff session**:
An opaque bearer token + its server-stored `SHA-256` digest (`staff_sessions`), mirroring the draft capability-token pattern. Issued at login, rotated on refresh, revoked on logout / role-down / disable. Plaintext returned once.
_Avoid_: JWT (rejected — revocation is hard), API key.

**Permission** (`resource:action`):
A verb the RBAC matrix grants to a role, e.g. `case.detail.read_pii_raw`. `read_pii_raw` is deliberately NOT implied by `case.detail.read` — a reviewer sees masked PII only; raw PII requires an independent grant and writes an audit event.
_Avoid_: scope, claim (too OAuth-flavoured).

**PII tier** (`masked` / `raw`):
Which view of consumer PII a role sees on case detail. `masked` runs every PII field through `pii-masking.ts`; `raw` decrypts in plaintext and is gated behind `case.detail.read_pii_raw` + an audit row. Decided centrally by `piiTierFor(role)`.
_Avoid_: field-level permission (this is a field-set tier, not per-field).

**Admin audit event** (`admin_audit_events`):
The cross-surface compliance log — every authorized write, every raw-PII read, and every denied attempt, with actor (FK to `staff_users`), role snapshot, action, resource, outcome, and a best-effort IP/UA hash. Complements case-scoped `caseEvents`; the two do not duplicate.
_Avoid_: case event (that's case-scoped), log, trail.

**Assignment** (`recall_cases.assignedToStaffUserId`):
The staff user a case is assigned to (nullable, FK to `staff_users`). Orthogonal to the status-derived queue — assignment is "who's responsible," queue is "what state is it in."
_Avoid_: owner, ticket.

## Architecture

**Port**:
A provider interface defined under `src/platform/` (blob, email, crypto, observability). The seam the rest of the system depends on; satisfied by an adapter. _Per codebase-design: small interface, deep implementation behind it._
_Avoid_: interface (too narrow), contract, gateway.

**Adapter**:
A concrete implementation satisfying a port at the seam — e.g. `VercelBlobAdapter`, `NodeSensitiveDataCrypto`, `not-implemented` stubs. Selected in `composition.ts`.
_Avoid_: provider (that's the external service), implementation (too generic), plugin.

**Composition** (`composition.ts`):
The single wiring point that assembles the registry: which adapter satisfies which port, which service gets which repository. The DI root.
_Avoid_: container, registry, bootstrap (say composition to match the filename).
