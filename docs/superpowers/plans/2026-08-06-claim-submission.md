# Claim Submission Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现数据库事务支持的 `POST /v1/recall-campaigns/{slug}/claims`，以加密方式保存消费者与事故数据，完成附件关联、幂等、Communication 与 Outbox 原子写入，并返回契约定义的 201 响应。

**Architecture:** Neon 从不支持交互式事务的 HTTP 驱动切换到 Neon Serverless Pool，本地继续使用 node-postgres，并通过 `DatabaseHandle.transaction()` 暴露统一事务边界。`NodeSensitiveDataCrypto` 负责 AES-256-GCM 与 HMAC-SHA-256；`DrizzleCaseService` 拥有完整 Claim 聚合事务，Hono 路由只负责已校验输入、错误映射和响应 Schema 校验。

**Tech Stack:** Node.js 24.x、TypeScript 6、Hono 4、Zod/OpenAPI、Drizzle ORM 0.45、PostgreSQL、Neon Serverless Pool、Vitest 4、Node `crypto`。

## Global Constraints

- 公开 Claim 请求与响应契约保持不变。
- Phase 1 只有一种授权后台用户权限，可查看与导出完整数据；本计划不实现 Admin API、字段级权限或脱敏展示。
- 使用 AES-256-GCM；`FIELD_ENCRYPTION_KEY` 必须是 Base64 编码的 32 字节密钥。
- `HASH_PEPPER` 必须是 Base64 编码且解码后至少 32 字节，并且不得与加密密钥相同。
- Neon 使用 `drizzle-orm/neon-serverless` Pool；本地和标准 PostgreSQL 使用 `drizzle-orm/node-postgres`。
- Case、消费者、商品、Consent、Snapshot、Incident、Review、Document、Communication、Outbox、Idempotency 与 Draft 状态必须在同一事务内提交或回滚。
- 日志、错误、Outbox 和 Idempotency 记录不得保存明文 PII、事故描述、订单号、收件人、原始 Draft Token 或完整请求正文。
- Claim 成功只承诺 `emailStatus: queued`；不连接 Resend、不发送邮件、不实现 Resend Webhook。
- 不加入真实 Secret、不部署 Vercel、不修改 `.vscode/` 或 `.zcode/`。
- 所有生产代码改动必须遵循 Red-Green-Refactor；数据库集成测试使用 `RUN_DB_INTEGRATION=true` 显式启用。

## File Map

- `src/db/client.ts`：统一事务型数据库 Handle、Neon Serverless Pool 与连接关闭。
- `src/platform/crypto/node-sensitive-data-crypto.ts`：AES-GCM、密文 Envelope 与 HMAC 查询 Hash。
- `src/modules/cases/normalization.ts`：Canonical JSON、查询值规范化、Request Hash 与 Case Reference。
- `src/modules/cases/service.ts`：强类型 Claim Command/Response 接口。
- `src/modules/cases/drizzle-case-service.ts`：完整 Claim 聚合事务。
- `src/shared/errors.ts`：Claim 的 409 与 422 Domain Error。
- `src/app.ts`：201 路由响应、Schema 边界检查和现有 `duplex` 构建修复。
- `src/composition.ts`：只在 DB 与两个 Crypto Secret 都可用时注册真实 Case Service。
- `tests/crypto.test.ts`：加密与 Hash 行为测试。
- `tests/case-normalization.test.ts`：规范化、Request Hash 和 Reference 测试。
- `tests/app-claim.test.ts`：Claim HTTP 契约与错误映射测试。
- `tests/helpers/case-fixture.ts`：真实数据库 Claim Fixture、聚合读取与精确清理。
- `tests/case-integration.test.ts`：真实 PostgreSQL 原子写入、回滚、Incident 与幂等测试。
- `tests/case-http-integration.test.ts`：通过 Hono `app.request()` 执行真实 Claim 路由。
- `tests/db-client.test.ts`、现有三个 `*-integration.test.ts`：新 Driver/Handle 生命周期。
- `README.md`、`docs/phase-1/01-server-architecture.md`、`docs/phase-1/03-toc-api.md`、`docs/phase-1/04-frontend-integration.md`：实现状态与运行配置。

---

### Task 1: Transaction-capable database handle and build unblock

**Files:**

- Modify: `src/db/client.ts`
- Modify: `tests/db-client.test.ts`
- Modify: `tests/campaign-integration.test.ts`
- Modify: `tests/product-check-integration.test.ts`
- Modify: `tests/claim-draft-integration.test.ts`
- Modify: `scripts/migrate.ts`
- Modify: `src/db/seed.ts`
- Modify: `src/app.ts:279-284`

**Interfaces:**

- Produces: `DatabaseDriver = 'neon-serverless' | 'node-postgres'`
- Produces: `DatabaseExecutor`
- Produces: `DatabaseHandle.transaction<T>(work: (tx: DatabaseExecutor) => Promise<T>): Promise<T>`
- Produces: `DatabaseHandle.close(): Promise<void>`
- Consumed later by: `DrizzleCaseService` and every integration-test teardown.

- [ ] **Step 1: Update the driver tests first**

Replace the Neon expectation and add a Handle-shape test that does not issue a network query:

```ts
import { createDatabase, detectDriver } from '../src/db/client.js';

it('selects the transaction-capable Neon serverless driver', () => {
  expect(
    detectDriver('postgresql://user:pass@ep-pooler.us-east-2.aws.neon.tech/neondb?sslmode=require'),
  ).toBe('neon-serverless');
});

it('creates a transaction-capable handle', async () => {
  const handle = createDatabase('postgresql://user:pass@127.0.0.1:5432/koi_recall');
  expect(handle.driver).toBe('node-postgres');
  expect(handle.transaction).toBeTypeOf('function');
  expect(handle.close).toBeTypeOf('function');
  await handle.close();
});
```

- [ ] **Step 2: Run the targeted test and verify RED**

Run: `pnpm test -- tests/db-client.test.ts`

