# KOI Recall 契约重设计草案（Sprint 0 评审件）

> **状态**：Draft — 供 Sprint 0 评审。落地由 ADR-0002/0003 驱动，本文给出 ADR 所述目标契约的**精确 Zod 样例**，标注每一处相对当前 `src/contracts/toc.ts` 的 before/after 差异。
>
> - **不是实现**：本文不替换 `toc.ts`，仅为评审接口形态。Sprint 1 落地时（T1 拆分 + M2 切换）以此为蓝本。
> - **代码基线**：`src/contracts/toc.ts`（501 行，502 行 route 配置）。
> - **复用约定**：本文沿用现有 helpers（`uuid`、`isoDate`、`isoDateTime`、`problemDetailsSchema`、`commonProblemResponses`、`addressSchema`、`incidentDetailsSchema`、`idempotencyHeaderSchema`）——拆分到 `src/contracts/{common,campaigns,product-checks,documents,claims}.ts` 后，这些 helpers 放 `common.ts`（见 T1）。

---

## 1. 设计目标回顾

| 目标 | 当前缺陷 | 本草案对策 |
|---|---|---|
| 三态识别输入 | `productCheckRequestSchema` 锁死 `shape/flavor/lotCode/dateCode` 全必填（`toc.ts:117-124`） | discriminated union：`order` / `product_identifiers` / `unknown` |
| 消除硬编码文案 | matcher 三常量 + 响应 `message: z.string()`（`toc.ts:129`） | `messageKey` + `reasonCodes: string[]`，文案交 Localization |
| 条件式 Claim | `claimedProductSchema` 四字段全必填、`documentIds.min(2)`、`mailingAddress` 必填（`toc.ts:197-265`） | 字段全可选；服务层按 Evidence Profile + Remedy 校验 |
| 安全措辞门禁 | `not_matched` 文案可能被误读为安全 | 契约层不出现 `safe`；messageKey 受控枚举 |
| 可审计 | 响应只回布尔 `result` | 返回 `matchedVariantIds` + `reasonCodes` + `identificationMode` |

**约束（来自 ADR-0002 §2.1，写入契约层）**：
- `matchedVariantIds.length > 1` 时 `result` 必须 `manual_review`（由 Policy 保证，契约 `superRefine` 二次校验）。
- 响应**不含** `message`、不含任何 `safe` 字样。

---

## 2. Product Check 契约（M2 阶段首切）

### 2.1 请求：discriminated input

```ts
// common.ts 复用：uuid
const productIdentifierSchema = z
  .object({
    type: z.enum(['unit_upc', 'gtin14', 'model', 'style', 'lot_code', 'date_code']),
    value: z.string().trim().min(1).max(160),
  })
  .openapi('ProductIdentifier');

const productCheckOrderInput = z
  .object({
    mode: z.literal('order'),
    orderNumber: z.string().trim().min(1).max(120),
    purchaseChannel: z.enum(['amazon', 'tiktok', 'koi', 'retailer', 'gift', 'other']),
    purchaseDate: isoDate.optional(),
  })
  .openapi('ProductCheckOrderInput');

const productCheckIdentifiersInput = z
  .object({
    mode: z.literal('product_identifiers'),
    identifiers: z.array(productIdentifierSchema).min(1).max(20),
    purchaseChannel: z.enum(['amazon', 'tiktok', 'koi', 'retailer', 'gift', 'other']).optional(),
    purchaseDate: isoDate.optional(),
  })
  .openapi('ProductCheckIdentifiersInput');

const productCheckUnknownInput = z
  .object({
    mode: z.literal('unknown'),
    // 消费者只有照片/渠道/购买日期，无任何代码
    purchaseChannel: z.enum(['amazon', 'tiktok', 'koi', 'retailer', 'gift', 'other']).optional(),
    purchaseDate: isoDate.optional(),
    note: z.string().trim().max(500).optional(),
  })
  .openapi('ProductCheckUnknownInput');

export const productCheckRequestSchema = z
  .discriminatedUnion('mode', [
    productCheckOrderInput,
    productCheckIdentifiersInput,
    productCheckUnknownInput,
  ])
  .openapi('ProductCheckRequest');
```

**Before**（`toc.ts:117-124`）：
```ts
z.object({
  shape: z.string().min(1).max(80),
  flavor: z.string().min(1).max(80),
  lotCode: z.string().min(1).max(80),
  dateCode: z.string().min(1).max(40),
})
```

**差异**：四字段平铺 → 三态 discriminated union；旧字段全部下沉为 `product_identifiers` 模式下的可选 identifier 条目。

### 2.2 响应：reasonCodes + matchedVariantIds

