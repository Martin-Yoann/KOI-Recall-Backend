# KOI Recall API — 代码改造实施规划（V1.0）

> 本文件是 `KOI_Recall_API_Code_Optimization_Plan_v1_2026-08-07.docx` 的工程落地版：把那份架构愿景拆成可执行、可验收的任务序列，并标注每一项对应的代码改动点、依赖、风险与退出条件。
>
> - **代码基线**：`main @ a53acf6`（已逐条核验文档主张与现状一致）。
> - **交付形式**：仓库内规划文档（本文）。**不包含代码实施**，不替代 CPSC / 法务 / 业务审批。
> - **待业务/合规确认项的处理**：暂按文档第 9 节的推荐默认值推进，标记为 Decision Gate；业务确认后如有变更再调整对应任务。
> - **改造原则**：每个任务先在 Contract / Policy seam 写失败测试，再改 schema / implementation；旧浅层测试在新接口测试覆盖后删除，避免双层维护。

---

## 0. 现状核验结论（已对照 main@a53acf6）

文档主张逐条属实，无需修正：

| 文档主张 | 代码证据 | 结论 |
|---|---|---|
| Product Check 固定 `shape/flavor/lotCode/dateCode` 全必填 | `src/contracts/toc.ts:117-127` 四个字段 `.min(1)` | ✅ |
| matcher 硬编码英文 message、固定四字段匹配 | `src/modules/product-checks/matcher.ts:23-81` 三个 `*_MESSAGE` 常量 | ✅ |
| Claim `claimedProductSchema` 全必填、`documentIds.min(2)`、`mailingAddress` 在 consumer 层必填 | `src/contracts/toc.ts:197-265` | ✅ |
| 商品 schema：SKU 唯一、`attributes` 为 jsonb、Remedy 有 `requiresMailingAddress` 但服务层未用 | `src/db/schema/index.ts:201-291`；`grep requiresMailingAddress` 仅命中 schema | ✅ |
| `campaign_versions` 仅有 `publishedAt`，无 `publishedBy`/审批记录 | `src/db/schema/index.ts:111-132` | ✅ |
| Outbox / Cleanup / Resend 路由返回 501 | `src/app.ts:250-256, 339-342` | ✅ |
| `allowAllRateLimiter` 为默认，key 仅 `method:path` | `src/middleware/rate-limit.ts:16-25` | ✅ |
| `/health/live` 返回 `phase: 'skeleton'` | `src/app.ts:139` | ✅ |
| `vercel.json` buildCommand 仅 `pnpm typecheck` | `vercel.json:5` | ✅ |
| Problem Type 用 `api.example.invalid` 占位 | `src/app.ts:45` 等多处 | ✅ |
| `DrizzleCaseService` ≈579 行，`CaseService.submit` 接口极小（深模块基础良好） | `wc -l`、`src/modules/cases/service.ts` | ✅ |

**绿线**：Node 24 下 `pnpm lint / typecheck / openapi:check / db:check` 通过；默认 Vitest 21 文件通过 / 6 文件跳过（157 passed / 43 skipped）。6 个跳过文件均为需 `RUN_DB_INTEGRATION=true` + 本地/Neon PostgreSQL 的集成套件。

---

## 1. 改造目标与不做清单

**目标**：在不推倒重来的前提下，把“以 Demo 固定 shape/flavor/lot/date 模型”的代码，改造为“能表达真实商品歧义、条件式 Claim、生产可运营”的版本。

**明确不在本轮实现**（文档第 10 节）：OCR / 图像相似度 / AI 欺诈评分；实时 Amazon/TikTok/ERP/WMS/Finance/Carrier 深集成；无代码 Workflow Builder；多层 RBAC / 字段级遮罩；自动 CPSC 提交 / MPR 审批中心。

---

## 2. Decision Gates（默认值已在用，确认前不进对应实现）

