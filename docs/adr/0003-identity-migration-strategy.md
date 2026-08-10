# ADR-0003：身份模型与条件式 Claim 的迁移策略

- **状态**：Accepted（2026-08-07 评审通过，进入 Sprint 1 实施）
- **日期**：2026-08-07（2026-08-07 依优化方案 V1.1 订单佐证补充修订）
- **决策者**：技术
- **关联**：优化规划 `docs/optimization-plan-v1.md`（§6 数据与 API 迁移方案）；ADR-0001、ADR-0002
- **替代方案**：见 §6

---

## 1. 背景（Context）

ADR-0001 引入 `campaign_product_variants` / `campaign_product_identifiers` 新表，并扩展 `claimed_products`；ADR-0002 把契约从 `shape/flavor/lot/date` 四字段切到 reason code + 三态输入。这些变更同时触碰 schema、契约与服务层，若一次性切换，存在以下风险：

- **生产数据中断**：`claimed_products` 现有 `shape/flavor/lotCode/dateCode` 均为 `NOT NULL`（`src/db/schema/index.ts:408-435`），直接删列会让历史 Case 不可读。
- **契约不兼容**：`productCheckRequestSchema` / `claimedProductSchema` 是公开 `/v1` 契约（`src/contracts/toc.ts:117-127, 197-265`），改动会破坏前端 generated types。
- **回滚困难**：若新识别策略上线后发现缺陷，没有双读过渡就回不去旧逻辑。

`openapi:check` 是仓库既有门禁，契约任何变更都需同步重生成，否则 CI 红。

---

## 2. 决策（Decision）

采用**四阶段在线迁移**，每个阶段都可独立部署、可回滚，且始终满足“线上可读、可写”：

```
M1 新增（加表/加列，保留旧约束）  →  M2 契约切 reasonCodes
   →  M3 服务层条件化（旧字段变可选）  →  M4 回填后删旧列/加约束
```

### 2.1 阶段 M1 — 新增结构（双读起点）

**数据库变更**：
- 新增 `campaign_product_variants`、`campaign_product_identifiers`（见 ADR-0001 §2.1–2.2）。
- `claimed_products` **新增** nullable 列：`matched_variant_ids uuid[]`、`identification_mode`、`reason_codes text[]`、`input_snapshot jsonb`。
- **保留**旧 `shape/flavor/lotCode/dateCode` NOT NULL 与 `campaign_products.attributes`。
- `campaign_versions` **新增**审批/发布记录列（publishedBy、approval jsonb），nullable。

**兼容策略**：新增表/列、保留旧约束 → **零破坏**。旧读旧写仍工作；Seed/Importer 升级为**同时写新旧结构**（双写）。

**退出条件**：新表存在；Importer 双写；S01 数据集（8 SKU / 7 UPC / 2 Model）在新结构里可完整表达。

### 2.2 阶段 M2 — 契约切 reasonCodes（Product Check 优先）

**契约变更**（`src/contracts/`）：
- `productCheckRequestSchema` 改为 **discriminated input**：`order` / `product_identifiers` / `unknown` 三态。
- `productCheckResponseSchema`：`message` → `messageKey` + `reasonCodes: string[]`，新增 `matchedVariantIds`。
- Claim 契约此阶段**暂不动**，避免一次切两端。

**兼容策略**：预生产环境直接更新 v1（尚无稳定外部消费者）；运行 `pnpm openapi:generate` + `pnpm types:frontend` 重生成。`openapi:check` 必须绿。

**退出条件**：product_identifiers / purchase_evidence / unknown 三条 Product Check 路径通过 HTTP 测试；reasonCodes 可审计。

### 2.3 阶段 M3 — 服务层条件化（Claim 跟进）

**契约 + 服务变更**：
- `claimedProductSchema`：`shape/flavor/lotCode/dateCode` 改为 `.optional()`；`consumer.mailingAddress` 改为可选；`documentIds` 改为 `0..N`；新增 discriminated input；订单字段归入 purchase evidence（默认选填、加密保存、HMAC 重复检测）。
- `DrizzleCaseService` 服务层条件校验：
  - 读 `Remedy.requiresMailingAddress`（schema 已有，`index.ts:253`，服务层当前未用）→ Refund 免地址，Replacement 缺地址返回 422。
  - 无 lot/date 但有照片/渠道/购买日期 → 允许提交进 `manual_review`。
  - Evidence Profile 生效（exact_order_match / order_evidence / identifier_match / manual_review / incident）。
  - `purchaseCorroboration`、`riskFlags` 生效；当前收货地址与原订单地址**分离**（原订单地址仅作佐证，绝不自动覆盖补发地址）。
- DB 层：`claimed_products` 的 `shape/flavor/lotCode/dateCode` 由 `NOT NULL` 改为 nullable。

**兼容策略**：服务层**短暂同时接受**旧 flat 字段一个周期（过渡容错），但新提交优先走新路径。

