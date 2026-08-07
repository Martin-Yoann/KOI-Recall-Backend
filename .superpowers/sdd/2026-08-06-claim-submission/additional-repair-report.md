# Claim submission additional repair report

## Scope and outcome

- Worktree: `/Users/alexyuan/koi/koi-recall-api/.worktrees/claim-submission`
- Branch: `codex/claim-submission`
- Additional-repair baseline: `bdeaddeeaa987425bf24084db1ad2e486ddb5ca0`
- Implementation commit: `27cae88ce74ba753c3ddf02d76842fa8c1c80c1f` (`fix: close final claim review gaps`)
- Outcome: the two residual Important findings were fixed without expanding into parked scope.
- Changed implementation/test files only: `src/modules/cases/drizzle-case-service.ts`, `src/db/client.ts`, `tests/case-http-integration.test.ts`, and `tests/db-client.test.ts`.

## 1. Draft token-first residual

### Implementation

- Removed the transaction-external idempotency fast lookup from `DrizzleCaseService.submit()`.
- The transaction now locks the Draft and validates the token before any endpoint/key record lookup or expired-record deletion.
- A valid submitted Draft checks for an unexpired same-key winner only after token validation: same body replays, a different body returns 409, and a new key returns 409.
- An invalid token, missing Draft, inactive Draft, or expired Draft returns the uniform 410 before idempotency state can affect the response.
- An active Draft validates token, state, and campaign path before checking/recycling idempotency state. The existing 24-hour atomic recycling remains inside the transaction.
- The unique-constraint recovery lookup remains after a transaction that has already completed Draft token validation.

### TDD evidence

Test added first: a real Hono `app.request()` + local PostgreSQL regression successfully consumes an idempotency key, then reuses that key with an invalid Draft token against both the real campaign slug and a wrong slug. It asserts both responses are identical 410 Problem Details and contain none of the key, Case reference, real slug, or wrong slug.

RED command:

```bash
RUN_DB_INTEGRATION=true DATABASE_URL=postgresql://alexyuan@127.0.0.1:5432/koi_recall \
  pnpm exec vitest run tests/case-http-integration.test.ts \
  -t "returns identical safe 410 problems before consulting a used endpoint key"
```

RED result:

- 1 failed, 1 skipped.
- Expected the real-slug response to be 410; received 409. The wrong-slug path continued to return 410, reproducing the endpoint/key oracle.

GREEN result after the minimal production change:

- The same focused command passed: 1 passed, 1 skipped.
- Broader focused real-PostgreSQL run covering initial submission, same-key replay, used-key/different-body conflict, submitted/new-key conflict, TTL recycling, concurrent TTL recycling, and the new oracle regression: 2 files passed, 7 tests passed, 27 unrelated tests skipped by the name filter.
- The proof output retained the required valid-token behavior: initial 201, same-key/same-body replay 201, and submitted/new-key 409.

Mutation protected: moving any endpoint/key lookup back ahead of the Draft token check makes the new real-slug assertion return 409 and fail.

## 2. Neon trailing-dot FQDN

### Implementation

- `detectDriver()` now lowercases the parsed hostname and removes exactly one terminal DNS root dot for classification only.
- The original database URL is not rewritten.
- A direct `*.neon.tech.` hostname is recognized as Neon and fails closed unless its endpoint label is `ep-...-pooler`.
- A real `ep-...-pooler.*.neon.tech.` hostname selects `neon-serverless`.
- An ordinary PostgreSQL hostname with a trailing dot remains `node-postgres`.

### TDD evidence

Offline test added first with literal direct-Neon, pooled-Neon, and ordinary-PostgreSQL URLs. No database handle or network connection is created.

RED command:

```bash
pnpm exec vitest run tests/db-client.test.ts \
  -t "normalizes one trailing DNS root dot"
```

RED result:

- 1 failed, 9 skipped.
- The direct `ep-...neon.tech.` URL did not throw; it was incorrectly classified as node-postgres.

GREEN result after the minimal production change:

- `pnpm exec vitest run tests/db-client.test.ts tests/composition.test.ts`: 2 files passed, 31 tests passed.
- The direct trailing-dot URL is rejected, the pooled trailing-dot URL is accepted, and the ordinary PostgreSQL trailing-dot URL remains node-postgres.

Mutation protected: removing the one-dot normalization causes both direct-Neon rejection and pooled-Neon selection assertions to fail.

## Required verification before commit

| Gate                         | Result | Evidence                                                                                                                                                                                                         |
| ---------------------------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Scoped Prettier              | PASS   | All four additional-repair implementation/test files match repository style.                                                                                                                                     |
| `pnpm lint`                  | PASS   | Exit 0.                                                                                                                                                                                                          |
| `pnpm typecheck`             | PASS   | Exit 0.                                                                                                                                                                                                          |
| `pnpm build`                 | PASS   | Exit 0; includes typecheck, OpenAPI freshness, and Drizzle check (`Everything's fine`). The build was granted local permission for the repository's `tsx` IPC pipe.                                              |
| `pnpm test`                  | PASS   | 21 files passed, 6 skipped; 157 tests passed, 43 skipped. Opt-in database/Neon tests remained offline by default.                                                                                                |
| Real Claim PostgreSQL suites | PASS   | `RUN_DB_INTEGRATION=true DATABASE_URL=postgresql://alexyuan@127.0.0.1:5432/koi_recall pnpm exec vitest run tests/case-http-integration.test.ts tests/case-integration.test.ts`: 2 files passed, 34 tests passed. |
| `git diff --check`           | PASS   | No whitespace errors before staging.                                                                                                                                                                             |

Verification runtime: Node `v25.8.1`, pnpm `11.9.0`.

## Node and Neon boundaries

- `which -a node` found only `/opt/homebrew/bin/node`; common Homebrew Node 24, Volta, and mise executable locations produced no Node 24 runtime.
- The project emitted its expected engine warning because it requests Node `24.x`; Node 24 verification was not claimed and no runtime was downloaded or installed.
- `NEON_POOLED_TEST_DATABASE_URL` was absent and `RUN_NEON_POOL_INTEGRATION` was not `true`.
- No Neon network call was made. The pure offline trailing-dot tests passed; the existing dedicated pooled-Neon transaction smoke remained skipped by design.

## Self-review

- The staged implementation commit contained exactly the four listed files: two production files and their two test files.
- Staged name/status/stat and staged whitespace checks were reviewed before commit.
- No public Claim schema, OpenAPI contract, Drizzle schema, migration, `.vscode`, or `.zcode` file changed.
- No Resend, Admin API, role model, masking, deployment, cleanup worker, or Blob deletion work was introduced.
- Valid-token idempotency behavior is explicitly covered after the token-first reorder, and the complete Claim integration suite remained green.
- Hostname normalization changes only the classification copy and removes only one terminal root dot; it does not mutate the connection string or broaden Neon hostname matching.

## Remaining concerns

1. Node 24 could not be exercised because it is not installed locally; all gates ran on Node 25.8.1.
2. The real pooled-Neon transaction smoke could not run without the dedicated opt-in URL. This repair intentionally added no network dependency to normal tests.
3. No functional regression or additional in-scope gap was found after the complete local verification.