Expected: FAIL because the current driver value is `neon` and `DatabaseHandle` has no `driver`, `transaction`, or `close` members.

- [ ] **Step 3: Implement the common Handle**

Replace the Neon HTTP imports and construct both drivers behind one Handle:

```ts
import { Pool as NeonPool } from '@neondatabase/serverless';
import { drizzle as neonServerlessDrizzle, type NeonDatabase } from 'drizzle-orm/neon-serverless';
import { drizzle as nodePostgresDrizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool as NodePgPool } from 'pg';

export type Database = NeonDatabase<typeof schema> | NodePgDatabase<typeof schema>;
export type DatabaseExecutor = Pick<
  NodePgDatabase<typeof schema>,
  'select' | 'insert' | 'update' | 'delete' | 'execute'
>;
export type DatabaseDriver = 'neon-serverless' | 'node-postgres';

export interface DatabaseHandle {
  db: Database;
  driver: DatabaseDriver;
  transaction<T>(work: (tx: DatabaseExecutor) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}
```

For Neon, create one `NeonPool`, pass it to `neonServerlessDrizzle`, delegate `transaction()` to that database, and let `close()` call `pool.end()`. Do the same with `NodePgPool` and node-postgres. Keep `detectDriver()` hostname-based, but return `neon-serverless` for `*.neon.tech`.

- [ ] **Step 4: Update integration teardown**

In all three existing integration suites, replace:

```ts
await handle?.pool?.end();
```

with:

```ts
await handle?.close();
```

Update `scripts/migrate.ts` so the `neon-serverless` branch uses `NeonPool`, `drizzle-orm/neon-serverless`, and `drizzle-orm/neon-serverless/migrator`, then closes the Pool in `finally`. Update `src/db/seed.ts` to retain the returned Handle and call `handle.close()` in `finally` after all seed writes.

- [ ] **Step 5: Verify the driver tests are GREEN**

Run: `pnpm test -- tests/db-client.test.ts tests/campaign-integration.test.ts tests/product-check-integration.test.ts tests/claim-draft-integration.test.ts`

Expected: driver tests PASS; DB suites SKIP unless explicitly enabled.

- [ ] **Step 6: Reproduce and fix the existing TypeScript blocker**

Run: `pnpm typecheck`

Expected before the fix: FAIL at `src/app.ts` because `duplex` is not part of `RequestInit`.

Remove only this property because the replayed body is already a string, not a Node stream:

```ts
const replayed = new Request(context.req.raw.url, {
  method: context.req.raw.method,
  headers: context.req.raw.headers,
  body: rawBody,
});
```

Run: `pnpm typecheck && pnpm test -- tests/app-webhook-blob.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit Task 1**

```bash
git add src/db/client.ts src/app.ts src/db/seed.ts scripts/migrate.ts tests/db-client.test.ts tests/campaign-integration.test.ts tests/product-check-integration.test.ts tests/claim-draft-integration.test.ts
git commit -m "refactor: enable transactional database handles"
```

---

### Task 2: Authenticated field encryption and deterministic normalization

**Files:**

- Create: `src/platform/crypto/node-sensitive-data-crypto.ts`
- Create: `src/modules/cases/normalization.ts`
- Create: `tests/crypto.test.ts`
- Create: `tests/case-normalization.test.ts`

**Interfaces:**

- Consumes: existing `Ciphertext` and `SensitiveDataCryptoPort` from `src/platform/crypto/port.ts`.
- Produces: `new NodeSensitiveDataCrypto(encryptionKeyBase64, hashPepperBase64)`.
- Produces: `canonicalJson(value)`, `normalizeEmail(value)`, `normalizeAddress(value)`, `normalizeOrderNumber(value)`, `hashCanonicalRequest(value)`, `generateCaseReference()`.
- Consumed later by: `DrizzleCaseService` and `createDefaultRegistry`.

- [ ] **Step 1: Write failing Crypto tests**

Use fixed 32-byte test secrets and assert real cryptographic behavior:

```ts
const encryptionKey = Buffer.alloc(32, 7).toString('base64');
const pepper = Buffer.alloc(32, 9).toString('base64');

it('round-trips authenticated ciphertext without deterministic encryption', async () => {
  const crypto = new NodeSensitiveDataCrypto(encryptionKey, pepper);
  const first = await crypto.encrypt('Taylor 示例');
  const second = await crypto.encrypt('Taylor 示例');

  expect(first.keyVersion).toBe('v1');
  expect(first.value).not.toBe(second.value);
  await expect(crypto.decrypt(first)).resolves.toBe('Taylor 示例');
  await expect(crypto.decrypt(second)).resolves.toBe('Taylor 示例');
});

it('rejects tampered ciphertext', async () => {
  const crypto = new NodeSensitiveDataCrypto(encryptionKey, pepper);
  const encrypted = await crypto.encrypt('secret');
  const tampered = { ...encrypted, value: `${encrypted.value.slice(0, -1)}A` };
  await expect(crypto.decrypt(tampered)).rejects.toThrow();
});

it.each([
  { keyVersion: 'v1', value: 'not-an-envelope' },
  { keyVersion: 'v2', value: 'enc.v2.aes-256-gcm.a.b.c' },
])('rejects malformed or unknown-version ciphertext', async (ciphertext) => {
  const crypto = new NodeSensitiveDataCrypto(encryptionKey, pepper);
  await expect(crypto.decrypt(ciphertext)).rejects.toThrow();
});

it('creates stable lookup hashes', async () => {
  const crypto = new NodeSensitiveDataCrypto(encryptionKey, pepper);
  await expect(crypto.lookupHash('taylor@example.com')).resolves.toBe(
    await crypto.lookupHash('taylor@example.com'),
  );
  expect(await crypto.lookupHash('other@example.com')).not.toBe(
    await crypto.lookupHash('taylor@example.com'),
  );
});

