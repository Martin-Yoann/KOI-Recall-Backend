# Claim submission final-review fix report

## Scope and result

- Worktree: `/Users/alexyuan/koi/koi-recall-api/.worktrees/claim-submission`
- Branch: `codex/claim-submission`
- Fix baseline: `63342e475fcaa43fbba260d3b9c8e05b14c6e19d`
- Implementation commit: `035d166` (`fix: resolve claim final review findings`)
- Result: all eight Important findings and the stale Neon HTTP/non-interactive-transaction wording were addressed in this single fix wave.
- Preserved boundaries: no public Claim request/response schema, OpenAPI, Drizzle schema, or migration change; no Resend, Admin API, multi-role authorization, masking, deployment, cleanup worker, Private Blob deletion, `.vscode`, or `.zcode` work.

## Finding-by-finding implementation and TDD evidence

### 1. Attachment deletion race

Implementation:

- The HTTP route passes the Draft token into `DocumentService` instead of validating it in a separate operation.
- `DrizzleDocumentService` now runs deletion in one transaction, locks Draft then Document, validates the token/status/expiry while holding the Draft lock, and updates only `id + draft_id + case_id IS NULL + allowed status` with `RETURNING`.
- `linked` is no longer a deletable status. Claim and delete use the same Draft-to-Document lock order, so a Document cannot be marked for deletion after Claim association.
- The real PostgreSQL race test pauses Claim after it owns the Draft lock and observes the bounded delete transaction; Claim commits, delete deterministically returns 410, and the linked Document remains linked.

Files: `src/app.ts`, `src/composition.ts`, `src/modules/documents/service.ts`, `src/modules/documents/drizzle-document-service.ts`, `tests/app-claim-draft.test.ts`, `tests/case-integration.test.ts`, `tests/document-reconciliation.test.ts`.

RED:

- `tests/app-claim-draft.test.ts`: standalone Draft validation was called once; expected zero calls.
- Real PostgreSQL focused run: the Claim/delete race let deletion fulfill when the test expected rejection after Claim association.

GREEN:

- App Draft tests: 13/13 passed.
- Focused real PostgreSQL/HTTP set for findings 1-2: 5/5 passed, including the bounded race.

### 2. Draft validation/error order

Implementation:

- The locked Draft token is checked before submitted/expired status and before campaign/path ownership.
- A valid submitted Draft replays the same-key winner, but a new key returns `ClaimConflictError`/409.
- Invalid, expired, or otherwise unusable Drafts return 410 before path differences can be observed; only an authenticated usable Draft reaches campaign/path validation.

Files: `src/modules/cases/drizzle-case-service.ts`, `tests/case-http-integration.test.ts`, `tests/case-integration.test.ts`.

RED:

- Invalid token plus wrong campaign slug returned 404 instead of 410.
- Valid submitted Draft plus a new idempotency key returned DraftExpired/410 instead of Conflict/409.
- The service-level oracle case returned `ResourceNotFoundError` instead of `DraftExpiredOrInvalidError`.
- A concurrent same-Draft loser was classified as DraftExpired instead of Conflict when it did not own a same-key winner.

GREEN:

- Focused real PostgreSQL/HTTP set: 5/5 passed.
- HTTP proof included initial 201, same-key replay 201, and submitted/new-key 409.

### 3. Persist `manual_review` as a real third state

Implementation:

- Matcher output is now `potential_match | manual_review | not_matched`.
- Priority is `affected/potential_match` over `manual_review` over `not_matched`.
- The actual matcher result is persisted on each claimed product, and every non-`potential_match` result routes the Case to triage.

Files: `src/modules/product-checks/matcher.ts`, `src/modules/cases/drizzle-case-service.ts`, `tests/product-check-matcher.test.ts`, `tests/case-integration.test.ts`.

RED:

- The matcher returned `not_matched` for a matching `manual_review` lot.
- Real PostgreSQL persisted `not_matched` instead of `manual_review`.

GREEN:

- Focused matcher unit set: 12/12 passed.
- Real PostgreSQL confirmed `claimed_products.check_result = manual_review` and Case status `triage`.

### 4. Independent Communication-recipient encryption

Implementation:

- Consumer email is normalized once and encrypted independently for the Consumer row and Communication recipient.
- The Communication uses its own ciphertext/key version; the two persisted AES-256-GCM envelopes therefore have independent nonces.

Files: `src/modules/cases/drizzle-case-service.ts`, `tests/case-integration.test.ts`.

RED:

- Real PostgreSQL showed the Consumer and Communication recipient using the same ciphertext envelope.

GREEN:

- Real PostgreSQL decrypted both independent envelopes to the same normalized email and confirmed the envelopes differ.

### 5. Align Outbox deduplication with endpoint-scoped idempotency

Implementation:

- Confirmation Outbox deduplication now uses stable Case identity (`claim-confirmation:${caseReference}`), independent of a reusable endpoint-scoped idempotency key.
- A two-campaign fixture submits the same idempotency key to both campaign endpoints and verifies two Cases and two distinct Outbox records.
- The existing late-Outbox-unique rollback behavior remains covered with a deliberately forced duplicate Case reference.

Files: `src/modules/cases/drizzle-case-service.ts`, `tests/case-integration.test.ts`, `tests/helpers/case-fixture.ts`.

RED:

- The second campaign submission failed with PostgreSQL unique violation `23505` on Outbox deduplication.

GREEN:

- The two-campaign regression passed, and the late unique-violation rollback regression also passed.

### 6. Enforce and atomically recycle the 24-hour idempotency TTL

Implementation:

- Fast replay/recovery queries require `expires_at` to be later than the request timestamp.
- The Claim transaction conditionally deletes an expired row for the same endpoint/key before locking the Draft and inserts its replacement in the same transaction.
- Rollback restores the previous expired row. Two concurrent recyclers are bounded and deterministic: only one creates a Case; the other observes the committed state and returns the controlled 409 outcome for a different request.
- Phase 1 database documentation now describes the real 24-hour and concurrent-recycling behavior.

Files: `src/modules/cases/drizzle-case-service.ts`, `tests/case-integration.test.ts`, `docs/phase-1/02-database-design.md`.

RED:

- An expired key still returned `ClaimConflictError`.
- The concurrent recycling test observed zero expected transaction-gate arrivals because the expired row was never recycled.

GREEN:

- Four focused real PostgreSQL TTL/replay/concurrency cases passed, with one new Case and one current idempotency record after concurrent recycling.

### 7. Fail closed for direct Neon runtime URLs and provide opt-in transaction smoke

Implementation:

- Neon-hosted URLs are accepted only when the first hostname label matches an actual `ep-...-pooler` endpoint; direct Neon endpoints fail closed with a secret-safe error.
- Non-Neon PostgreSQL hosts, including local PostgreSQL, continue to use node-postgres.
- Deceptive suffixes such as `neon.tech.example.com` are not treated as Neon.
- `tests/neon-pooled-transaction.integration.test.ts` creates a database handle only when both `RUN_NEON_POOL_INTEGRATION=true` and `NEON_POOLED_TEST_DATABASE_URL` are present, then proves a real transaction commit and rollback. Normal tests neither construct the Neon client nor make network calls.

Files: `src/db/client.ts`, `src/composition.ts`, `tests/db-client.test.ts`, `tests/composition.test.ts`, `tests/neon-pooled-transaction.integration.test.ts`, `README.md`, Phase 1 docs, and stale runtime comments in Campaign, Claim Draft, Document, and Product Check services.

RED:

- Direct Neon URLs were accepted; the focused config/database run had four failures covering direct-host rejection and pooler requirements.

GREEN:

- Focused config/database tests: 30 passed.
- Dedicated Neon smoke was collected but skipped because its two explicit environment inputs were absent; no network connection was attempted.

### 8. Branch-introduced lint/format failures

Implementation:

- Database-handle assertions now check `typeof handle.transaction` and `typeof handle.close`, avoiding unbound-method lint violations without weakening the assertion.
- The Claim submission catch block and all fix-wave files were formatted with the repository formatter.

Files: `tests/db-client.test.ts`, `src/app.ts`, plus mechanically formatted touched files.

RED:

- The reviewed baseline reported the two unbound-method lint errors and the unformatted catch block.

GREEN:

- ESLint passed.
- Prettier passed for every file changed in this fix wave.

## Focused verification summary

- Combined default focused run: 64 tests passed; the dedicated Neon smoke was skipped.
- Combined real PostgreSQL focused run over the changed Claim behavior: 37/37 tests passed.
- Individual focused evidence is recorded above; all concurrency tests use explicit transaction gates with bounded waits and cleanup/failure release paths.

## Complete acceptance pass

The complete pass was run after all fixes. Environmental command corrections are called out rather than hidden.