| Gate | 暂用默认值 | 影响的任务 |
|---|---|---|
| **D1 Variant/Identifier 粒度** | 产品 × Model = Variant；SKU/UPC/GTIN-14 为可重复 Identifier | T2.1, T2.2, T3.x |
| **D2 Phase 1 订单来源** | 受控导入 + 索引，不承诺实时 Marketplace/OMS | T3.2 |
| **D3 Evidence Profile 枚举** | `exact_order_match` / `identifier_match` / `manual_review` / `incident` | T4.1, T4.2 |
| **D4 Remedy 与地址** | Refund 不采集地址；Replacement 才要求地址 | T4.3 |
| **D5 恶意文件扫描** | 生产前明确 Provider；若启用，必须 `scanStatus=clean` 才进标准队列 | T5.5, T6.4 |
| **D6 Admin 是否属 Release 1** | 至少实现单一授权角色的查看/队列/完整导出 | T8.x |

> 业务确认若与默认值不同，仅需调整对应任务的 schema 枚举 / 契约字段，不改变任务序列与依赖。

---

## 3. 任务总览与依赖

```
Sprint 0  ── 事实与设计基线（不动代码，产出 ADR + 迁移设计 + 契约样例）
   │
   ├─→ Sprint 1  身份与识别  [T1 schema分裂, T2 Variant/Identifier, T3 Policy]
   │        │
   │        └─→ Sprint 2  条件式 Claim + 发布门禁  [T4.x]
   │                 │
   │                 ├─→ Sprint 3  生产运营闭环 + 入口防护  [T5.x, T6.x]
   │                 │        │
   │                 │        └─→ Sprint 4  运营入口 + 容量证明  [T7.x, T8.x]
   │                 │
   │                 └─→ T9  结构性拆分（O7/O8，可并行于 Sprint 3+）
   │
   └─→ 横切：每 Sprint 跑第 5 节新增验收场景
```

| ID | 主题 | 优先级 | 依赖 | 目标 Sprint |
|---|---|---|---|---|
| T1 | schema 与 contracts 按领域拆分（O8 基础） | P1 | — | S1 前半（无外部依赖，可早做） |
| T2 | Variant / Identifier 真实身份模型（O1） | P0 | D1 | S1 |
| T3 | ProductIdentificationPolicy 深模块（O2） | P0 | T2 | S1 |
| T4 | 条件式 Claim + Evidence Profile + 发布门禁（O3/O4） | P0 | T3, D3, D4 | S2 |
| T5 | 生产运营闭环：Outbox/Resend/Cleanup/scanGate（O5） | P0 | — | S3 |
| T6 | 部署与入口防护：限流/body cap/Cron 鉴权/readiness/buildGate（O6） | P0 | — | S3 |
| T7 | CI 与容量证明（O9） | P1 | — | S4 |
| T8 | 后台运营能力：单一授权 Admin（O10） | P2 | D6 | S4 |
| T9 | 深化 CaseService、错误树统一、attributes 领域类型（O7） | P1 | T4 | S3 起，并行 |

---

## 4. 任务详细设计

### Sprint 0 — 事实与设计基线（产出，不动代码）✅ 已产出

| 产出 | 文件 | 状态 |
|---|---|---|
| **ADR-0001** 身份模型 | [`docs/adr/0001-product-identity-model.md`](adr/0001-product-identity-model.md) | Proposed |
| **ADR-0002** 识别策略 seam | [`docs/adr/0002-product-identification-policy.md`](adr/0002-product-identification-policy.md) | Proposed |
| **ADR-0003** 迁移策略（M1–M4） | [`docs/adr/0003-identity-migration-strategy.md`](adr/0003-identity-migration-strategy.md) | Proposed |
| **契约样例** | [`docs/phase-1/05-contract-redesign-draft.md`](phase-1/05-contract-redesign-draft.md) | Draft |
| **ADR 索引** | [`docs/adr/README.md`](adr/README.md) | — |

**退出条件**：上述 4 份评审件获批 → ADR 状态转 `Accepted` → 进入 Sprint 1。当前均为 `Proposed`/`Draft`，待业务/工程评审。

---

### Sprint 1 — 身份与识别（O1/O2）