it.each([
  ['', pepper],
  [Buffer.alloc(31).toString('base64'), pepper],
  [encryptionKey, Buffer.alloc(31).toString('base64')],
  [encryptionKey, encryptionKey],
])('rejects unsafe secret configuration', (key, hashPepper) => {
  expect(() => new NodeSensitiveDataCrypto(key, hashPepper)).toThrow();
});
```

- [ ] **Step 2: Verify Crypto tests are RED**

Run: `pnpm test -- tests/crypto.test.ts`

Expected: FAIL because `node-sensitive-data-crypto.ts` does not exist.

- [ ] **Step 3: Implement AES-256-GCM and HMAC**

Use Node `createCipheriv`, `createDecipheriv`, `createHmac`, and `randomBytes`. Encode the envelope exactly as:

```text
enc.v1.aes-256-gcm.<iv-base64url>.<ciphertext-base64url>.<tag-base64url>
```

The class skeleton and public behavior are:

```ts
const b64 = (value: Buffer): string => value.toString('base64url');

export class NodeSensitiveDataCrypto implements SensitiveDataCryptoPort {
  private readonly key: Buffer;
  private readonly pepper: Buffer;

  constructor(encryptionKeyBase64: string, hashPepperBase64: string) {
    this.key = decodeSecret('FIELD_ENCRYPTION_KEY', encryptionKeyBase64, 32, 32);
    this.pepper = decodeSecret('HASH_PEPPER', hashPepperBase64, 32);
    if (this.key.equals(this.pepper)) {
      throw new Error('FIELD_ENCRYPTION_KEY and HASH_PEPPER must be distinct.');
    }
  }

  async encrypt(plaintext: string): Promise<Ciphertext> {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return {
      keyVersion: 'v1',
      value: ['enc', 'v1', 'aes-256-gcm', b64(iv), b64(encrypted), b64(tag)].join('.'),
    };
  }

  async decrypt(input: Ciphertext): Promise<string> {
    const parts = input.value.split('.');
    if (parts.length !== 6) throw new Error('Malformed encrypted value envelope.');
    const [prefix, version, algorithm, iv, body, tag] = parts as [
      string,
      string,
      string,
      string,
      string,
      string,
    ];
    if (
      prefix !== 'enc' ||
      version !== input.keyVersion ||
      version !== 'v1' ||
      algorithm !== 'aes-256-gcm'
    ) {
      throw new Error('Unsupported encrypted value envelope.');
    }
    const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(iv, 'base64url'));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([
      decipher.update(Buffer.from(body, 'base64url')),
      decipher.final(),
    ]).toString('utf8');
  }

  async lookupHash(normalizedValue: string): Promise<string> {
    return createHmac('sha256', this.pepper).update(normalizedValue, 'utf8').digest('hex');
  }
}
```

`decodeSecret()` must reject invalid Base64, wrong encryption-key length, short Pepper, and identical decoded secrets.

- [ ] **Step 4: Verify Crypto tests are GREEN**

Run: `pnpm test -- tests/crypto.test.ts`

Expected: PASS.

- [ ] **Step 5: Write failing normalization tests**

```ts
it('normalizes lookup values', () => {
  expect(normalizeEmail('  Taylor@Example.COM ')).toBe('taylor@example.com');
  expect(normalizeOrderNumber(' order-1001 ')).toBe('ORDER-1001');
  expect(
    normalizeAddress({
      line1: ' 100 Example Street ',
      city: ' Austin ',
      state: ' TX ',
      postalCode: ' 78701 ',
      countryCode: 'us',
    }),
  ).toBe(
    '{"city":"Austin","countryCode":"US","line1":"100 Example Street","postalCode":"78701","state":"TX"}',
  );
});

it('hashes object keys canonically while preserving array order', () => {
  expect(hashCanonicalRequest({ b: 2, a: 1 })).toBe(hashCanonicalRequest({ a: 1, b: 2 }));
  expect(hashCanonicalRequest({ values: [1, 2] })).not.toBe(
    hashCanonicalRequest({ values: [2, 1] }),
  );
});

it('generates contract-valid case references', () => {
  expect(generateCaseReference()).toMatch(/^KOI-[A-Z0-9]{4}-[A-Z0-9]{8}$/);
});
```

- [ ] **Step 6: Verify normalization tests are RED**

Run: `pnpm test -- tests/case-normalization.test.ts`

Expected: FAIL because the functions do not exist.

- [ ] **Step 7: Implement normalization helpers**

Implement recursive key sorting for plain objects, JSON-preserving array order, SHA-256 hex Request Hash, trimmed strings, uppercase country/order fields, and a Case Reference generated from an ambiguity-free uppercase alphabet using `randomBytes()`.

```ts
const CASE_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ'; // exactly 32 symbols

function randomToken(length: number): string {
  return Array.from(randomBytes(length), (byte) => CASE_ALPHABET[byte & 31]).join('');
}

export function hashCanonicalRequest(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
}

export function generateCaseReference(): string {
  return `KOI-${randomToken(4)}-${randomToken(8)}`;
}
```

- [ ] **Step 8: Verify and commit Task 2**

Run: `pnpm test -- tests/crypto.test.ts tests/case-normalization.test.ts`

Expected: PASS.

```bash
git add src/platform/crypto/node-sensitive-data-crypto.ts src/modules/cases/normalization.ts tests/crypto.test.ts tests/case-normalization.test.ts
git commit -m "feat: add authenticated field encryption"
```

---

### Task 3: Typed Claim service, HTTP 201, and domain errors

**Files:**

- Modify: `src/contracts/toc.ts`
- Modify: `src/modules/cases/service.ts`
- Modify: `src/shared/errors.ts`
- Modify: `src/app.ts:238-245`
- Create: `tests/app-claim.test.ts`

**Interfaces:**

- Produces: exported `ClaimSubmissionRequest` and `ClaimSubmissionResponse` Zod-inferred types.
- Produces: `CaseService.submit(command): Promise<ClaimSubmissionResponse>`.
- Produces: `ClaimConflictError` (409) and `ClaimValidationError` (422).
- Consumes later: `DrizzleCaseService` implements the exact interface.

- [ ] **Step 1: Export contract types**

Immediately after each Claim Schema, export:

```ts
export type ClaimSubmissionRequest = z.infer<typeof claimSubmissionRequestSchema>;
export type ClaimSubmissionResponse = z.infer<typeof claimSubmissionResponseSchema>;
```

- [ ] **Step 2: Write failing HTTP tests**

Build `appWithCaseService()` by replacing only `registry.services.cases` in `createPlaceholderRegistry()`. Use the existing valid Claim body from `tests/contracts.test.ts`.

```ts
it('returns the validated service result as 201', async () => {
  const result: ClaimSubmissionResponse = {
    caseReference: 'KOI-7N4Q-A91M2X6P',
    submittedAt: '2026-08-06T09:00:00.000Z',
    emailStatus: 'queued',
    nextStep: 'Keep this reference. We will email you after your claim has been received.',
  };
  const response = await postClaim(appWithCaseService(() => Promise.resolve(result)));
  expect(response.status).toBe(201);
  await expect(response.json()).resolves.toEqual(result);
});