```ts
export const productCheckResponseSchema = z
  .object({
    result: z.enum(['potential_match', 'not_matched', 'manual_review']),
    reasonCodes: z.array(z.string().min(1).max(80)),
    matchedVariantIds: z.array(uuid),
    identificationMode: z.enum(['order', 'product_identifiers', 'unknown']),
    messageKey: z.enum([
      'product_check.potential_match',
      'product_check.manual_review.ambiguous',
      'product_check.manual_review.insufficient_signals',
      'product_check.not_matched',
    ]),
    checkedCampaignVersion: z.number().int().positive(),
    disclaimer: z.literal('This check is preliminary and is not a final eligibility decision.'),
  })
  .superRefine((value, ctx) => {
    // ADR-0002 §2.1 约束：多候选必须 manual_review
    if (value.matchedVariantIds.length > 1 && value.result !== 'manual_review') {
      ctx.addIssue({
        code: 'custom',
        path: ['result'],
        message: 'result must be manual_review when matchedVariantIds.length > 1.',
      });
    }
    if (value.result !== 'potential_match' && value.matchedVariantIds.length === 1) {
      ctx.addIssue({
        code: 'custom',
        path: ['matchedVariantIds'],
        message: 'single matched variant must yield potential_match.',
      });
    }
  })
  .openapi('ProductCheckResponse');
```

**Before**（`toc.ts:126-133`）：`{ result, message, checkedCampaignVersion, disclaimer }`。

**差异**：
- `message: string` → `messageKey: enum`（受控，禁止自由文案）。
- 新增 `reasonCodes` / `matchedVariantIds` / `identificationMode`。
- `superRefine` 把 ADR-0002 的“多候选即 manual_review”写成契约级硬约束。

**reason code 与 messageKey 映射**（ADR-0002 §2.4）：

| reasonCode | messageKey | result |
|---|---|---|
| `order.exact_match` | `product_check.potential_match` | potential_match |
| `identifier.single_match` | `product_check.potential_match` | potential_match |
| `identifier.ambiguous_multi_match` | `product_check.manual_review.ambiguous` | manual_review |
| `input.insufficient_signals` | `product_check.manual_review.insufficient_signals` | manual_review |
| `identifier.no_match` | `product_check.not_matched` | not_matched |

---

## 3. Claim 契约（M3 阶段跟进）

### 3.1 `claimedProductSchema`：字段全可选 + 三态

```ts
const claimedProductSchema = z
  .object({
    campaignProductId: uuid,
    quantity: z.number().int().min(1).max(100),
    // 旧四字段全部改为可选识别信号
    shape: z.string().max(80).optional(),
    flavor: z.string().max(80).optional(),
    lotCode: z.string().max(80).optional(),
    dateCode: z.string().max(40).optional(),
    // 新增：与 Product Check 同构的标识符条目（与 ADR-0001 Identifier 对齐）
    identifiers: z.array(productIdentifierSchema).max(20).optional(),
    purchaseChannel: z.enum(['amazon', 'tiktok', 'koi', 'retailer', 'gift', 'other']),
    purchaseDate: isoDate.optional(),
    orderNumber: z.string().max(120).optional(),
    identificationMode: z.enum(['order', 'product_identifiers', 'unknown']),
  })
  .openapi('ClaimedProductInput');
```

**Before**（`toc.ts:197-209`）：四字段 `.min(1)` 必填，无 `identifiers`、无 `identificationMode`。

**差异**：四字段 `.optional()`；新增 `identifiers` 数组与 `identificationMode`。服务层据此决定走哪条 Evidence Profile。

### 3.2 `claimSubmissionRequestSchema`：地址可选 + 证据 0..N

```ts
export const claimSubmissionRequestSchema = z
  .object({
    draftId: uuid,
    draftToken: z.string().min(32),
    locale: z.literal('en-US'),
    consumer: z.object({
      firstName: z.string().trim().min(1).max(100),
      lastName: z.string().trim().min(1).max(100),
      email: z.string().email().max(254),
      phone: z.string().max(40).optional(),
      mailingAddress: addressSchema.optional(),   // 契约放行，服务层按 Remedy 校验
    }),
    products: z.array(claimedProductSchema).min(1).max(20),
    remedyCode: z.string().min(1).max(60),
    documentIds: z.array(uuid).max(20),            // min(2) → max(20)，0 即允许
    consents: z
      .array(
        z.object({
          type: z.enum(['privacy_notice', 'information_accuracy']),
          textVersion: z.string().min(1).max(80),
          accepted: z.literal(true),
        }),
      )
      .min(2),
    incidentAnswer: z.enum(['no', 'yes', 'unsure']),
    incidentDetails: incidentDetailsSchema.optional(),
  })
  // 现有 incidentAnswer ↔ incidentDetails 的 superRefine 逻辑保持不变（见 toc.ts:267-320）
  .superRefine(/* incidentAnswer 校验不变 */)
  .openapi('ClaimSubmissionRequest');
```

