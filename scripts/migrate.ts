// ============================================================
// KOI Recall — Database Migration Runner
// Applies Drizzle-generated migrations to the configured database.
//
// Usage:
//   pnpm db:migrate
//
// Prerequisites:
//   1. DATABASE_URL must be set (env or .env.local)
//   2. Migrations must have been generated: pnpm db:generate
// ============================================================

import 'dotenv/config';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';
import * as fs from 'node:fs';
import * as path from 'node:path';

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  console.error('ERROR: DATABASE_URL is not set.');
  console.error('Set it in .env.local or as an environment variable.');
  process.exit(1);
}

const migrationsFolder = path.resolve(import.meta.dirname, '../drizzle');

if (!fs.existsSync(migrationsFolder)) {
  console.error(`ERROR: Migrations folder not found: ${migrationsFolder}`);
  console.error('Run "pnpm db:generate" first to generate migration files.');
  process.exit(1);
}

async function run() {
  console.log('[migrate] Applying migrations...');

  const pool = new Pool({ connectionString: databaseUrl });
  const db = drizzle(pool);

  await migrate(db, { migrationsFolder });

  await pool.end();
  console.log('[migrate] Migrations applied successfully.');
}

run().catch((err) => {
  console.error('[migrate] Migration failed:', err);
  process.exit(1);
});
