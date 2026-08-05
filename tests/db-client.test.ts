import { describe, expect, it } from 'vitest';

import { detectDriver } from '../src/db/client.js';

describe('database driver detection', () => {
  it('selects the neon driver for Neon hosts', () => {
    expect(
      detectDriver(
        'postgresql://user:pass@ep-cool-name-12345.us-east-2.aws.neon.tech/neondb?sslmode=require',
      ),
    ).toBe('neon');
    expect(detectDriver('postgres://user@ep-pooler.eu-west.aws.neon.tech/neondb')).toBe('neon');
  });

  it('selects node-postgres for local and standard hosts', () => {
    expect(detectDriver('postgresql://alexyuan@127.0.0.1:5432/koi_recall')).toBe('node-postgres');
    expect(detectDriver('postgresql://user:pass@db.example.com:5432/recall')).toBe('node-postgres');
  });

  it('falls back to node-postgres for malformed urls', () => {
    expect(detectDriver('not-a-url')).toBe('node-postgres');
  });
});
