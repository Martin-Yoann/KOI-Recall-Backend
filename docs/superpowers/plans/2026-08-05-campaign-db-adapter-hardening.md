# Campaign DB Adapter Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent cross-Campaign published-version references, validate public Campaign responses at runtime, and classify PostgreSQL availability failures as HTTP 503.

**Architecture:** Add a composite ownership foreign key in Drizzle and repeat the ownership predicate in the read query. Treat the Zod response schema as the HTTP boundary validator, and centralize recursive dependency-error classification in `src/shared/errors.ts`.

**Tech Stack:** Node.js 24, TypeScript strict mode, Hono, Zod, Drizzle ORM/Kit, PostgreSQL, Vitest, pnpm.

## Global Constraints

- Keep `GET /v1/recall-campaigns/{slug}` and its successful response shape unchanged.
- Add a new migration; do not rewrite `drizzle/0000_adorable_sue_storm.sql`.
- Do not classify PostgreSQL authentication, authorization, query, schema, or constraint errors as 503.
- Preserve the unrelated untracked `.vscode/` directory.
- Write and verify a failing regression test before each production change.

---

## File Structure

- Modify `src/db/schema/index.ts`: declare the composite ownership key and foreign key.
- Create `drizzle/0001_campaign_version_ownership.sql`: migrate existing databases to the ownership constraint.
- Modify `drizzle/meta/0001_snapshot.json` and `drizzle/meta/_journal.json`: Drizzle-generated migration metadata.
- Modify `src/modules/campaigns/drizzle-campaign-service.ts`: include Campaign ownership in the published-version predicate.
- Modify `src/app.ts`: parse the successful Campaign response with the public Zod schema.
- Modify `src/shared/errors.ts`: recursively classify network and PostgreSQL availability errors.
- Modify `tests/schema.test.ts`: verify schema and migration ownership constraints.
- Create `tests/campaign-service.test.ts`: verify the ownership predicate includes both identifiers and is used by the service.
- Modify `tests/app-campaign.test.ts`: verify invalid service output cannot return 200.
- Create `tests/errors.test.ts`: verify connection-error classification and negative controls.

### Task 1: Enforce Campaign-version ownership

**Files:**

- Modify: `tests/schema.test.ts`
- Create: `tests/campaign-service.test.ts`
- Modify: `src/db/schema/index.ts:114-164`
- Modify: `src/modules/campaigns/drizzle-campaign-service.ts:22-48`
- Create: `drizzle/0001_campaign_version_ownership.sql`
- Create: `drizzle/meta/0001_snapshot.json`
- Modify: `drizzle/meta/_journal.json`

**Interfaces:**

- Consumes: `campaignVersions`, `recallCampaigns`, Drizzle `SQL` predicates.
- Produces: `buildPublishedVersionQuery(db: Database, campaignId: string, versionId: string)` and a composite database foreign key named `recall_campaigns_published_version_owner_fk`.

- [ ] **Step 1: Write failing schema and query tests**

Add `getTableConfig` assertions to `tests/schema.test.ts`:

```ts
import { getTableConfig } from 'drizzle-orm/pg-core';

it('binds a published version to its owning campaign', async () => {
  const versionConfig = getTableConfig(schema.campaignVersions);
  const campaignConfig = getTableConfig(schema.recallCampaigns);
  const ownershipIndex = versionConfig.indexes.find(
    (index) => index.config.name === 'campaign_versions_campaign_id_id_uidx',
  );
  const ownershipForeignKey = campaignConfig.foreignKeys.find(
    (foreignKey) => foreignKey.getName() === 'recall_campaigns_published_version_owner_fk',
  );

  expect(
    ownershipIndex?.config.columns.map((column) => ('name' in column ? column.name : undefined)),
  ).toEqual(['campaign_id', 'id']);
  expect(ownershipForeignKey?.reference().columns.map((column) => column.name)).toEqual([
    'id',
    'published_version_id',
  ]);
  expect(ownershipForeignKey?.reference().foreignColumns.map((column) => column.name)).toEqual([
    'campaign_id',
    'id',
  ]);

  const migration = await readFile('drizzle/0001_campaign_version_ownership.sql', 'utf8').catch(
    () => '',
  );
  expect(migration).toContain('recall_campaigns_published_version_owner_fk');
});
```

Create `tests/campaign-service.test.ts`:

```ts
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
```

The mutation this test catches is removal of the Campaign ownership condition from the real Drizzle query emitted by the service.

- [ ] **Step 2: Run the targeted tests and verify RED**

Run:

