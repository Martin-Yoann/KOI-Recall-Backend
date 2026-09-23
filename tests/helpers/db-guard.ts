/**
 * Safety guard for database integration tests.
 *
 * Prevents test suites using throwaway mock encryption keys (Buffer.alloc) from
 * accidentally connecting to a remote shared, staging or production database
 * and polluting it with undecryptable test residue.
 */
export function assertLocalIntegrationDatabase(databaseUrl: string | undefined): void {
  // Only a run that is actually going to touch the database is worth refusing.
  // Guarding at import time turned a plain `pnpm test` into nine load failures
  // for suites that were going to be skipped anyway.
  if (process.env.RUN_DB_INTEGRATION !== 'true') return;
  if (!databaseUrl) return;
  if (process.env.ALLOW_REMOTE_INTEGRATION_TESTS === 'true') return;

  let hostname: string;
  try {
    hostname = new URL(databaseUrl).hostname.toLowerCase();
  } catch {
    return;
  }

  const isLocal =
    hostname === 'localhost' ||
    hostname === '127.0.0.1' ||
    hostname === '::1' ||
    hostname.endsWith('.local');

  if (!isLocal) {
    throw new Error(
      `\n\n[FATAL INTEGRATION TEST GUARD] ` +
        `Refusing to run database integration tests against remote host "${hostname}". ` +
        `Integration suites use ephemeral mock encryption keys that would leave permanent unreadable residue. ` +
        `Point DATABASE_URL at a local Postgres instance (e.g. localhost:5432), ` +
        `or set ALLOW_REMOTE_INTEGRATION_TESTS=true if you explicitly intend to test against this host.\n`,
    );
  }
}