#### T1 — schema 与 contracts 按领域拆分（O8 基础，先做）✅ 已完成
**改动点**：
- `src/db/schema/index.ts`（706 行）→ 按聚合拆到 `src/db/schema/{campaigns,claims,documents,incidents,operations}.ts`，`index.ts` 仅 barrel export。迁移仍只由 Drizzle 生成。
- `src/contracts/toc.ts`（501 行）→ 按领域拆到 `common.ts / campaigns.ts / product-checks.ts / documents.ts / claims.ts / routes.ts`，`toc.ts` 只聚合并注册 OpenAPI。**`openapi:check` drift 检查保持不变。**
- `src/app.ts`（399 行 → 144 行）→ 只留 middleware/route registration/notFound/onError，route handler 下沉到 `src/routes/{campaigns,product-checks,documents,claims,webhooks,internal-jobs}.ts`（共享 helper 收拢到 `src/routes/shared.ts`）。

**验收**（已通过，2026-08-07）：
- `pnpm build`（typecheck + openapi:check + db:check）全绿；
- OpenAPI 产物 sha256 `5fd7e1d2…` **byte-for-byte 不变**（`sortMapEntries:true` 保证注册顺序无关）；
- `drizzle-kit generate` 检测 **0 schema changes**（拆分为纯 no-op）；
- 默认 Vitest **157 passed / 43 skipped**，与拆分前完全一致；
- 无新增公开路径。

#### T2 — Variant / Identifier 真实身份模型（O1）
**新增表**（M1：新增、保留旧列、双读）：
- `campaign_product_variants` — Model / Style / 包装版本 / 适用日期，归属 `campaign_products`。
- `campaign_product_identifiers(variant_id, identifier_type, normalized_value)` — `identifier_type ∈ {sku, unit_upc, gtin14, model, style, other}`。索引 `(identifier_type, normalized_value)`。**不设全局唯一**。
- `claimed_products` 保存 Variant / 候选结果 / 输入快照 / 识别方式与 reasonCodes。

**改动点**：`src/db/schema/campaigns.ts` 新表 + `drizzle-kit generate`；`src/db/seed.ts` 与 Importer 同时写新旧结构。

**验收（S01 数据）**：8 SKU / 7 UPC / 2 Model 可完整表达；同一 SKU 命中两 Model → `manual_review`。

#### T3 — ProductIdentificationPolicy 深模块（O2）
**目标接口**（ADR-0002）：
```ts
identify(input, campaignSnapshot) -> {
  result: 'potential_match' | 'manual_review' | 'not_matched',
  reasonCodes: string[], matchedVariantIds: string[],
  requiredEvidenceProfile: string, checkedCampaignVersion: number
}
```
- 输入三态：`order` / `product_identifiers` / `unknown`；无代码/收据 → `manual_review`（不拒绝）。
- 消费者文案改为 `messageKey`/`reasonCodes`，由已批准 Campaign Localization 渲染；Policy **不输出未经审批的安全/危险结论**。
- Product Check 与 Claim Submission **调用同一 Policy**：前者初步结果，后者基于 pinned Campaign Version 再核查。
- 新增 `src/modules/product-identification/{policy.ts, service.ts, drizzle-snapshot-reader.ts}`。matcher.ts 的硬编码 message → 稳定 reason code。

**验收**：订单/标识符/unknown 三条路径通过；多型号歧义全链路 `manual_review`、reasonCodes 可审计。

---

### Sprint 2 — 条件式 Claim + 发布门禁（O3/O4）

#### T4.1 — 字段条件化（O3）
**改动点**：`src/contracts/claims.ts`
- `claimedProductSchema`：`shape/flavor/lotCode/dateCode` 改为**可选识别信号**。
- `consumer.mailingAddress` 改为可选（契约层放行，服务层条件校验）。
- `documentIds` 改为 `0..N`。
- 新增 discriminated input：`order` / `product_identifiers` / `unknown`。

