import 'dotenv/config';

import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { Pool as NeonPool } from '@neondatabase/serverless';
import { Pool } from 'pg';

import { detectDriver } from '../src/db/client.js';

/**
 * Read-only check: is the target database's applied migration set in step with
 * the `drizzle/` folder the code was built from?
 *
 * Deploying code whose queries reference columns a migration has not created
 * yet is exactly how production breaks quietly — incident submissions and the
 * admin case surfaces returned 500 until this gap was noticed (2026-09-29).
 * This script makes the gap a loud, specific failure instead. It only ever
 * runs SELECTs, so it is safe to point at any environment, production
 * included; applying migrations remains `pnpm db:migrate`'s job.
 *
 * Usage: DATABASE_URL=... pnpm db:drift-check
 */

const migrationsFolder = fileURLToPath(new URL('../drizzle', import.meta.url));

interface AppliedMigration {
  hash: string;
}

async function fetchApplied(connectionString: string): Promise<AppliedMigration[]> {
  const query = 'SELECT hash FROM drizzle.__drizzle_migrations ORDER BY created_at ASC';
  if (detectDriver(connectionString) === 'neon-serverless') {
    const pool = new NeonPool({ connectionString });
    try {
      const result = await pool.query<AppliedMigration>(query);
      return result.rows;
    } finally {
      await pool.end();
    }
  }
  const pool = new Pool({ connectionString });
  try {
    const result = await pool.query<AppliedMigration>(query);
    return result.rows;
  } finally {
    await pool.end();
  }
}

async function run(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL || process.env.koi_DATABASE_URL;
  if (!databaseUrl) {
    throw new Error(
      'DATABASE_URL is required. Set DATABASE_URL or koi_DATABASE_URL in .env or your shell.',
    );
  }

  const localFiles = readdirSync(migrationsFolder)
    .filter((name) => name.endsWith('.sql'))
    .sort();
  const hashOf = (name: string) =>
    createHash('sha256')
      .update(readFileSync(`${migrationsFolder}/${name}`))
      .digest('hex');
  const localHashes = new Map(localFiles.map((name) => [hashOf(name), name]));

  const applied = await fetchApplied(databaseUrl);
  const appliedHashes = new Set(applied.map((row) => row.hash));
  const target = `${new URL(databaseUrl).host}${new URL(databaseUrl).pathname}`;

  const missing = [...localHashes.entries()]
    .filter(([hash]) => !appliedHashes.has(hash))
    .map(([, name]) => name)
    .sort();

  if (missing.length === 0) {
    console.log(
      `Migration drift check passed: all ${localFiles.length} local migrations are applied on ${target}.`,
    );
    return;
  }

  console.error(
    `\n[MIGRATION DRIFT] The database at ${target} is missing ${missing.length} of ` +
      `${localFiles.length} local migrations:\n` +
      missing.map((name) => `  - ${name}`).join('\n') +
      `\n\nCode deployed against this database queries columns these migrations create, ` +
      `which is how reads and writes start failing with 500s. Apply them with:\n` +
      `  DATABASE_URL=<this target> pnpm db:migrate\n` +
      `(Applied on this database: ${applied.length} migrations.)\n`,
  );
  process.exit(1);
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
