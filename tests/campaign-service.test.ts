import { drizzle } from 'drizzle-orm/node-postgres';
import { describe, expect, it } from 'vitest';

import type { Database } from '../src/db/client.js';
import * as schema from '../src/db/schema/index.js';
import * as campaignServiceModule from '../src/modules/campaigns/drizzle-campaign-service.js';

describe('published campaign version query', () => {
  it('requires the published version id and owning campaign id', () => {
    const buildQuery = (
      campaignServiceModule as typeof campaignServiceModule & {
        buildPublishedVersionQuery?: (
          db: Database,
          campaignId: string,
          versionId: string,
        ) => { toSQL(): { sql: string; params: unknown[] } };
      }
    ).buildPublishedVersionQuery;

    expect(buildQuery).toBeTypeOf('function');
    if (!buildQuery) return;

    const db = drizzle.mock({ schema });
    const query = buildQuery(
      db,
      '2bdac8b0-73d8-4e38-a7e2-98fd5608788a',
      '85eafab1-a5bd-4d57-a697-38bce973deab',
    ).toSQL();
    expect(query.sql).toContain('"campaign_versions"."campaign_id"');
    expect(query.params).toEqual([
      '85eafab1-a5bd-4d57-a697-38bce973deab',
      '2bdac8b0-73d8-4e38-a7e2-98fd5608788a',
      'published',
      1,
    ]);
  });
});