**改动点**：`DrizzleCaseService`（579 行）服务层校验：
- 无订单/收据/lot/date 但有照片/渠道/购买日期 → 允许提交进人工审核。
- 读 `Remedy.requiresMailingAddress`（schema 已有，服务层未用）后条件校验地址；Refund 免地址（D4），Replacement 缺地址 → 422。

#### T4.2 — Evidence Profile（O3）
- 新增 versioned intake/evidence profile，枚举 `exact_order_match / identifier_match / manual_review / incident`（D3）。
- 精确 DTC 订单命中 → 自动预填，Proof of Purchase 按 Profile 免除。

#### T4.3 — 发布门禁（O4）
- `campaign_versions` 新增审批/发布记录：`publishedBy / 审批记录（business, legal/compliance, cpsc_if_applicable, publishedAt）`。
- 发布动作**原子校验**：产品范围、消费者名称、hazard、immediateAction、≥1 已批准 Remedy、support、隐私/同意文本、证据规则、消息模板。
- **不通过单一环境变量选 Campaign**；门禁按 Campaign Version 生效。
- `not_matched` 响应**不得包含** `safe`/`safe to use`（matcher message 常量下线）。

**验收（DB/HTTP 集成）**：四条消费者路径（精确订单/无凭证/人工审核/Incident）+ Remedy 地址条件 + 发布门禁拒绝未审批。

---

### Sprint 3 — 生产运营闭环 + 入口防护（O5/O6）

> 与 Sprint 2 的下游并行：T5/T6 不依赖 Claim 契约变更，可并行开工；T9（结构深化）依赖 T4，S3 起接入。

#### T5 — 生产运营闭环（O5）
| 子任务 | 内容 | 改动点 |
|---|---|---|
| T5.1 | `ResendEmailAdapter` + `OutboxWorker`：批 claim/锁/重试/dead-letter，`deduplicationKey` 幂等 | `src/platform/email/resend.ts`（新增）；`src/jobs/outbox.ts`（现仅 interface，9 行）实现 |
| T5.2 | `/internal/jobs/outbox` + `/internal/jobs/cleanup-drafts` 的 `CRON_SECRET` 鉴权；缺/无效 Secret 拒绝 | `src/routes/internal-jobs.ts`（替换 `app.ts:250-256` 的 501） |
| T5.3 | Resend Webhook 去重 + Communication 状态迁移，存 `providerMessageId / delivered/bounced/failed` | `src/routes/webhooks.ts`（替换 `app.ts:339-342` 的 501） |
| T5.4 | Draft Cleanup 删过期 DB 记录 + Private Blob 实体；删失败保留 `deletion_pending` 并重试 | 同 internal-jobs 路由 |
| T5.5 | 恶意文件扫描门禁（D5）：上线要求扫描时，Claim 只能关联 `scanStatus=clean`；当前 `verified` ≠ safe | `DrizzleDocumentService` + schema |

**验收**：确认邮件可观测送达、失败可重试、Outbox/Webhook 重放不重复发送；scanStatus 非 clean 不静默关联。

#### T6 — 部署与入口防护（O6）
| 子任务 | 内容 | 改动点 |
|---|---|---|
| T6.1 | 替换 `allowAllRateLimiter`：key 含不可逆客户端来源 + 路由类别 + Campaign；不同端点不同配额 | `src/middleware/rate-limit.ts:16-25` |
| T6.2 | `api/index.ts` 严格请求体上限（JSON + Webhook）；附件仍走 Private Blob 直传 | `src/index.ts` |
| T6.3 | 新增 `/health/ready`（配置 + DB 连通性）；`/health/live` 去掉 `phase:skeleton` | `src/app.ts:136-140` |
| T6.4 | `vercel.json` buildCommand `pnpm typecheck` → `pnpm build`；测试在 CI 独立 | `vercel.json:5` |
| T6.5 | `api.example.invalid` Problem Type + OpenAPI production server → 配置控制的稳定域名 | `src/app.ts` 多处 + openapi config |

---

### Sprint 4 — 运营入口 + 容量证明（O9/O10）

