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
 */
export default defineConfig({
  test: {
    hookTimeout: 60_000,
  },
});
