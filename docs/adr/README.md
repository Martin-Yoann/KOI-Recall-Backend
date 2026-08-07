# Architecture Decision Records

本目录记录 KOI Recall API 的架构决策，采用 Michael Nygard 的 ADR 格式（中文撰写，对齐 `docs/phase-1/` 风格）。

每条 ADR 记录一个**不可逆或代价高昂**的决策：背景、决策、动机、后果、验证与被否决的替代方案。决策一旦写入并实施，状态从 `Proposed` → `Accepted`（实施完成）→ 历史变更以新 ADR 覆盖，不原地改写已 Accepted 的 ADR。

## 索引

| ADR | 标题 | 状态 | 关联 |
|---|---|---|---|
| [0001](0001-product-identity-model.md) | 真实商品身份模型（Variant / Identifier 分层） | Accepted | O1 / T2 / D1 |
| [0002](0002-product-identification-policy.md) | 统一商品识别策略 seam（ProductIdentificationPolicy） | Accepted | O2 / T3 / D2 |
| [0003](0003-identity-migration-strategy.md) | 身份模型与条件式 Claim 的四阶段在线迁移策略 | Accepted | §6 / D1 / D3 / D4 |

三者的关系：**ADR-0001** 定义“数据是什么”，**ADR-0002** 定义“如何识别”，**ADR-0003** 定义“如何从现状过渡过去”。它们共同支撑优化规划 `docs/optimization-plan-v1.md` 的 Sprint 0–2。

## 何时新增 ADR

参考 `docs/agents/domain.md` 与 CLAUDE.md：典型流程是 `/grill-with-docs` 建立共享词汇与 ADR，再 `/to-tickets` 落地。当决策满足以下任一条件时，应新建 ADR：

- 影响数据库 schema、公开 `/v1` 契约或外部 seam；
- 引入、替换或移除一个平台 adapter（blob/email/crypto/db）；
- 不可逆，或回滚成本显著高于继续。

纯实现细节、bug 修复、测试调整**不**需要 ADR。