it('turns a contract-invalid service result into 500', async () => {
  const response = await postClaim(
    appWithCaseService(() =>
      Promise.resolve({
        caseReference: 'internal-1',
        submittedAt: 'not-a-date',
        emailStatus: 'queued',
        nextStep: '',
      } as ClaimSubmissionResponse),
    ),
  );
  expect(response.status).toBe(500);
});

it.each([
  [new ResourceNotFoundError('Campaign not found.'), 404],
  [new ClaimConflictError('Claim conflict.'), 409],
  [new DraftExpiredOrInvalidError('Draft unavailable.'), 410],
  [new ClaimValidationError('Claim invalid.'), 422],
] as const)('maps domain errors to Problem Details', async (error, status) => {
  const response = await postClaim(appWithCaseService(() => Promise.reject(error)));
  expect(response.status).toBe(status);
  expect(response.headers.get('Content-Type')).toContain('application/problem+json');
});

it('returns 503 when the Claim database is unavailable', async () => {
  const response = await postClaim(
    appWithCaseService(() =>
      Promise.reject(Object.assign(new Error('connect failed'), { code: 'ECONNREFUSED' })),
    ),
  );
  expect(response.status).toBe(503);
});

it('keeps the default Claim capability at 501 without providers', async () => {
  const response = await postClaim(createApp({ config: testConfig }));
  expect(response.status).toBe(501);
});
```

- [ ] **Step 3: Run the HTTP test and verify RED**

Run: `pnpm test -- tests/app-claim.test.ts`

Expected: FAIL because the route still returns 501 and Claim error classes do not exist.

- [ ] **Step 4: Implement typed service and errors**

```ts
export interface ClaimSubmissionCommand {
  campaignSlug: string;
  idempotencyKey: string;
  body: ClaimSubmissionRequest;
}

export interface CaseService {
  submit(command: ClaimSubmissionCommand): Promise<ClaimSubmissionResponse>;
}

export class ClaimConflictError extends HttpProblemError {
  readonly status = 409;
  readonly type = problemType('conflict');
  readonly title = 'Conflict';
}

export class ClaimValidationError extends HttpProblemError {
  readonly status = 422;
  readonly type = problemType('unprocessable-entity');
  readonly title = 'Unprocessable Entity';
}
```

Update the route:

```ts
app.openapi(submitClaimRoute, async (context) => {
  let submitted;
  try {
    submitted = await registry.services.cases.submit({
      campaignSlug: context.req.valid('param').slug,
      idempotencyKey: context.req.valid('header')['Idempotency-Key'],
      body: context.req.valid('json'),
    });
  } catch (error) {
    if (isConnectionError(error)) return dependencyUnavailable(context, 'Recall claim submission');
    throw error;
  }
  return context.json(claimSubmissionResponseSchema.parse(submitted), 201);
});
```

- [ ] **Step 5: Verify and commit Task 3**

Run: `pnpm test -- tests/app-claim.test.ts tests/contracts.test.ts && pnpm typecheck`

Expected: PASS.

```bash
git add src/contracts/toc.ts src/modules/cases/service.ts src/shared/errors.ts src/app.ts tests/app-claim.test.ts
git commit -m "feat: return typed claim submission responses"
```

---

### Task 4: Standard Claim aggregate transaction

**Files:**

- Create: `src/modules/cases/drizzle-case-service.ts`
- Create: `tests/helpers/case-fixture.ts`
- Create: `tests/case-integration.test.ts`

**Interfaces:**

- Consumes: `DatabaseHandle.transaction`, `SensitiveDataCryptoPort`, Claim contract types, normalization helpers, existing `evaluateProductCheck()`.
- Produces: `DrizzleCaseService implements CaseService`.
- Produces: one complete no-incident Claim transaction, including Communication and Outbox.

- [ ] **Step 1: Create real integration fixtures and a failing happy-path test**

Gate the suite exactly like existing DB integration tests. Create a fresh Draft with `DrizzleClaimDraftService`, then insert two `verified` `document_uploads` rows for `product_photo` and `proof_of_purchase`. Use unique UUIDs for every test.

```ts
it('atomically persists a standard claim without plaintext sensitive data', async () => {
  const fixture = await createClaimFixture();
  const result = await service.submit({
    campaignSlug: 'music-lollipop-demo-2026',
    idempotencyKey: randomUUID(),
    body: fixture.body({ incidentAnswer: 'no' }),
  });

  expect(result.caseReference).toMatch(/^KOI-[A-Z0-9]{4}-[A-Z0-9]{8}$/);
  expect(result.emailStatus).toBe('queued');

  const aggregate = await loadAggregate(result.caseReference);
  expect(aggregate.case.status).toBe('submitted');
  expect(aggregate.draft.status).toBe('submitted');
  expect(aggregate.products).toHaveLength(1);
  expect(aggregate.documents.every((row) => row.uploadStatus === 'linked')).toBe(true);
  expect(aggregate.consents).toHaveLength(2);
  expect(aggregate.communications).toHaveLength(1);
  expect(aggregate.outbox).toHaveLength(1);
  expect(aggregate.incidents).toHaveLength(0);
  expect(JSON.stringify(aggregate)).not.toContain('taylor@example.com');
  expect(JSON.stringify(aggregate)).not.toContain('100 Example Street');
});
```

Put `createClaimFixture(handle)`, `loadAggregate(handle, caseReference)`, `countCasesForDraft(handle, draftId)`, and `cleanupClaimFixture(handle, fixture)` in `tests/helpers/case-fixture.ts`. `afterEach` must call the cleanup helper, which deletes test data in reverse dependency order using captured IDs; it must never delete seeded Campaign rows.

- [ ] **Step 2: Run the happy-path test and verify RED**

Run: `RUN_DB_INTEGRATION=true pnpm test -- tests/case-integration.test.ts -t "atomically persists"`

Expected: FAIL because `DrizzleCaseService` does not exist.

- [ ] **Step 3: Implement precomputation and fast idempotency replay**

`submit()` must compute all encrypted values before opening the transaction:

```ts
const endpoint = `/v1/recall-campaigns/${command.campaignSlug}/claims`;
const requestHash = hashCanonicalRequest(command.body);
const keyHash = await this.crypto.lookupHash(command.idempotencyKey);
const existing = await this.findIdempotency(endpoint, keyHash);
if (existing) return this.replay(existing, requestHash);

