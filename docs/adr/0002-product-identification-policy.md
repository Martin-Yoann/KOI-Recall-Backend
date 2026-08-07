# ADR-0002：统一商品识别策略 seam（ProductIdentificationPolicy）

- **状态**：Accepted（2026-08-07 评审通过，进入 Sprint 1 实施）
- **日期**：2026-08-07
- **决策者**：技术
- **关联**：优化规划 `docs/optimization-plan-v1.md`（O2 / T3）；ADR-0001（身份模型）
- **替代方案**：见 §6

---

## 1. 背景（Context）

### 1.1 现状

商品识别逻辑分散在两处，且彼此不一致：

- **Product Check**：`evaluateProductCheck`（`src/modules/product-checks/matcher.ts:42-81`）是纯函数，输入固定为 `{shape, flavor, lotCode, dateCode}`，返回 `{result, message}`，其中 `message` 是三个**硬编码英文常量**（`matcher.ts:26-30`：`POTENTIAL_MATCH_MESSAGE` / `MANUAL_REVIEW_MESSAGE` / `NOT_MATCHED_MESSAGE`）。
- **Claim Submission**：`DrizzleCaseService` 内部又**自行复用 matcher 并自己决定 triage**（`src/modules/cases/drizzle-case-service.ts`），形成第二处识别决策点。

### 1.2 问题

| 问题 | 后果 |
|---|---|
| 输入锁死为四字段 | 真实消费者无 lot/date、只有照片/UPC/订单号时无法识别 |
| 两处独立 triage | Product Check 与 Claim 的判定可能漂移，难以审计一致 |
| 硬编码 message | 消费者文案未经批准的 Localization 流程；且 `not_matched` 文案可能被误解为“安全” |
| 输出无 reason code | 人工审核无法批量归类，运营队列不可执行 |

`evaluateProductCheck` 是纯函数这一点**是良好基础**——本 ADR 保留其纯函数特性，只升级它的输入/输出契约。

---

## 2. 决策（Decision）

新增一个**深模块** `ProductIdentificationPolicy`，作为商品识别的唯一决策点。调用方只提交识别信号 + 版本化规则快照，得到结构化结果。

### 2.1 目标接口

```ts
// src/modules/product-identification/policy.ts
identify(input: IdentificationInput, snapshot: CampaignSnapshot): IdentificationResult

interface IdentificationInput {
  mode: 'order' | 'product_identifiers' | 'unknown';
  campaignSlug: string;
  // mode=order: 订单号 + 渠道 + 购买日期
  // mode=product_identifiers: upc/gtin/model/style/lot/date 等可空信号
  // mode=unknown: 仅照片/渠道/购买日期
  signals: ProductSignals;
}

interface IdentificationResult {
  result: 'potential_match' | 'manual_review' | 'not_matched';
  reasonCodes: string[];           // 稳定原因码，非人类文案
  matchedVariantIds: string[];      // 0|1|多 命中（多即歧义）
  requiredEvidenceProfile: string;  // 交给 ADR 的 Evidence Profile
  checkedCampaignVersion: number;
}
```

**关键约束**：
- 多候选（`matchedVariantIds.length > 1`）→ 一律 `manual_review`，**不武断选一个**。
- 无任何代码/收据时返回 `manual_review`，**绝不拒绝**消费者继续。
- **Policy 不输出人类文案**——只输出 `reasonCodes`；消费者可见 message 由已批准的 Campaign Localization 按 `messageKey` 渲染。
- **Policy 不输出安全/危险结论**——`not_matched` 仅表示“当前输入未找到已列明匹配”，**绝不等于 safe**。

### 2.2 调用约定

| 调用方 | 用法 |
|---|---|
| Product Check 路由 | `identify()` 给消费者初步结果（非最终裁决） |
| Claim Submission (`DrizzleCaseService`) | 基于 **pinned Campaign Version** 再调一次 `identify()` 复核，确保提交时与发布时规则一致 |

两者**必须调用同一 Policy 实例**，消除双 triage 漂移。

### 2.3 模块结构

```
src/modules/product-identification/
  policy.ts                     # 纯函数 identify()，无 DB，可单测
  service.ts                    # 编排：读快照 + 调 policy + 映射文案
  drizzle-snapshot-reader.ts    # 从 DB 读 CampaignSnapshot（Variant/Identifier/Remedy/Evidence）
```

- `policy.ts` 保持**纯函数、无 DB 依赖**——延续 `evaluateProductCheck` 的可测性优点。
- 复杂性（归一化、多信号匹配、歧义判定、Evidence Profile 选择）全部**收拢在模块内部**，对调用方只暴露 `identify()` 这一个小接口（深模块原则，对应优化规划 O7）。

