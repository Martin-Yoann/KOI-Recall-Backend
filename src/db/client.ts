import { neon } from '@neondatabase/serverless';
import { drizzle as neonHttpDrizzle, type NeonHttpDatabase } from 'drizzle-orm/neon-http';
import { drizzle as nodePostgresDrizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';

import * as schema from './schema/index.js';

/**
 * A Drizzle client backed by either the Neon HTTP driver (serverless) or
 * node-postgres (local / standard Postgres). Both share the PostgreSQL read
 * and write API, so domain code can use this union type without caring which
 * driver is active.
 */
export type Database = NeonHttpDatabase<typeof schema> | NodePgDatabase<typeof schema>;

export interface DatabaseHandle {
  db: Database;
  /** Present only for the node-postgres driver, so callers can drain it on shutdown. */
  pool?: Pool;
}

export type DatabaseDriver = 'neon' | 'node-postgres';

/**
 * Auto-selects the driver from the connection string so deployments and local
 * development need no manual switch. Neon HTTP only works against Neon-hosted
 * Postgres (its host ends in `neon.tech`); any other host uses node-postgres.
 */
export function detectDriver(databaseUrl: string): DatabaseDriver {
  try {
    const { hostname } = new URL(databaseUrl);
    return hostname.toLowerCase().endsWith('neon.tech') ? 'neon' : 'node-postgres';
  } catch {
    return 'node-postgres';
  }
}

export function createDatabase(databaseUrl: string): DatabaseHandle {
  if (detectDriver(databaseUrl) === 'neon') {
    const sql = neon(databaseUrl);
    return { db: neonHttpDrizzle({ client: sql, schema }) };
  }

  const pool = new Pool({ connectionString: databaseUrl });
  return { db: nodePostgresDrizzle({ client: pool, schema }), pool };
}