const encrypted = await this.encryptSubmission(command.body);
const submittedAt = new Date();
```

`replay()` parses `responseBody` with `claimSubmissionResponseSchema`; mismatched `requestHash` throws `ClaimConflictError`.

- [ ] **Step 4: Implement transactional validation with a Draft lock**

Inside `handle.transaction(async (tx) => ...)`, select Draft, Campaign, and pinned Version with `FOR UPDATE`. Compare the existing SHA-256 Draft token hash, state, expiry, and slug. Throw:

- `ResourceNotFoundError` for Campaign/slug mismatch.
- `DraftExpiredOrInvalidError` for token mismatch, expired Draft, or inactive Draft.
- `ClaimValidationError` for product ownership, inactive Remedy, duplicate/unverified/wrong-Draft documents, evidence counts, or Consent set.

Use these exact validation rules:

```ts
const consentTypes = body.consents.map((item) => item.type);
if (
  consentTypes.length !== 2 ||
  new Set(consentTypes).size !== 2 ||
  !consentTypes.includes('privacy_notice') ||
  !consentTypes.includes('information_accuracy')
) {
  throw new ClaimValidationError('Both required consents must be accepted exactly once.');
}

if (new Set(body.documentIds).size !== body.documentIds.length) {
  throw new ClaimValidationError('Document IDs must be unique.');
}
```

Recalculate Evidence Category counts from the selected verified documents and every pinned `campaign_evidence_requirements` row.

- [ ] **Step 5: Implement core atomic writes**

Generate Case ID and Reference before inserts. Insert, in dependency order:

1. `recall_cases` (`submitted` or `triage` from product match results).
2. `case_consumers` with encrypted fields and Email/Address HMAC.
3. `claimed_products` with optional encrypted Order Number and its HMAC.
4. `case_consents`.
5. `submission_snapshots` using `schemaVersion: 'phase1-v1'` and encrypted canonical request.
6. Update only the selected `document_uploads` rows with `caseId`, `draftId: null`, `categorySlot: null`, `uploadStatus: 'linked'`, and `linkedAt`.
7. Update the locked Draft to `submitted` with `submittedCaseId`.
8. `case_events` with `{ locale, productCount, documentCount, incidentAnswer }` only.
9. Resolve the highest active `claim_confirmation` template for pinned Version/Locale; insert `communications` with encrypted Email and status `queued`.
10. Insert `outbox_events` with `eventType: 'claim.confirmation.requested'`, deduplication key `claim-confirmation:${keyHash}`, and payload `{ communicationId, caseId }`.
11. Insert `idempotency_records` with the response body, status 201, and a 24-hour expiry.

The response is exactly:

```ts
const response: ClaimSubmissionResponse = {
  caseReference,
  submittedAt: submittedAt.toISOString(),
  emailStatus: 'queued',
  nextStep: 'Keep this reference. We will email you after your claim has been received.',
};
```

Never include recipient, Claim body, ciphertext, or Draft token in the Outbox payload or Case event.

- [ ] **Step 6: Verify the happy path is GREEN**

Run: `RUN_DB_INTEGRATION=true pnpm test -- tests/case-integration.test.ts -t "atomically persists"`

Expected: PASS.

- [ ] **Step 7: Add failing validation-and-rollback cases**

Add table-driven tests for wrong Campaign slug, expired Draft, unowned Product, inactive Remedy, duplicate documents, non-verified documents, missing required category, and duplicate Consent. For every failure, assert no `recall_cases` row and Draft remains `active`.

Add these non-rejection and ownership tests:

- A submitted product that evaluates to `not_matched` still creates one Case with status `triage` and persists `checkResult: 'not_matched'`.
- A third verified Document owned by the Draft but omitted from `documentIds` remains Draft-owned and is not linked to the Case.
- A missing active `claim_confirmation` template throws a server error and rolls back all Case-owned writes.

For the rollback test, first insert a temporary unrelated `outbox_events` row whose deduplication key is `claim-confirmation:${keyHash}`. The Claim transaction will then fail on the real Outbox unique constraint after its earlier aggregate writes. Assert that every Claim-owned write rolled back, then delete the temporary Outbox row:

```ts
const idempotencyKey = randomUUID();
const command = fixture.command({ idempotencyKey });
const keyHash = await crypto.lookupHash(idempotencyKey);
await handle!.db.insert(outboxEvents).values({
  aggregateType: 'test',
  aggregateId: randomUUID(),
  eventType: 'test.conflict',
  deduplicationKey: `claim-confirmation:${keyHash}`,
  payload: {},
});
await expect(service.submit(command)).rejects.toMatchObject({ code: '23505' });
await expect(loadCaseByDraftId(fixture.draftId)).resolves.toBeNull();
await expect(loadDraftStatus(fixture.draftId)).resolves.toBe('active');
await handle!.db
  .delete(outboxEvents)
  .where(eq(outboxEvents.deduplicationKey, `claim-confirmation:${keyHash}`));
