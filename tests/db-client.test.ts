import { describe, expect, it } from 'vitest';

import { createDatabase, detectDriver } from '../src/db/client.js';

describe('database driver detection', () => {
  it('selects the transaction-capable Neon serverless driver', () => {
    expect(
      detectDriver(
        'postgresql://user:pass@ep-cool-name-12345-pooler.us-east-2.aws.neon.tech/neondb?sslmode=require',
      ),
    ).toBe('neon-serverless');
  });

  it('fails closed for a direct non-pooler Neon hostname', () => {
    const directUrl =
      'postgresql://user:pass@ep-cool-name-12345.us-east-2.aws.neon.tech/neondb?sslmode=require';

    expect(() => detectDriver(directUrl)).toThrow('pooled Neon connection string');
    expect(() => createDatabase(directUrl)).toThrow('pooled Neon connection string');
  });

  it('does not mistake a non-Neon suffix for a Neon host', () => {
    expect(
      detectDriver('postgresql://user:pass@ep-example-pooler.neon.tech.example.com/neondb'),
    ).toBe('node-postgres');
    expect(detectDriver('postgresql://user:pass@neon.tech.example.com/neondb')).toBe(
      'node-postgres',
    );
  });

  it('rejects a Neon hostname that merely contains pooler outside the endpoint label', () => {
    expect(() =>
      detectDriver(
        'postgresql://user:pass@ep-cool-name-12345.pooler.us-east-2.aws.neon.tech/neondb',
      ),
    ).toThrow('pooled Neon connection string');
  });

  it('accepts standard non-Neon PostgreSQL hosts', () => {
    expect(detectDriver('postgresql://user:pass@pooler.standard-postgres.example.com/neondb')).toBe(
      'node-postgres',
    );
  });

  it('does not expose the supplied Neon URL in the validation error', () => {
    const directUrl =
      'postgresql://sensitive-user:sensitive-password@ep-example.us-east-2.aws.neon.tech/db';
    let thrown: unknown;
    try {
      detectDriver(directUrl);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).not.toContain(directUrl);
    expect((thrown as Error).message).not.toContain('sensitive-password');
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
    expect(typeof handle.transaction).toBe('function');
    expect(typeof handle.close).toBe('function');

    await handle.close();
  });
});
