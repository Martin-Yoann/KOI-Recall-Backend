import 'dotenv/config';

import { Pool as NeonPool } from '@neondatabase/serverless';
import { drizzle as neonServerlessDrizzle } from 'drizzle-orm/neon-serverless';
import { migrate as migrateNeonServerless } from 'drizzle-orm/neon-serverless/migrator';
import { drizzle as nodePostgresDrizzle } from 'drizzle-orm/node-postgres';
import { migrate as migrateNodePostgres } from 'drizzle-orm/node-postgres/migrator';
import { Client, Pool } from 'pg';

import { detectDriver } from '../src/db/client.js';

const migrationsFolder = new URL('../drizzle', import.meta.url).pathname;

/**
 * For local node-postgres targets, creates the database named in the connection
 * string if it does not yet exist, so a fresh machine can run `pnpm db:migrate`
 * against an empty Postgres instance. Neon already provides the database.
 */
async function ensurePostgresDatabase(connectionString: string): Promise<void> {
  const targetDatabase = new URL(connectionString).pathname.replace(/^\//, '') || 'postgres';
  const maintenanceUrl = new URL(connectionString);
  maintenanceUrl.pathname = '/postgres';

  const client = new Client({ connectionString: maintenanceUrl.toString() });
  try {
    await client.connect();
    const result = await client.query<{ exists: boolean }>(
      'SELECT EXISTS (SELECT 1 FROM pg_database WHERE datname = $1) AS exists',
      [targetDatabase],
    );
    if (!result.rows[0]?.exists) {
      console.log(`Creating database "${targetDatabase}"...`);
      await client.query(`CREATE DATABASE "${targetDatabase}"`);
    }
  } finally {
    await client.end();
  }
}

async function run(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error(
      'DATABASE_URL is required. Set it in .env (local Postgres) or your deployment environment (Neon).',
    );
  }

  const driver = detectDriver(databaseUrl);
  console.log(`Applying migrations via ${driver} driver...`);

  if (driver === 'neon-serverless') {
    const pool = new NeonPool({ connectionString: databaseUrl });
    try {
      const db = neonServerlessDrizzle({ client: pool });
      await migrateNeonServerless(db, { migrationsFolder });
    } finally {
      await pool.end();
    }
    return;
  }

  await ensurePostgresDatabase(databaseUrl);
  const pool = new Pool({ connectionString: databaseUrl });
  try {
    const db = nodePostgresDrizzle({ client: pool });
    await migrateNodePostgres(db, { migrationsFolder });
  } finally {
    await pool.end();
  }
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
