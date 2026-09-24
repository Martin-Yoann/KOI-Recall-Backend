/**
 * Safety guard for database integration tests.
 *
 * Two independent conditions must hold before a remote database is touched:
 *
 *  1. the caller opted in explicitly (`ALLOW_REMOTE_INTEGRATION_TESTS=true`), and
 *  2. the database it names looks like a test database.
 *
 * The second condition is the one that matters. An escape hatch alone is a promise
 * not to point it at production; a name check is a property of the target. This
 * repository's own `DATABASE_URL` is the production database, so "I set the flag"
 * must never by itself be enough.
 */

/** Local servers need no opt-in: the guard exists for remote hosts. */
function isLocalHost(hostname: string): boolean {
  return (
    hostname === 'localhost' ||
    hostname === '127.0.0.1' ||
    hostname === '::1' ||
    hostname.endsWith('.local')
  );
}

/**
 * Whether a database name marks itself as disposable. Deliberately requires the
 * word to be a whole segment (`koi_recall_test`, `test_db`, `koi-test`), so a name
 * that merely contains the letters — `latest_prod`, `contest` — is not accepted.
 */
function looksLikeTestDatabase(databaseName: string): boolean {
  return /(^|[_-])test([_-]|$)/i.test(databaseName);
}

export function assertLocalIntegrationDatabase(databaseUrl: string | undefined): void {
  // Only a run that is actually going to touch the database is worth refusing.
  // Guarding at import time turned a plain `pnpm test` into nine load failures
  // for suites that were going to be skipped anyway.
  if (process.env.RUN_DB_INTEGRATION !== 'true') return;
  if (!databaseUrl) return;

  let hostname: string;
  let databaseName: string;
  try {
    const parsed = new URL(databaseUrl);
    hostname = parsed.hostname.toLowerCase();
    databaseName = parsed.pathname.replace(/^\//, '');
  } catch {
    return;
  }

  if (isLocalHost(hostname)) return;

  const optedIn = process.env.ALLOW_REMOTE_INTEGRATION_TESTS === 'true';
  if (optedIn && looksLikeTestDatabase(databaseName)) return;

  const reason = !optedIn
    ? 'remote hosts are off by default'
    : `the database is named "${databaseName}", which does not mark it as disposable`;

  throw new Error(
    `\n\n[FATAL INTEGRATION TEST GUARD] ` +
      `Refusing to run database integration tests against "${hostname}/${databaseName}": ${reason}. ` +
      `Integration suites use ephemeral mock encryption keys that would leave permanent unreadable residue. ` +
      `Point DATABASE_URL at a local Postgres, or — for a remote test database — set ` +
      `ALLOW_REMOTE_INTEGRATION_TESTS=true and name the database something with "test" as a whole segment ` +
      `(e.g. koi_recall_test).\n`,
  );
}
