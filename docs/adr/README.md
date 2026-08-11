# Architecture Decision Records

本目录记录 KOI Recall API 的架构决策，采用 Michael Nygard 的 ADR 格式（中文撰写，对齐 `docs/phase-1/` 风格）。

每条 ADR 记录一个**不可逆或代价高昂**的决策：背景、决策、动机、后果、验证与被否决的替代方案。决策一旦写入并实施，状态从 `Proposed` → `Accepted`（实施完成）→ 历史变更以新 ADR 覆盖，不原地改写已 Accepted 的 ADR。

## 索引

| ADR                                               | 标题                                                                         | 状态     | 关联                                  |
| ------------------------------------------------- | ---------------------------------------------------------------------------- | -------- | ------------------------------------- |
| [0001](0001-product-identity-model.md)            | 真实商品身份模型（Variant / Identifier 分层）                                | Accepted | O1 / T2 / D1                          |
| [0002](0002-product-identification-policy.md)     | 统一商品识别策略 seam（ProductIdentificationPolicy）                         | Accepted | O2 / T3 / D2                          |
| [0003](0003-identity-migration-strategy.md)       | 身份模型与条件式 Claim 的四阶段在线迁移策略                                  | Accepted | §6 / D1 / D3 / D4                     |
| [0004](0004-internal-operations-identity-rbac.md) | 内部运营身份与权限模型（Staff 主体 + 固定角色 RBAC + 两级 PII + 跨表面审计） | Accepted | 优化规划 §1 / claim-submission-design |

ADR-0001/0002/0003 的关系：**0001** 定义”数据是什么”，**0002** 定义”如何识别”，**0003** 定义”如何过渡过去”——三者共同支撑优化规划 Sprint 0–2 的消费者侧改造。

**ADR-0004** 独立承接 B 端运营升级：把优化规划 §1”明确不在本轮实现”中的”多层 RBAC / 字段级遮罩”重新立项，落地具名运营主体、固定角色权限、两级 PII 可见性与跨表面审计——兑现 claim-submission-design 已预告的 admin 审计边界。设计细节见 `docs/superpowers/specs/2026-08-10-b-end-admin-rbac-design.md`。

## 何时新增 ADR

参考 `docs/agents/domain.md` 与 CLAUDE.md：典型流程是 `/grill-with-docs` 建立共享词汇与 ADR，再 `/to-tickets` 落地。当决策满足以下任一条件时，应新建 ADR：

- 影响数据库 schema、公开 `/v1` 契约或外部 seam；
- 引入、替换或移除一个平台 adapter（blob/email/crypto/db）；
- 不可逆，或回滚成本显著高于继续。

纯实现细节、bug 修复、测试调整**不**需要 ADR。