**Before**：`mailingAddress: addressSchema`（必填）、`documentIds: z.array(uuid).min(2).max(20)`。

**差异**：
- `mailingAddress` → `.optional()`：契约层放行，**校验下沉到服务层**（读 `Remedy.requiresMailingAddress`；Refund 免地址，Replacement 缺地址 → 422）。
- `documentIds` 下限 `min(2)` → 去掉：证据数量由 Evidence Profile 决定（精确订单命中可免除 Proof of Purchase）。
- `incidentAnswer` 的 `superRefine` 逻辑**完全保留**（`toc.ts:267-320` 方向正确，见规划 §4.3 O3 表）。

### 3.3 服务层条件校验（不在契约，列此供对齐）

下列校验**不进 Zod**（依赖 DB 读取 Remedy/Evidence Profile），在 `DrizzleCaseService` 内完成：

- `Remedy.requiresMailingAddress === true` 且 `consumer.mailingAddress` 缺失 → 422。
- Evidence Profile `exact_order_match` 且 `documentIds` 未含 proof_of_purchase → 允许（Profile 免除）。
- Evidence Profile `manual_review` 且无任何 documentId 但有 incidentDetails → 允许进人工队列。

---

## 4. Campaign 响应：products 形态升级（M1 配套）

`publicProductSchema`（`toc.ts:72-88`）当前暴露 `flavors`/`shapes`/`affectedLots`。M1 新表落地后，公开响应应暴露 Variant 与 Identifier，使前端能引导三态输入：

```ts
const publicVariantSchema = z
  .object({
    variantId: uuid,
    model: z.string(),
    style: z.string().optional(),
    identifiers: z.array(
      z.object({
        type: z.enum(['sku', 'unit_upc', 'gtin14', 'model', 'style']),
        value: z.string(),   // 展示用 raw_value；不做唯一性暗示
      }),
    ),
  })
  .openapi('PublicCampaignVariant');

const publicProductSchema = z
  .object({
    productId: uuid,
    sku: z.string(),
    brand: z.string(),
    name: z.string(),
    variants: z.array(publicVariantSchema),
  })
  .openapi('PublicCampaignProduct');
```

**Before**（`toc.ts:72-88`）：`flavors/shapes/affectedLots[{lotCode,dateCode,attributes}]`。

**差异**：扁平 `flavors/shapes` 与 `affectedLots` → 结构化 `variants[].identifiers[]`。消费者前端据此渲染“输入 UPC / 选 Model / 或无代码”三态 UI。

> 注：过渡期（M1–M3）Mapper 可同时产出旧 `flavors/shapes` 与新 `variants`，前端切完后于 M4 删旧字段。

---

## 5. OpenAPI / generated types 同步

每次契约改动必须依次执行（仓库既有门禁）：

```bash
pnpm openapi:generate     # 重生成 openapi/toc-v1.openapi.yaml
pnpm openapi:check        # drift 检查必须绿
pnpm types:frontend       # 重生成 src/generated/toc-v1.d.ts，并提交
```

- Product Check 路由（`productCheckRoute`，`toc.ts:365-384`）的 `responses[200]` schema 指向新的 `productCheckResponseSchema`，无需改 route 结构。
- Problem Type 的 `api.example.invalid` 占位**不在本草案处理**——属 O6/T6.5（配置控制域名），与契约结构无关。

---

## 6. 评审检查清单

落地前请确认：

- [ ] 三态 discriminated union 是否覆盖所有真实消费者场景？是否需要第四态（如 `gift` 无收据但有赠品包装）？
- [ ] `messageKey` enum 的 4 个 key 是否足够？Localization 团队是否能提供对应文案？
- [ ] `claimedProductSchema.identifiers` 与 Product Check 的 `productIdentifierSchema` 共用同一 schema——是否接受这种跨端点复用？
- [ ] `documentIds` 取消 `min(2)` 后，前端引导是否需要补“建议上传凭证”的软提示？
- [ ] `publicProductSchema` 暴露 `identifiers`（含 UPC/GTIN）是否涉及敏感信息泄露评估？（UPC 本身公开，但需确认。）

---

## 7. 与 ADR / 规划的映射

| 本草案节 | 驱动 ADR | 规划任务 | 迁移阶段 |
|---|---|---|---|
| §2 Product Check | ADR-0002 | T3 | M2 |
| §3 Claim | ADR-0002, ADR-0003 | T4.1, T4.2 | M3 |
| §4 Campaign products | ADR-0001 | T2 | M1 配套 |
| §5 OpenAPI 同步 | ADR-0003 §2.2/2.3 | T1 | M2/M3 |

---

**资料来源**：`src/contracts/toc.ts`（main@a53acf6）；ADR-0001/0002/0003；`docs/optimization-plan-v1.md`。
