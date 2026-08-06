import { Pool as NeonPool } from '@neondatabase/serverless';
import { drizzle as neonServerlessDrizzle, type NeonDatabase } from 'drizzle-orm/neon-serverless';
import { drizzle as nodePostgresDrizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool as NodePgPool } from 'pg';

import * as schema from './schema/index.js';

/**
 * A Drizzle client backed by either the Neon serverless driver or
 * node-postgres (local / standard Postgres). Both share the PostgreSQL read
 * and write API, so domain code can use this union type without caring which
 * driver is active.
 */
export type Database = NeonDatabase<typeof schema> | NodePgDatabase<typeof schema>;

export type DatabaseExecutor = Pick<
  NodePgDatabase<typeof schema>,
  'select' | 'insert' | 'update' | 'delete' | 'execute'
>;

export interface DatabaseHandle {
  db: Database;
  driver: DatabaseDriver;
  transaction<T>(work: (tx: DatabaseExecutor) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export type DatabaseDriver = 'neon-serverless' | 'node-postgres';

/**
 * Auto-selects the driver from the connection string so deployments and local
 * development need no manual switch. Neon serverless only works against Neon-hosted
 * Postgres (its host ends in `neon.tech`); any other host uses node-postgres.
 */
export function detectDriver(databaseUrl: string): DatabaseDriver {
  try {
    const { hostname } = new URL(databaseUrl);
    return hostname.toLowerCase().endsWith('neon.tech') ? 'neon-serverless' : 'node-postgres';
  } catch {
    return 'node-postgres';
  }
}

export function createDatabase(databaseUrl: string): DatabaseHandle {
  const driver = detectDriver(databaseUrl);

  if (driver === 'neon-serverless') {
    const pool = new NeonPool({ connectionString: databaseUrl });
    const db = neonServerlessDrizzle({ client: pool, schema });
    return {
      db,
      driver,
      transaction: (work) => db.transaction((tx) => work(tx as DatabaseExecutor)),
      close: () => pool.end(),
    };
  }

  const pool = new NodePgPool({ connectionString: databaseUrl });
  const db = nodePostgresDrizzle({ client: pool, schema });
  return {
    db,
    driver,
    transaction: (work) => db.transaction((tx) => work(tx)),
    close: () => pool.end(),
  };
}