### 2.4 reason code 规约

matcher 现有的三个 message 常量下线，替换为稳定 reason code，例如：

| 旧 message | 新 reasonCode | 含义 |
|---|---|---|
| `POTENTIAL_MATCH_MESSAGE` | `identifier.single_match` 或 `order.exact_match` | 唯一命中 |
| `MANUAL_REVIEW_MESSAGE` | `identifier.ambiguous_multi_match` 或 `input.insufficient_signals` | 多候选或信号不足 |
| `NOT_MATCHED_MESSAGE` | `identifier.no_match` | 无命中 |

最终 code 表由 Sprint 1 契约样例定稿（见优化规划 Sprint 0 产出）。

---

## 3. 动机（Rationale）

1. **单一决策点**：消除 matcher 与 CaseService 双 triage，使 Product Check 与 Claim 判定永远一致且可审计。
2. **深模块**：调用方只关心 `identify(input, snapshot)`，归一化/多信号/歧义/Evidence Profile 等复杂度内部消化——这正是 `DrizzleCaseService` 已验证有效的“大实现、小接口”模式的复用。
3. **文案与逻辑解耦**：reason code 稳定、可审计、可批量归类；人类文案走 Localization 审批，避免未经批准的“安全”措辞外泄。
4. **契约自由**：三态输入（order/identifiers/unknown）让无包装代码的消费者也能提交进人工审核，对应业务反馈的核心诉求。

---

## 4. 后果（Consequences）

### 正面
- Product Check 与 Claim 复用同一策略与 reason code，行为一致。
- 消费者文案由版本化配置产生，matcher 不再硬编码英文。
- 人工审核队列可按 reason code 批量归类（运营入口 O10 依赖于此）。

### 负面 / 代价
- `evaluateProductCheck` 的现有调用方（`DrizzleProductCheckService`）与 CaseService 内联匹配逻辑都要改调用，是一次**集中的契约迁移**。
- reason code 表需要与 Localization key 一同维护，新增一道（轻量的）配置映射。
- 现有 matcher 的纯函数测试需改写为针对 `policy.identify()` 的测试（旧测试在新接口覆盖后删除）。

### 规约
- `policy.ts` **禁止**直接读 DB——所有数据通过 `CampaignSnapshot` 参数传入。
- `matchedVariantIds.length > 1` 时**禁止**返回 `potential_match`。
- Policy 返回值**禁止**包含任何面向消费者的英文 message 字符串。

---

## 5. 验证（Verification）

以纯函数单测为主（无需 DB）：

- `order` 模式：精确命中订单 → `potential_match` + `order.exact_match`。
- `product_identifiers` 模式：
  - 单一 UPC 命中 → `potential_match` + `identifier.single_match`，`matchedVariantIds.length === 1`。
  - 同一 UPC 命中 2 Variant → `manual_review` + `identifier.ambiguous_multi_match`，`matchedVariantIds.length === 2`。
  - 无命中 → `not_matched` + `identifier.no_match`。
- `unknown` 模式（无代码/收据）→ `manual_review` + `input.insufficient_signals`。
- 断言返回值**不含**任何 `safe` / `safe to use` 字样。
- 集成测试：Product Check 与 Claim Submit 同输入 → 同 `reasonCodes`。

---

## 6. 替代方案（Alternatives Considered）

| 方案 | 否决理由 |
|---|---|
| **A. 保留 matcher 纯函数，仅扩字段** | 仍留下 CaseService 内联 triage 双决策点；无法收拢 Evidence Profile、reason code |
| **B. 把识别做成 CaseService 的私有方法** | Product Check 路由无法复用；违反“Product Check 与 Claim 同一策略”要求 |
| **C. Policy 直接输出英文 message** | 绕过 Localization 审批；无法避免 `not_matched` 被误读为安全 |
| **D. 多候选用相似度评分选最优** | 引入主观阈值；与“歧义是业务事实、转人工”的原则冲突，且无审批依据 |

---

## 7. 关联与后续

- **驱动**：`docs/optimization-plan-v1.md` §4 T3（O2）。
- **依赖**：ADR-0001（Policy 在 Variant/Identifier 模型上运行；多候选即歧义）。
- **下游**：ADR-0003（迁移 M2 阶段契约切 reasonCodes）；优化规划 Sprint 2 的 Evidence Profile（T4.2）消费 `requiredEvidenceProfile`。
- **Decision Gate**：D2（订单来源）影响 `mode=order` 的 `signals` 形态——本 ADR 采用“受控导入表”默认值，实际出现第二个 Adapter 时再建外部 seam。