#### T7 — CI 与容量证明（O9）
- **CI Gate 序列**：`format:check → lint → typecheck → openapi:check → db:check → 默认 Vitest → PostgreSQL Gate → Neon Smoke(受保护环境) → 容量 Gate`。
- PostgreSQL Gate：CI 起临时 PostgreSQL，`RUN_DB_INTEGRATION=true`，**禁止默认跳过**现 6 个集成套件。
- 容量 Gate：导入 ~130 万条脱敏/合成订单索引，记录导入耗时 / P95 / P99 / 索引大小 / 并发退化。

#### T8 — 后台运营能力（O10，D6）
- 单一授权角色边界内：Case 查看、队列（标准/人工/事故）、完整导出、报告义务关闭门禁。

#### T9 — 深化与收拢（O7，S3 起并行）
- `CaseService.submit` 保持小接口；把纯策略、共享快照读取、私有持久化步骤收拢到内部模块（**不为每步建公开 Port**）。
- PostgreSQL 错误树遍历统一放 `src/shared/errors.ts`（现 Case 与通用错误各一份类似逻辑）。
- 产品 `attributes` 建 Zod/TS 领域类型，逐步减少 `Record<string, unknown>`。

---

## 5. 新增关键验收场景（每 Sprint 回归）

- [ ] 同一 SKU/UPC 命中两 Model → `manual_review`，reasonCodes 可审计。
- [ ] 无订单/收据/lot/date 但有照片/渠道/购买日期 → 允许提交进人工审核。
- [ ] 精确 DTC 订单命中 → 自动预填，Proof of Purchase 按 Profile 免除。
- [ ] Refund → 地址可省；Replacement 缺地址 → 422。
- [ ] Incident=No → 不创建 Incident；Yes/Unsure → 创建 pending Reportability Review。
- [ ] `not_matched` 响应不含 `safe`/`safe to use`。
- [ ] 未满足发布审批清单的 Campaign Version 不能成为 `publishedVersionId`。
- [ ] Outbox 重试 + Resend Webhook 重放不重复发送/更新。
- [ ] `scanStatus` 非 clean 时按发布策略拒绝或转人工，不静默关联。

---

## 6. 完成定义（Definition of Done）

- 所有 P0 契约 / schema / OpenAPI / 前端 generated types / 文档同步更新。
- 默认 + DB 集成测试均通过；CI 不再静默跳过本地 PostgreSQL 集成套件。
- 消费者在缺订单/收据/包装代码时仍可提交并进入可解释人工审核队列。
- 同一 SKU/UPC 多型号歧义不会被自动判 `eligible` 或 `safe`。
- 退款/换货、证据、地址、公开文案由已批准 Campaign Version 配置，不由代码写死。
- Case 创建、证据关联、Incident、Outbox、幂等继续保持单事务与并发安全。
- 确认邮件/Webhook/Cleanup/限流/readiness/失败重试在 staging 端到端验证通过。
- ~130 万记录导入与查询基准达业务确认 P95/P99 目标并留存报告。

---

## 7. 风险与回滚

| 风险 | 缓解 |
|---|---|
| Variant/Identifier 迁移期双写复杂 | M1 仅新增表保留旧列双读；M4 回填完成才加约束删列，迁移可回滚 |
| v1 契约不兼容变更冲击前端 | 预生产环境直接更新 v1（尚无稳定外部消费者）；重新生成 `src/generated/toc-v1.d.ts`；若已确认第三方依赖则先确认调用方 |
| 限流 key 设计不当误伤 | key 含不可逆客户端来源；不同端点独立配额；上线前在 staging 压测 |
| Outbox/Resend 集成 secret 缺失 | 标为 Sprint 3 依赖“供应商 Secret/环境”；缺失时优雅降级而非 500 |
| 业务确认推翻默认值 | Decision Gate 标注影响任务；默认值仅作占位，确认后局部调整 |

---

**资料来源**：`KOI_Recall_API_Code_Optimization_Plan_v1_2026-08-07.docx`；`koi-recall-api main@a53acf6`（2026-08-07 逐条核验）。