```

- [ ] **Step 8: Verify rollback behavior and commit Task 4**

Run: `RUN_DB_INTEGRATION=true pnpm test -- tests/case-integration.test.ts`

Expected: all standard Claim and rollback cases PASS.

```bash
git add src/modules/cases/drizzle-case-service.ts tests/helpers/case-fixture.ts tests/case-integration.test.ts
git commit -m "feat: persist standard recall claims atomically"
```

---

### Task 5: Incident normalization and reportability review

**Files:**

- Modify: `src/modules/cases/drizzle-case-service.ts`
- Modify: `tests/case-integration.test.ts`

**Interfaces:**

- Consumes: the Task 4 transaction and encrypted submission data.
- Produces: `yes`/`unsure` Incident plus pending Reportability Review inside the same transaction.

- [ ] **Step 1: Add failing Incident tests**

```ts
it('persists yes as an encrypted incident with pending review', async () => {
  const fixture = await createClaimFixture();
  const result = await service.submit({
    campaignSlug: SEED_SLUG,
    idempotencyKey: randomUUID(),
    body: fixture.body({
      incidentAnswer: 'yes',
      incidentDetails: {
        eventTypes: ['injury'],
        narrative: 'A fictional minor injury occurred during use.',
        occurredDateUnknown: true,
        injurySeverity: 'minor',
        medicalTreatment: 'first_aid',
      },
    }),
  });
  const aggregate = await loadAggregate(result.caseReference);
  expect(aggregate.case.subtype).toBe('injury_hazard');
  expect(aggregate.case.incidentFlag).toBe(true);
  expect(aggregate.incidents[0]).toMatchObject({
    answer: 'yes',
    eventTypes: ['injury'],
    occurredDateUnknown: true,
  });
  expect(aggregate.reviews[0].status).toBe('pending');
  expect(JSON.stringify(aggregate.incidents[0])).not.toContain('fictional minor injury');
});

it('normalizes unsure without event type or date and routes to triage', async () => {
  const fixture = await createClaimFixture();
  const result = await service.submit({
    campaignSlug: SEED_SLUG,
    idempotencyKey: randomUUID(),
    body: fixture.body({
      incidentAnswer: 'unsure',
      incidentDetails: {
        narrative: 'The consumer is unsure whether a safety incident occurred.',
      },
    }),
  });
  const aggregate = await loadAggregate(result.caseReference);
  expect(aggregate.case.status).toBe('triage');
  expect(aggregate.incidents[0]).toMatchObject({
    answer: 'unsure',
    eventTypes: ['unknown'],
    occurredDateUnknown: true,
  });
  expect(aggregate.reviews[0].status).toBe('pending');
});
```

- [ ] **Step 2: Run Incident tests and verify RED**

Run: `RUN_DB_INTEGRATION=true pnpm test -- tests/case-integration.test.ts -t "incident|unsure"`

Expected: FAIL because Task 4 does not insert Incident or Review rows.

- [ ] **Step 3: Add Incident writes inside the existing transaction**

For `yes` or `unsure`, insert into the exact `incidents` and `reportability_reviews` tables:

```ts
const details = body.incidentDetails!;
const eventTypes = details.eventTypes?.length ? details.eventTypes : ['unknown'];
const occurredDateUnknown = details.occurredDateUnknown || !details.occurredDate;
const [incident] = await tx
  .insert(incidents)
  .values({
    caseId,
    answer: body.incidentAnswer,
    eventTypes,
    narrativeKeyVersion: encrypted.incidentNarrative!.keyVersion,
    narrativeEncrypted: encrypted.incidentNarrative!.value,
    occurredAt: details.occurredDate ? new Date(`${details.occurredDate}T00:00:00.000Z`) : null,
    occurredDateUnknown,
    injurySeverity: details.injurySeverity,
    medicalTreatment: details.medicalTreatment,
    usedAsIntended: details.usedAsIntended,
    companyObtainedAt: submittedAt,
  })
  .returning({ id: incidents.id });

await tx.insert(reportabilityReviews).values({ incidentId: incident!.id, status: 'pending' });
```

Set Case `subtype: 'injury_hazard'` and `incidentFlag: true` for both answers; `unsure` always sets Case status `triage`.

- [ ] **Step 4: Verify and commit Task 5**

Run: `RUN_DB_INTEGRATION=true pnpm test -- tests/case-integration.test.ts`

Expected: standard, `yes`, and `unsure` cases PASS.

```bash
git add src/modules/cases/drizzle-case-service.ts tests/case-integration.test.ts
git commit -m "feat: persist incident review during claim submission"
```

---

### Task 6: Idempotency and concurrent submission hardening

**Files:**

- Modify: `src/modules/cases/drizzle-case-service.ts`
- Modify: `tests/case-integration.test.ts`

**Interfaces:**

- Consumes: Task 4 completed Idempotency record and Draft locking.
- Produces: safe replay, conflict, same-Key race recovery, and bounded public-reference collision retry.

- [ ] **Step 1: Add failing replay and conflict tests**

```ts
it('replays the original response for the same key and canonical request', async () => {
  const fixture = await createClaimFixture();
  const command = fixture.command({ idempotencyKey: randomUUID() });
  const first = await service.submit(command);
  const replay = await service.submit({
    ...command,
    body: { ...command.body, consumer: { ...command.body.consumer } },
  });
  expect(replay).toEqual(first);
  expect(await countCasesForDraft(fixture.draftId)).toBe(1);
});

