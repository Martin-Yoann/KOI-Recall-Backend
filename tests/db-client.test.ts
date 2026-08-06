import { describe, expect, it } from 'vitest';

import { createDatabase, detectDriver } from '../src/db/client.js';

describe('database driver detection', () => {
  it('selects the transaction-capable Neon serverless driver', () => {
    expect(
      detectDriver(
        'postgresql://user:pass@ep-cool-name-12345.us-east-2.aws.neon.tech/neondb?sslmode=require',
      ),
    ).toBe('neon-serverless');
    expect(detectDriver('postgres://user@ep-pooler.eu-west.aws.neon.tech/neondb')).toBe(
      'neon-serverless',
    );
  });

  it('selects node-postgres for local and standard hosts', () => {
    expect(detectDriver('postgresql://alexyuan@127.0.0.1:5432/koi_recall')).toBe('node-postgres');
    expect(detectDriver('postgresql://user:pass@db.example.com:5432/recall')).toBe('node-postgres');
  });

  it('falls back to node-postgres for malformed urls', () => {
    expect(detectDriver('not-a-url')).toBe('node-postgres');
  });

  it('creates a transaction-capable handle', async () => {
    const handle = createDatabase('postgresql://user:pass@127.0.0.1:5432/koi_recall');

    expect(handle.driver).toBe('node-postgres');
    expect(handle.transaction).toBeTypeOf('function');
    expect(handle.close).toBeTypeOf('function');

    await handle.close();
  });
});
