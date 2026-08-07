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
 * development need no manual switch. Neon runtime connections must use an actual
 * `ep-...-pooler.*.neon.tech` hostname; direct Neon hosts fail closed instead of
 * opening an unpooled serverless connection. Any non-Neon host uses node-postgres.
 */
export function detectDriver(databaseUrl: string): DatabaseDriver {
  let hostname: string;
  try {
    hostname = new URL(databaseUrl).hostname.toLowerCase();
  } catch {
    return 'node-postgres';
  }

  const neonHosted = hostname === 'neon.tech' || hostname.endsWith('.neon.tech');
  if (!neonHosted) return 'node-postgres';

  const endpointLabel = hostname.split('.')[0] ?? '';
  const pooledEndpoint = /^ep-[a-z0-9](?:[a-z0-9-]*[a-z0-9])?-pooler$/.test(endpointLabel);
  if (!pooledEndpoint) {
    throw new Error('Neon DATABASE_URL must use a pooled Neon connection string.');
  }
  return 'neon-serverless';
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