it('returns 409 when a key is reused with a different request', async () => {
  const fixture = await createClaimFixture();
  const command = fixture.command({ idempotencyKey: randomUUID() });
  await service.submit(command);
  await expect(
    service.submit({
      ...command,
      body: { ...command.body, remedyCode: 'refund' },
    }),
  ).rejects.toBeInstanceOf(ClaimConflictError);
});
```

- [ ] **Step 2: Add a failing concurrent Draft test**

```ts
it('creates exactly one Case for concurrent submission of one Draft', async () => {
  const fixture = await createClaimFixture();
  const results = await Promise.allSettled([
    service.submit(fixture.command({ idempotencyKey: randomUUID() })),
    service.submit(fixture.command({ idempotencyKey: randomUUID() })),
  ]);
  expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
  expect(await countCasesForDraft(fixture.draftId)).toBe(1);
});

it('replays one result for concurrent requests with the same key and body', async () => {
  const fixture = await createClaimFixture();
  const command = fixture.command({ idempotencyKey: randomUUID() });
  const [first, second] = await Promise.all([service.submit(command), service.submit(command)]);
  expect(second).toEqual(first);
  expect(await countCasesForDraft(fixture.draftId)).toBe(1);
});

it('allows only one winner when one key is used for different Drafts', async () => {
  const first = await createClaimFixture();
  const second = await createClaimFixture();
  const idempotencyKey = randomUUID();
  const results = await Promise.allSettled([
    service.submit(first.command({ idempotencyKey })),
    service.submit(second.command({ idempotencyKey })),
  ]);
  expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
  expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
});
```

- [ ] **Step 3: Run the focused tests and verify RED where behavior is incomplete**

Run: `RUN_DB_INTEGRATION=true pnpm test -- tests/case-integration.test.ts -t "replays|reused|concurrent"`

Expected: at least the concurrent or unique-race case FAILS until recovery is implemented.

- [ ] **Step 4: Implement unique-race recovery outside the failed transaction**

Catch only SQLSTATE `23505` for `idempotency_records_endpoint_key_uidx`. After the losing transaction rolls back, load the winner through `findIdempotency()` and call `replay()`. Other unique violations, including public-reference collisions, follow their dedicated handling and must not be mislabeled as replay.

Use `.onConflictDoNothing({ target: recallCases.publicReference }).returning({ id: recallCases.id })` for bounded Case Reference attempts before dependent inserts so a collision does not abort the transaction. Inject a `referenceGenerator: () => string` dependency whose default is `generateCaseReference`; this is a stable boundary for deterministic collision testing. Add a test that pre-inserts the first generated Reference, returns a unique second Reference, and proves the service succeeds with the second value. After three collisions, throw a server error.

- [ ] **Step 5: Verify idempotency/concurrency and commit Task 6**

Run: `RUN_DB_INTEGRATION=true pnpm test -- tests/case-integration.test.ts`

Expected: all integration cases PASS and every fixture creates no more than one Case.

```bash
git add src/modules/cases/drizzle-case-service.ts tests/case-integration.test.ts
git commit -m "fix: harden claim idempotency and concurrency"
```

---

### Task 7: Configuration and application composition

**Files:**

- Modify: `src/composition.ts`
- Modify: `tests/composition.test.ts`

**Interfaces:**

- Consumes: `NodeSensitiveDataCrypto`, `DrizzleCaseService`, `DatabaseHandle`.
- Produces: real Case Service only when `DATABASE_URL`, `FIELD_ENCRYPTION_KEY`, and `HASH_PEPPER` are all present.
- Preserves: real non-Claim DB services when Crypto Secrets are absent.

- [ ] **Step 1: Write failing composition tests**

```ts
it('keeps Claim unavailable when crypto secrets are missing', async () => {
  const registry = createApplicationRegistry(fakeHandle, fakeBlob);
  await expect(registry.services.cases.submit(validCommand)).rejects.toBeInstanceOf(
    NotImplementedServiceError,
  );
});

