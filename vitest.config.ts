import { defineConfig } from 'vitest/config';

/**
 * There is deliberately no `testTimeout` here.
 *
 * Per-test budgets are set where they belong — on the suites that need them,
 * because a long budget everywhere would hide a genuinely slow test. Hooks are a
 * different matter: an `afterAll` that deletes integration fixtures does many
 * sequential round trips, and the default budget is sized for a local database.
 * When a hook runs out it stops halfway and leaves rows behind, so the failure
 * that follows is a contaminated database rather than a clear error. That happened
 * three times before this file existed.
 *
 * Note the trap this fixes: a `hookTimeout` passed in a suite's options object is
 * silently ignored — it is a root-config option, not a per-suite one. It has to
 * live here.
 *
 * A second way to strand rows, observed in production data: an integration test
 * that times out mid-`submit`. The fixture cleanup queries the draft's
 * `submittedCaseId`, which the abandoned submission had not written yet, so the
 * case survives cleanup and becomes visible in the admin queues. Because these
 * suites construct their own throwaway `Buffer.alloc` key, the stranded rows are
 * also permanently unreadable by the application — one such row used to fail the
 * whole case-detail read. Give a suite that submits claims a budget that fits its
 * real round trips (`{ timeout: 120_000 }`), and note that `RUN_DB_INTEGRATION`
 * runs against whatever `DATABASE_URL` points at, shared databases included.
 *
 * A third, which cost an hour of debugging: cleanup must delete every document a
 * fixture created, and must delete documents before their draft. The draft's FK
 * nulls `document_uploads.draft_id` on delete, and `document_uploads_owner_chk`
 * requires `draft_id` or `case_id` to be set — so deleting a draft that still
 * owns a document fails the check, the rest of the cleanup never runs, and the
 * fixture is left behind while the test still reports a pass.
 */
export default defineConfig({
  test: {
    hookTimeout: 60_000,
  },
});