| Gate                                                                                             | Result                                    | Evidence/boundary                                                                                                                                                                                                                                                                                                                                                                     |
| ------------------------------------------------------------------------------------------------ | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Secret scan                                                                                      | PASS after command correction             | The first `rg` invocation omitted `--` before a pattern beginning `-----BEGIN` and was rejected as an option; the corrected repository scan found only the pre-existing explicit fake fixture `tests/vercel-blob.test.ts:6` (`vercel_blob_rw_test-store_test-secret`). The fix-wave file scan had zero credential/private-key matches.                                                |
| `pnpm format:check`                                                                              | Baseline/out-of-scope FAIL; fix-wave PASS | Repository-wide check reports nine files not introduced by this wave: seven `.superpowers/.../task-*-brief.md` files, `api/index.ts`, and `tsconfig.json`. Per the scope constraint they were not modified. A scoped Prettier check over all 23 implementation files passed.                                                                                                          |
| `pnpm lint`                                                                                      | PASS                                      | Exit 0.                                                                                                                                                                                                                                                                                                                                                                               |
| `pnpm typecheck`                                                                                 | PASS                                      | Exit 0.                                                                                                                                                                                                                                                                                                                                                                               |
| `pnpm build`                                                                                     | PASS outside sandbox                      | The sandbox invocation reached `tsx` but its local IPC pipe failed with `listen EPERM`; the exact build was rerun with the needed local permission and passed typecheck, generated-OpenAPI freshness, and Drizzle validation.                                                                                                                                                         |
| `pnpm openapi:check`                                                                             | PASS                                      | Generated OpenAPI is up to date.                                                                                                                                                                                                                                                                                                                                                      |
| `pnpm db:check`                                                                                  | PASS                                      | Drizzle reported `Everything's fine`.                                                                                                                                                                                                                                                                                                                                                 |
| `pnpm test`                                                                                      | PASS                                      | 21 files passed, 6 skipped; 156 tests passed, 42 skipped. Skips are the repository's opt-in integration suites.                                                                                                                                                                                                                                                                       |
| `RUN_DB_INTEGRATION=true DATABASE_URL=postgresql://alexyuan@127.0.0.1:5432/koi_recall pnpm test` | PASS outside sandbox                      | The sandbox could not open the local PostgreSQL socket (`EPERM`), so the same command was rerun with local permission: 26 files passed, 1 skipped; 197 tests passed, 1 skipped. The sole skip was the dedicated Neon smoke. HTTP proof logged 201 initial submission, 201 replay, 409 new key, two linked Documents, one Communication, one Outbox event, and one idempotency record. |
| Dedicated pooled-Neon transaction smoke                                                          | SKIPPED                                   | `NEON_POOLED_TEST_DATABASE_URL` was absent and `RUN_NEON_POOL_INTEGRATION` was not `true`; this was intentionally not replaced with a normal-test network call.                                                                                                                                                                                                                       |

Runtime used for the green gates: Node `v25.8.1`, pnpm `11.9.0`.

## Node 24 and Neon environment boundary

- `which -a node` found only `/opt/homebrew/bin/node` (Node `v25.8.1`).
- `/opt/homebrew/opt/node@24/bin/node` does not exist. Homebrew lists only `node 25.8.1_1`; no nvm, mise, or Volta Node 24 installation was present.
- No runtime was downloaded or installed. Node 24 verification is therefore honestly **not run**; the complete gates are proven on the locally available Node 25 runtime.
- No dedicated pooled-Neon test URL was present in the process environment or local env files. The opt-in real BEGIN/commit/rollback smoke is implemented and skipped, not claimed as executed.

## Self-review

- `git diff --check` passed before the implementation commit.
- Explicit staging contained exactly the 23 fix-wave implementation/test/doc files; staged name/status/stat and staged whitespace checks were reviewed before commit.
- Searches found no remaining stale `Neon HTTP` or `非交互式事务` wording in README, Phase 1 docs, source, or tests.
- No Claim contract/OpenAPI/schema/migration change was staged. Sensitive payloads remain encrypted at rest; recipient ciphertext is now more strongly separated, and no plaintext was added to logs, Outbox payloads, or idempotency responses.
- No parked scope was implemented.

## Remaining concerns

1. The repository-wide formatting gate remains red only for the nine pre-existing/out-of-scope files listed above; all files in this repair wave pass Prettier.
2. Node 24 could not be verified because no local Node 24 executable exists.
3. A real pooled-Neon transaction could not be exercised because no dedicated opt-in Neon URL was supplied; the local PostgreSQL interactive transaction suite, including all new races, is green.
