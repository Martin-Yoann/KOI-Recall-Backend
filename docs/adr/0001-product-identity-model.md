# ADR-0001：真实商品身份模型（Product Identity Model）

- **状态**：Accepted（2026-08-07 评审通过，进入 Sprint 1 实施）
- **日期**：2026-08-07（2026-08-07 依优化方案 V1.1 同步 `identification_mode` 枚举命名）
- **决策者**：技术 + 业务商品数据
- **关联**：优化规划 `docs/optimization-plan-v1.md`（O1 / T2，Decision Gate D1）
- **替代方案**：见 §6

---

## 1. 背景（Context）

### 1.1 现状

`campaign_products` 以 `(campaign_version_id, sku)` 唯一，商品身份主要依赖 `attributes` 中的 `shapes`/`flavors`，并要求每条 Lot 行必须存在 `lot_code` + `date_code`（`src/db/schema/index.ts:201-242`）。`claimed_products` 把消费者输入的 `shape/flavor/lotCode/dateCode` 全部存为 `NOT NULL` 列（`src/db/schema/index.ts:408-435`）。

Seed 数据只有单一 SKU `MUSIC-LOLLIPOP-DEMO-18G`，写死 `flavors: ['Peach','Strawberry']` / `shapes: ['Bear','Dinosaur','Strawberry','Heart']`（`src/db/seed.ts:88-94`）。

### 1.2 业务事实使假设失效

业务反馈（`KOI_C端召回技术团队第一轮答复_2026-08-06.docx`）确认：

- **同一 SKU / UPC 可对应多个物理型号**（例：JSM-18A 与 JSM-18D 共享同一 SKU/UPC，但口径/配方不同）。
- 真实产品**经常缺少已确认的 Lot/Date 格式**；大量消费者没有包装代码。
- UPC / GTIN-14 / Model / Style 都是合法识别信号，而非“shape/flavor”二选一。

当前模型无法自然表达“同一 SKU/UPC 命中两个 Model”这一真实歧义——matcher 只能在 `shape × flavor × lot × date` 四元组上做精确比对（`src/modules/product-checks/matcher.ts:42-70`），既无法多值匹配标识符，也无法在多候选时进入 `manual_review`。

---

## 2. 决策（Decision）

将消费者可见产品、物理 Variant 与 Identifier **分层建模**：

```
campaign_products          消费者可见产品 / 款式
   └─ campaign_product_variants      Model / Style / 包装版本 / 适用日期
         └─ campaign_product_identifiers   sku | unit_upc | gtin14 | model | style | other
```

**Identifier 允许跨 Variant 重复；查询命中多个候选时不做武断选择，而是产生 `manual_review`。**

### 2.1 `campaign_product_variants`

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | uuid PK | |
| `campaign_product_id` | uuid FK→`campaign_products`（cascade） | 归属产品 |
| `model` | varchar(120) | 物理型号，如 `JSM-18A` |
| `style` | varchar(120), nullable | 风格/包装版本 |
| `applicable_from` / `applicable_to` | date, nullable | 适用日期区间 |
| `attributes` | jsonb | 仅放可扩展属性，不承载核心标识 |

- 唯一索引：`(campaign_product_id, model)`——同一产品内 Model 不重复。
- 索引：`(campaign_product_id)`。

### 2.2 `campaign_product_identifiers`

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | uuid PK | |
| `variant_id` | uuid FK→`campaign_product_variants`（cascade） | 归属 Variant |
| `identifier_type` | enum `{sku, unit_upc, gtin14, model, style, other}` | |
| `raw_value` | varchar(160) | 原始输入，保留大小写/格式 |
| `normalized_value` | varchar(160) | 归一化后值（大写、去分隔符等） |

- **不设全局唯一约束**——歧义本身是业务事实（D1）。
- 唯一索引：`(variant_id, identifier_type, normalized_value)`——同一 Variant 不重复录入同一标识符。
- 查询索引：`(identifier_type, normalized_value)`——识别查询主路径。

### 2.3 `claimed_products` 扩展

新增（保留现有列，见 ADR-0003 双读策略）：