```bash
pnpm test -- tests/schema.test.ts tests/campaign-service.test.ts
```

Expected: failing assertions because the ownership index, composite foreign key, migration, and query builder are absent.

- [ ] **Step 3: Add the schema constraints**

Import `foreignKey` from `drizzle-orm/pg-core`. Remove the existing single-column `.references()` from `publishedVersionId`, then add:

```ts
uniqueIndex('campaign_versions_campaign_id_id_uidx').on(table.campaignId, table.id),
```

to `campaignVersions`, and add:

```ts
foreignKey({
  name: 'recall_campaigns_published_version_owner_fk',
  columns: [table.id, table.publishedVersionId],
  foreignColumns: [campaignVersions.campaignId, campaignVersions.id],
}),
```

to `recallCampaigns`.

- [ ] **Step 4: Add and use the ownership query builder**

In `src/modules/campaigns/drizzle-campaign-service.ts`, add:

```ts
export function buildPublishedVersionQuery(db: Database, campaignId: string, versionId: string) {
  return db
    .select({ versionNumber: campaignVersions.versionNumber })
    .from(campaignVersions)
    .where(
      and(
        eq(campaignVersions.id, versionId),
        eq(campaignVersions.campaignId, campaignId),
        eq(campaignVersions.status, 'published'),
      ),
    )
    .limit(1);
}
```

Replace the inline version query with:

```ts
const [version] = await buildPublishedVersionQuery(db, campaign.id, versionId);
```

- [ ] **Step 5: Generate the new migration**

Run:

```bash
pnpm db:generate --name campaign_version_ownership
```

Expected: `drizzle/0001_campaign_version_ownership.sql` drops the old single-column foreign key, adds the composite unique index, and adds `recall_campaigns_published_version_owner_fk`.

- [ ] **Step 6: Run targeted tests and verify GREEN**

Run:

```bash
pnpm test -- tests/schema.test.ts tests/campaign-service.test.ts
pnpm typecheck
pnpm db:check
```

Expected: all commands exit 0.

- [ ] **Step 7: Commit the ownership fix**

```bash
git add src/db/schema/index.ts src/modules/campaigns/drizzle-campaign-service.ts tests/schema.test.ts tests/campaign-service.test.ts drizzle/0001_campaign_version_ownership.sql drizzle/meta/0001_snapshot.json drizzle/meta/_journal.json
git commit -m "Enforce published campaign version ownership"
```

### Task 2: Validate the public Campaign response

**Files:**

- Modify: `tests/app-campaign.test.ts`
- Modify: `src/app.ts:6-18,123-140`

**Interfaces:**

- Consumes: exported `campaignResponseSchema`.
- Produces: successful route output parsed as `{ campaign: CampaignView }`; invalid service output becomes the existing 500 Problem Details response.

- [ ] **Step 1: Write the failing HTTP regression test**

Add to `tests/app-campaign.test.ts`:

```ts
it('returns 500 instead of a contract-invalid 200 response', async () => {
  const invalidCampaign: CampaignView = {
    ...campaign,
    support: { ...campaign.support, email: 'not-an-email' },
    evidenceRequirements: [
      { ...campaign.evidenceRequirements[0]!, minimumFiles: 0, maximumFiles: 0 },
    ],
  };
  const service: CampaignService = {
    getPublishedCampaign: () => Promise.resolve(invalidCampaign),
  };

  const response = await appWith(service).request(
    '/v1/recall-campaigns/music-lollipop-demo-2026?locale=en-US',
  );

  expect(response.status).toBe(500);
  expect(response.headers.get('Content-Type')).toContain('application/problem+json');
  await expect(response.json()).resolves.toMatchObject({
    title: 'Internal Server Error',
    status: 500,
  });
});
```

- [ ] **Step 2: Run the test and verify RED**

Run:

```bash
pnpm test -- tests/app-campaign.test.ts
```

Expected: FAIL because the route returns 200.

- [ ] **Step 3: Parse the response at the HTTP boundary**

Import `campaignResponseSchema` in `src/app.ts`, then replace the direct response with:

```ts
const response = campaignResponseSchema.parse({ campaign });
return context.json(response, 200, {
  'Content-Language': response.campaign.locale,
  ETag: `"v${response.campaign.version}:${response.campaign.locale}"`,
});
```

- [ ] **Step 4: Run the targeted tests and verify GREEN**

Run:

```bash
pnpm test -- tests/app-campaign.test.ts
pnpm typecheck
```

Expected: both commands exit 0.

- [ ] **Step 5: Commit response validation**