it('registers the Drizzle Case service when crypto is configured', () => {
  const crypto = new NodeSensitiveDataCrypto(testKey, testPepper);
  const registry = createApplicationRegistry(fakeHandle, fakeBlob, crypto);
  expect(registry.services.cases).toBeInstanceOf(DrizzleCaseService);
  expect(registry.platform.crypto).toBe(crypto);
});
```

Use a minimal typed `fakeHandle`; do not make a real network connection.

- [ ] **Step 2: Run composition tests and verify RED**

Run: `pnpm test -- tests/composition.test.ts`

Expected: FAIL because `createApplicationRegistry` does not accept or register a Crypto adapter.

- [ ] **Step 3: Implement conditional Crypto and Case composition**

Change the registry factory signature:

```ts
export function createApplicationRegistry(
  handle: DatabaseHandle,
  blob: PrivateBlobPort = new NotImplementedPrivateBlobAdapter(),
  crypto: SensitiveDataCryptoPort = new NotImplementedCryptoAdapter(),
): ApplicationRegistry;
```

Only replace `placeholder.services.cases` when `crypto` is not `NotImplementedCryptoAdapter`; always keep Campaign, Product Check, Draft, and Documents database-backed.

In `createDefaultRegistry`, construct `NodeSensitiveDataCrypto` only when both Secret strings are present. If either is missing, pass `NotImplementedCryptoAdapter`. Pass the same adapter into `platform.crypto`.

Keep the Secrets optional in `loadConfig()` so existing partial endpoints boot without them; constructor validation makes unsafe provided values a startup error.

- [ ] **Step 4: Verify placeholder and real composition**

Run: `pnpm test -- tests/composition.test.ts tests/app.test.ts tests/app-claim.test.ts`

Expected: PASS. An app without DB remains all-501; DB without Crypto keeps only Claim at 501; injected real Case Service returns 201.

- [ ] **Step 5: Commit Task 7**

```bash
git add src/composition.ts tests/composition.test.ts
git commit -m "feat: compose encrypted claim submission service"
```

---

### Task 8: Documentation, direct Hono proof, and full verification

**Files:**

- Modify: `README.md`
- Modify: `docs/phase-1/01-server-architecture.md`
- Modify: `docs/phase-1/03-toc-api.md`
- Modify: `docs/phase-1/04-frontend-integration.md`
- Modify: `tests/docs.test.ts`
- Create: `tests/case-http-integration.test.ts`

**Interfaces:**

- Consumes: the completed Claim service and configuration behavior.
- Produces: accurate operator/frontend documentation and final verification evidence.

- [ ] **Step 1: Write failing documentation assertions**

Update `tests/docs.test.ts` to require all relevant documents to state:

```ts
expect(readme).toContain('Claim 提交');
expect(readme).toContain('FIELD_ENCRYPTION_KEY');
expect(apiDoc).toContain('emailStatus=queued');
expect(apiDoc).toContain('Resend');
expect(architecture).toContain('Neon Serverless Pool');
```

Also assert the docs no longer say the Claim endpoint always returns 501; they may still document conditional 501 when DB/Crypto is missing.

- [ ] **Step 2: Run docs tests and verify RED**

Run: `pnpm test -- tests/docs.test.ts`

Expected: FAIL because current documents describe Claim as unimplemented.

- [ ] **Step 3: Update operational and frontend documentation**

Document exact enablement:

```env
DATABASE_URL=postgresql://alexyuan@127.0.0.1:5432/koi_recall
```

Generate two distinct local values without committing them:

```bash
FIELD_ENCRYPTION_KEY="$(openssl rand -base64 32)" \
HASH_PEPPER="$(openssl rand -base64 32)" \
pnpm dev
```

State explicitly:

- Claim returns 201 only when DB and both Crypto Secrets are configured.
- Confirmation Communication and Outbox are persisted atomically.
- Resend delivery/Webhook, Outbox worker, Draft cleanup, and physical Blob deletion remain 501/follow-up work.
- Neon must use a pooled Neon connection string.
- Frontend must reuse the same Idempotency Key after network uncertainty.

- [ ] **Step 4: Verify docs and generated contracts**

Run: `pnpm test -- tests/docs.test.ts tests/openapi.test.ts && pnpm openapi:check && pnpm db:check`

Expected: PASS; OpenAPI YAML remains unchanged except generator-stable formatting.

- [ ] **Step 5: Run the full default verification suite**

Run:

```bash
pnpm test
pnpm typecheck
pnpm lint
pnpm build
```

Run Prettier only against tracked TypeScript/Markdown files changed from `origin/main`; this excludes the pre-existing untracked `.vscode/` and `.zcode/` directories:

```bash
git diff --name-only origin/main...HEAD -- '*.ts' '*.md' | xargs pnpm exec prettier --check
```

Expected:

- All default tests PASS; only opt-in DB tests SKIP.
- TypeScript, ESLint, Prettier, OpenAPI, and Drizzle checks PASS.
- No `RequestInit.duplex` error.

- [ ] **Step 6: Run the full PostgreSQL integration suite**

Ensure the local test database is migrated and seeded, then run:

```bash
RUN_DB_INTEGRATION=true pnpm test
```

Expected: all default and Campaign/Product/Draft/Claim integration tests PASS with zero skipped DB tests.

- [ ] **Step 7: Run direct Hono `app.request()` proof**

Create `tests/case-http-integration.test.ts`, gated by `RUN_DB_INTEGRATION=true`. It must create a fresh Draft and two verified Document rows through `createClaimFixture(handle)`, build a registry with the real `DrizzleCaseService`, call `createApp({ config, registry }).request()` with a valid Claim body, assert the response, load the aggregate, and clean up in `afterEach`. Do not start an HTTP server.

The core test is:

```ts
it('submits a seeded claim through Hono app.request', async () => {
  const fixture = await createClaimFixture(handle!);
  const response = await app.request(`/v1/recall-campaigns/${SEED_SLUG}/claims`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Idempotency-Key': randomUUID(),
    },
    body: JSON.stringify(fixture.body({ incidentAnswer: 'no' })),
  });
  expect(response.status).toBe(201);
  const body = claimSubmissionResponseSchema.parse(await response.json());
  const aggregate = await loadAggregate(handle!, body.caseReference);
  expect(body.emailStatus).toBe('queued');
  expect(aggregate.draft.status).toBe('submitted');
  expect(aggregate.documents).toHaveLength(2);
});
```

Run:

```bash
RUN_DB_INTEGRATION=true pnpm test -- tests/case-http-integration.test.ts
```

Expected evidence:

```text
status=201
caseReference matches ^KOI-[A-Z0-9]{4}-[A-Z0-9]{8}$
emailStatus=queued
draftStatus=submitted
linkedDocuments=2
```

Clean up only the generated test Case/Draft rows after recording the result.

- [ ] **Step 8: Check the final diff and commit documentation**

Run:

```bash
git status --short
git diff --check
git diff --stat
```

Verify `.vscode/` and `.zcode/` remain untracked and unstaged.

```bash
git add README.md docs/phase-1/01-server-architecture.md docs/phase-1/03-toc-api.md docs/phase-1/04-frontend-integration.md tests/docs.test.ts tests/case-http-integration.test.ts
git commit -m "docs: document database-backed claim submission"
```

---

## Final Review Checklist

- [ ] Every new production function was introduced after a focused failing test.
- [ ] Claim submission is atomic on both local PostgreSQL and Neon Serverless Pool paths.
- [ ] Same-Key replay is deterministic; conflicts and concurrent Draft submissions cannot duplicate Cases.
- [ ] Database rows and logs contain no submitted plaintext sensitive data.
- [ ] `yes`/`unsure` create Pending Reportability Review; `no` creates none.
- [ ] Only referenced `verified` documents are linked.
- [ ] Communication and Outbox are committed with the Case; no email is sent inline.
- [ ] Missing Crypto configuration affects only Claim submission, not existing database-backed endpoints.
- [ ] Public OpenAPI contract is unchanged and response parsing occurs at the HTTP boundary.
- [ ] Full default and enabled database suites, typecheck, lint, format, OpenAPI, Drizzle, build, and direct Hono proof are green.
- [ ] Only task-owned files are committed; `.vscode/` and `.zcode/` remain untouched.
