import { neon } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-http';

import * as schema from './schema/index.js';

export function createDatabase(databaseUrl: string) {
  const sql = neon(databaseUrl);
  return { db: drizzle({ client: sql, schema }), sql };
}

export type Database = ReturnType<typeof createDatabase>['db'];