```bash
git add src/app.ts tests/app-campaign.test.ts
git commit -m "Validate public campaign responses"
```

### Task 3: Classify PostgreSQL availability failures

**Files:**

- Create: `tests/errors.test.ts`
- Modify: `src/shared/errors.ts:18-44`

**Interfaces:**

- Consumes: unknown thrown values with optional `code`, `cause`, or `errors` properties.
- Produces: `isConnectionError(error: unknown): boolean` with recursive, cycle-safe classification.

- [ ] **Step 1: Write failing classifier tests**

Create `tests/errors.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import { isConnectionError } from '../src/shared/errors.js';

function codedError(code: string, cause?: unknown): Error & { code: string } {
  return Object.assign(new Error(code, cause === undefined ? undefined : { cause }), { code });
}

describe('database connection error classification', () => {
  it.each(['08000', '08003', '08006', '57P01', '57P02', '57P03', '53300'])(
    'recognizes PostgreSQL availability code %s',
    (code) => expect(isConnectionError(codedError(code))).toBe(true),
  );

  it('recognizes a network error nested through multiple causes', () => {
    const error = new Error('outer', {
      cause: new Error('middle', { cause: codedError('ECONNRESET') }),
    });
    expect(isConnectionError(error)).toBe(true);
  });

  it('recognizes connection errors inside AggregateError', () => {
    expect(isConnectionError(new AggregateError([codedError('ETIMEDOUT')], 'pool failed'))).toBe(
      true,
    );
  });

  it.each(['28P01', '42501', '23503', '42P01'])(
    'does not treat non-availability SQLSTATE %s as retryable',
    (code) => expect(isConnectionError(codedError(code))).toBe(false),
  );

  it('handles cyclic causes without looping', () => {
    const error = new Error('cycle');
    Object.assign(error, { cause: error });
    expect(isConnectionError(error)).toBe(false);
  });
});
```

- [ ] **Step 2: Run the classifier tests and verify RED**

Run:

```bash
pnpm test -- tests/errors.test.ts
```

Expected: SQLSTATE, nested-cause, and AggregateError cases fail.

- [ ] **Step 3: Implement recursive classification**

Keep the existing network set and add:

```ts
const POSTGRES_AVAILABILITY_ERROR_CODES = new Set(['57P01', '57P02', '57P03', '53300']);

function isAvailabilityCode(code: unknown): boolean {
  return (
    typeof code === 'string' &&
    (CONNECTION_ERROR_CODES.has(code) ||
      /^08[A-Z0-9]{3}$/.test(code) ||
      POSTGRES_AVAILABILITY_ERROR_CODES.has(code))
  );
}
```

Implement `isConnectionError` with a queue, `Set<object>` visited guard, and a maximum of 64 examined objects. For each object, test `code`, enqueue `cause`, and enqueue every entry in an array-valued `errors` property.

- [ ] **Step 4: Run targeted tests and verify GREEN**

Run:

```bash
pnpm test -- tests/errors.test.ts tests/app-campaign.test.ts
pnpm typecheck
```

Expected: both commands exit 0.

- [ ] **Step 5: Commit dependency classification**

```bash
git add src/shared/errors.ts tests/errors.test.ts
git commit -m "Classify PostgreSQL availability errors"
```

### Task 4: Full verification and handoff

**Files:**

- Verify all files changed in Tasks 1-3.
- Do not modify or stage `.vscode/`.

**Interfaces:**

- Consumes: completed ownership, validation, and error-classification changes.
- Produces: fresh evidence that the branch passes repository checks and local database reads.

- [ ] **Step 1: Run the full automated suite**

```bash
pnpm test
pnpm typecheck
pnpm lint
pnpm build
```

Expected: every command exits 0; the default test run may skip only the opt-in database integration suite.

- [ ] **Step 2: Run the local PostgreSQL integration suite**

```bash
RUN_DB_INTEGRATION=true pnpm test -- tests/campaign-integration.test.ts
```

Expected: all tests, including both database integration tests, pass.

- [ ] **Step 3: Check formatting only for branch-owned files**

```bash
git diff --name-only -z main...HEAD | xargs -0 pnpm exec prettier --check
```

Expected: all checked files use Prettier formatting. Do not format `.vscode/settings.json`.

- [ ] **Step 4: Inspect the final branch and migration**

```bash
git diff --check main...HEAD
git status --short --branch
git log --oneline --decorate -8
```

Expected: no staged or unstaged task changes remain, `.vscode/` remains untracked, and the branch contains the design plus focused implementation commits.
