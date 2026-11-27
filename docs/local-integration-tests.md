# Isolated PostgreSQL integration tests

Use a disposable native PostgreSQL instance bound to loopback. No production rows are required. Set `LOCAL_TEST_DATABASE_URL` to a local URL whose database name contains `test` as a whole segment, then run `pnpm test:db:local`.

The runner refuses non-loopback hosts and database names without the test marker. It supplies throwaway encryption keys, isolates dotenv from deployment credentials, applies the real migrations, installs the synthetic campaign plus English/Spanish transactional templates, and enables the database suites. It does not send real mail, upload to cloud storage, issue refunds or create shipments. Templates are required independently of the legacy campaign-message seed; without them claim submission correctly refuses to commit.

The database remains disposable after the run: seeded consumer data uses temporary keys. Do not reuse it for application data. Use a fresh database for a clean run. Reporter arguments may be supplied after the command, for example `--reporter=json --outputFile=local-results.json`.

The dedicated Neon pooled transaction smoke remains a separate opt-in test. A local PostgreSQL success does not establish a Neon WebSocket/pool success.

Template setup now closes its database handle on both success and failure, and exits unsuccessfully when initialization fails instead of leaving a connection open or hiding an error.