| 字段 | 类型 | 说明 |
|---|---|---|
| `matched_variant_ids` | uuid[] | 命中的候选 Variant（多值即歧义） |
| `identification_mode` | enum `{product_identifiers, purchase_evidence, unknown}` | 消费者走哪条识别路径（V1.1：购买佐证单独成 `purchase_evidence`，不混入识别） |
| `reason_codes` | text[] | 来自 Policy 的可审计原因码 |
| `input_snapshot` | jsonb | 消费者原始输入快照（避免只留最终结论） |

现有 `shape/flavor/lotCode/dateCode` 列在 M3 后改为 nullable，M4 回填后删除。

---

## 3. 动机（Rationale）

1. **表达真实歧义**：Identifier 可重复 + 多候选转人工，是对“JSM-18A/D 共享 UPC”这一事实的忠实建模，而非用唯一约束掩盖。
2. **可审计**：`claimed_products` 保留 `matched_variant_ids`（多值）、`identification_mode`、`reason_codes` 与输入快照，使每一笔 Claim 的识别过程可追溯，而非只存一个布尔 `check_result`。
3. **契约自由**：Variant/Identifier 分离后，消费者输入可走 product_identifiers / purchase_evidence / unknown 三态，不再被 `shape/flavor/lot/date` 四元组锁死。
4. **不破坏 Campaign Version 所有权**：所有新表仍挂在 `campaign_version_id` 之下，使某次发布使用的身份数据不被后续发布悄悄替换。

---

## 4. 后果（Consequences）

### 正面
- Product Check 与 Claim Submission 可复用同一识别策略（ADR-0002），输出一致的 reason code。
- 新增 Identifier 类型（如未来 batch code）只需扩 enum，不改表结构。
- 消费者在无包装代码场景下也能提交并进入可解释的人工审核队列。

### 负面 / 代价
- **写入复杂度上升**：Importer/Seed 必须同时写 product → variant → identifier 三层。Seed 的 `attributes:{shapes,flavors}` demo 形态需迁移。
- **查询歧义处理**：必须在 Policy 层（ADR-0002）规定“多候选 → manual_review”，不能在 SQL 层随意 `LIMIT 1`。
- **迁移期双读**：M1 阶段旧 `lot/shape/flavor` 列保留，新旧结构并存（ADR-0003）。

### 规约
- Identifier 值**禁止设置全局唯一约束**（违反则丢失歧义信息）。
- 任何读取标识符的代码必须用 `normalized_value` 比对，`raw_value` 仅作展示。
- 索引建在 `(identifier_type, normalized_value)` 上。

---

## 5. 验证（Verification）

以 S01 真实数据集验收：

- **8 SKU / 7 UPC / 2 Model** 可完整表达（含同一 SKU 命中两 Model 的用例）。
- 同一 UPC 查询返回 2 个 Variant → Policy 输出 `result: manual_review`，`matchedVariantIds.length === 2`，`reasonCodes` 非空。
- Importer 写入后，新旧结构均可读（双读阶段）。
- 单元测试覆盖：单命中 / 多命中歧义 / 无命中三种 `normalized_value` 查询路径。

---

## 6. 替代方案（Alternatives Considered）

| 方案 | 否决理由 |
|---|---|
| **A. 继续用 `attributes` jsonb 存 UPC/Model** | 无法建类型化索引；多值歧义无法高效查询；违反“JSONB 不承载需约束/查询的核心字段”约定（`docs/phase-1/02-database-design.md` §1） |
| **B. Identifier 设全局唯一约束** | 直接丢失“同一 UPC 对应多 Model”的业务事实，与项目核心目标冲突 |
| **C. 为每个 identifier_type 建独立列（sku、upc、gtin…）** | 列爆炸；新增类型要改 schema；且无法表达“一个 Variant 有多个 UPC”的多值语义 |
| **D. 用单表 `product_aliases` 平铺** | 丢失 Variant 这一层物理型号维度，无法回答“这个 UPC 是哪个 Model” |

---

## 7. 关联与后续

- **驱动**：`docs/optimization-plan-v1.md` §4 T2（O1）。
- **被引用**：ADR-0002（识别策略在 Variant/Identifier 模型上运行）、ADR-0003（迁移分四阶段）。
- **Decision Gate**：D1（Variant/Identifier 粒度）——本 ADR 采用其推荐默认值；业务确认后若需调整 enum 或粒度，仅影响本文件 §2.1–2.2 的字段定义，不影响分层决策本身。
