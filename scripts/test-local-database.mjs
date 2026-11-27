import { randomBytes } from 'node:crypto';
import { mkdtempSync, writeFileSync, unlinkSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const databaseUrl = process.env.LOCAL_TEST_DATABASE_URL;
if (!databaseUrl) throw new Error('Set LOCAL_TEST_DATABASE_URL to a disposable local PostgreSQL database.');
const target = new URL(databaseUrl);
if (!['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname) ||
    !/(^|[_-])test([_-]|$)/i.test(target.pathname.slice(1))) {
  throw new Error('Integration setup requires a loopback host and a database name containing a whole test segment.');
}

const root = fileURLToPath(new URL('..', import.meta.url));
const temporary = mkdtempSync(path.join(tmpdir(), 'koi-integration-env-'));
const emptyEnv = path.join(temporary, 'empty.env');
writeFileSync(emptyEnv, '');
const env = { ...process.env };
// dotenv must not import deployment credentials. Tests use real local SQL, not
// real email, Blob, Redis, revalidation or other provider configuration.
for (const key of Object.keys(env)) {
  if (/^(DATABASE_URL|koi_DATABASE_URL|FIELD_ENCRYPTION_KEY|HASH_PEPPER|RESEND_|BLOB_|VERCEL|UPSTASH_|KV_REST_|WEB_REVALIDATE_|NEON_POOLED_|RUN_NEON_|LOCAL_BLOB_DIR|ADMIN_API_KEY|CRON_SECRET)/.test(key)) delete env[key];
}
Object.assign(env, {
  DATABASE_URL: databaseUrl,
  APP_ENV: 'local',
  ALLOW_SYNTHETIC_SEED: 'true',
  RUN_DB_INTEGRATION: 'true',
  DOTENV_CONFIG_PATH: emptyEnv,
  FIELD_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
  HASH_PEPPER: randomBytes(32).toString('base64'),
});
const run = (args) => {
  const child = spawnSync(process.execPath, args, { cwd: root, env, stdio: 'inherit' });
  if (child.error) throw child.error;
  if (child.status !== 0) throw new Error(`Isolated test command failed with exit code ${child.status}.`);
};
try {
  for (const script of ['scripts/migrate.ts', 'src/db/seed.ts', 'src/scripts/setup-templates.ts', 'src/scripts/setup-spanish-templates.ts']) {
    run(['node_modules/tsx/dist/cli.mjs', script]);
  }
  run(['node_modules/vitest/vitest.mjs', 'run', '--no-file-parallelism', ...process.argv.slice(2)]);
} finally {
  unlinkSync(emptyEnv);
  rmdirSync(temporary);
}