**退出条件**：五条消费者路径（精确订单 / 订单佐证 / 无凭证 / 补充资料 / Incident）+ Remedy 地址条件 + 原订单地址不复用补发，通过 DB + HTTP 集成测试；订单敏感字段的加密、HMAC 查询、日志脱敏和授权查看均有集成测试。

### 2.4 阶段 M4 — 收尾（删旧列 / 加约束）

**前置**：确认 M3 全量上线、历史数据回填完毕（旧 `attributes.shapes/flavors` 与旧 lot 列已映射到新 Variant/Identifier）。

**变更**：
- 移除 `DrizzleCaseService` 与 matcher 中所有旧字段读取。
- 删除 `claimed_products` 的 `shape/flavor/lotCode/dateCode` 列。
- 视需要给 `campaign_product_identifiers` 加业务层校验（**仍不加全局唯一**，见 ADR-0001）。
- 删除 Seed/Importer 的双写分支，只写新结构。

**兼容策略**：完成回填后再删列 → 列存在期间迁移可回滚。

**退出条件**：无旧字段读取；`grep shape/flavor/lotCode/dateCode` 在 contracts 与 cases 模块无命中；迁移文件可正向与回滚。

---

## 3. 动机（Rationale）

1. **每个阶段独立可部署**：M1 纯加法、M2/M3 各切一端、M4 才删——任一阶段出问题都能停在稳态，不需要一次性大爆炸。
2. **双读/双写过渡**：M1 的双写保证新结构有数据可验证；M3 的旧字段容错保证未升级的调用方短暂仍可用。
3. **契约门禁不破**：每阶段都跑 `openapi:check`，drift 检查贯穿全程，符合仓库既有约定。
4. **回填先行再删列**：避免“删了列才发现历史 Case 读不出”的经典坑。

---

## 4. 后果（Consequences）

### 正面
- 迁移期内生产始终可读可写，无停机窗口。
- 每阶段对应优化规划的一个 Sprint，节奏可追踪。
- M4 后代码与契约彻底脱离 Demo 四字段模型。

### 负面 / 代价
- **双写/双读带来短期代码复杂度**：Importer 与 Seed 在 M1–M3 期间维护两套写入路径。
- **过渡字段容错**：M3 服务层短暂接受旧 flat 字段，需要明确的弃用时间表，否则容错代码会长期残留。
- **回填脚本是一次性运维成本**：M4 前需编写并验证回填脚本。

### 规约
- **M4 删列前必须确认回填完成**——以回填校验报告为前置门禁，不可凭判断跳过。
- 每个阶段的迁移由 `drizzle-kit generate` 生成，**禁止手写 SQL 迁移**绕过工具。
- M2/M3 的契约变更必须同步重生成 `src/generated/toc-v1.d.ts` 并提交。

---

## 5. 验证（Verification）

| 阶段 | 关键验证 |
|---|---|
| M1 | 新表 DDL 通过 `pnpm db:check`；Importer 双写后新旧读一致；S01 数据集在新结构可表达 |
| M2 | `pnpm openapi:check` 绿；Product Check 三态路径 HTTP 测试通过；`reasonCodes` 字段存在 |
| M3 | `RUN_DB_INTEGRATION=true` 下四条消费者路径集成测试通过；Remedy 地址条件校验生效 |
| M4 | `grep` 确认旧字段无残留；回填校验报告归档；迁移正向应用与回滚均可在干净库上执行 |

每阶段都跑优化规划 §5 的回归验收场景（尤其“同一 SKU/UPC 多型号 → manual_review”）。

---

## 6. 替代方案（Alternatives Considered）

| 方案 | 否决理由 |
|---|---|
| **A. 一次性大爆炸（big-bang）** | schema + 契约 + 服务层同时切，回滚几乎不可能；生产数据中断风险高 |
| **B. 创建 v2 API，v1 冻结** | 当前尚无稳定外部消费者，过早引入 v2 仅为兼容虚构 Demo，徒增维护面（优化规划 §6 明示） |
| **C. 只加新表，永不删旧列** | 长期双轨，代码与契约永远背 Demo 模型包袱，违反“不写死”的完成定义 |
| **D. 先删列再加新结构** | 历史_case 立刻不可读，直接破坏数据可审计性 |

> 若已确认存在第三方依赖现有 OpenAPI，则 **B（v2）转为必选**——届时先确认调用方，再按 v2 路径单独评估。当前默认值下选四阶段在线迁移。

---

## 7. 关联与后续

- **驱动**：`docs/optimization-plan-v1.md` §4（T2/T3/T4）+ §6（迁移方案表）。
- **依赖**：ADR-0001（新表结构）、ADR-0002（reason code 契约，M2 切换目标）。
- **Decision Gate**：D1（粒度）影响 M1 新表字段；D3（Evidence Profile，V1.1 含 `order_evidence`）影响 M3 服务层校验；D4（Remedy/地址）影响 M3 地址条件；D7（订单佐证字段默认性）与 D8（退款金额与补发地址）影响 M3 订单佐证与地址分离。默认值下按本 ADR 推进，确认后局部调整对应阶段。
