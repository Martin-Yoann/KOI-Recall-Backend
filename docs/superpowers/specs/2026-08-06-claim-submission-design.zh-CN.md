# Claim 提交与字段加密设计（中文版）

日期：2026-08-06
分支：`main`
状态：已批准，等待书面规格审阅

## 目标

实现 `POST /v1/recall-campaigns/{slug}/claims`，作为 Phase 1 消费者流程的最终提交接口。一次成功请求必须以原子方式创建持久化的 Recall Case、保护消费者和事故敏感数据、关联已验证的证明附件、记录 Consent 与事故审查状态、将确认邮件加入队列，并返回现有 OpenAPI 契约定义的响应。

本次工作同时修复当前 `RequestInit.duplex` 导致的 TypeScript 构建阻塞。公开请求与响应契约保持不变。

## 已批准的设计决定

### 初期后台访问模型

Phase 1 只设置一种授权后台用户权限。获得授权的后台用户可以查看和导出完整 Case 数据。Phase 1 不实现“完整值/脱敏值”两类角色、字段级权限或脱敏展示版本。

数据库客户端不持有加密密钥。未来的后台查看和导出操作必须调用后端应用服务：先校验用户权限，再只解密本次请求涉及的记录，并写入审计事件。后台读取和导出接口本身不属于本次实现范围。

### 支持事务的 Neon 驱动

Claim 提交会跨多个关联表写入，不能留下只完成一部分的 Case。当前使用的 `drizzle-orm/neon-http` 明确不支持交互式事务，因此 Neon 路径将切换为 `drizzle-orm/neon-serverless`，并使用 `@neondatabase/serverless` 的 `Pool`。本地及其他标准 PostgreSQL 地址继续使用 `drizzle-orm/node-postgres`。

两条数据库路径必须暴露相同的、支持事务的 Drizzle 能力。Neon 部署必须使用适合 Serverless 工作负载的池化连接字符串。数据库 Handle 必须提供显式关闭能力，供测试和长期运行的本地进程使用；请求处理器不得为每个请求创建新连接池。

已评估但不采用的方案：

- 本地和 Neon 全部使用 node-postgres：类型表面更统一，但会偏离现有 Neon Serverless 适配器，并需要单独处理 Serverless 连接池调优。
- 保留 Neon HTTP，改用 Batch 或存储过程：可以保留驱动，但会把条件校验和幂等逻辑推入更难维护的 SQL 工作流。

## 字段加密

实现一个基于 Node.js 的 `SensitiveDataCryptoPort` 适配器，具备以下特性：

- 使用 AES-256-GCM，每个加密值都生成全新的 96-bit Nonce。
- 密文封装格式包含算法与 Key Version。即使某些表（例如保存加密订单号的表）没有独立的 Key Version 列，密文本身也能描述如何解密。
- 当前加密密钥来自 `FIELD_ENCRYPTION_KEY`，格式为 Base64 编码的 32 字节密钥。
- `HASH_PEPPER` 使用 Base64 编码，解码后至少包含 32 个随机字节。
- 本版本 Key Version 为 `v1`。密文封装和数据库中现有的 `key_version` 列为未来 Keyring 与密钥轮换保留扩展点；多密钥轮换工具不属于本次范围。
- 使用 HMAC-SHA-256 和独立配置的 `HASH_PEPPER` 生成稳定的等值查询 Hash。加密密钥与查询 Pepper 不得使用同一个 Secret。
- 鉴权标签校验失败、密文封装格式错误或未知 Key Version 时必须安全失败，不得返回部分明文。

生成查询 Hash 前按以下规则规范化：

- Email：去除首尾空白并转为小写。
- Address：使用规范化 JSON，字符串字段去除首尾空白，国家代码转为大写。
- Order Number：去除首尾空白并转为大写。
- Idempotency Key：使用已经通过校验的 Header 原值，仅保存其 HMAC。

以下内容必须在持久化之前加密：

- 消费者名字、姓氏、Email、可选电话和邮寄地址。
- 可选订单号。
- 完整且已规范化的提交快照。
- 事故描述。
- 确认邮件收件人。

日志、错误详情、分析事件、Outbox Payload 和幂等记录中不得写入敏感字段明文、原始 Draft Token、加密密钥、Pepper 或完整请求正文。

如果已配置 `DATABASE_URL`，但缺少任意一个加密 Secret，现有 Campaign、商品预筛、Draft 和附件服务仍然可用；Claim 提交继续作为 `501 Not Implemented` 能力。这既保留当前分阶段开发方式，也明确生产启用要求。

## Claim Service 边界

修改 `CaseService.submit`：接收已校验的 Claim Command，并返回强类型的 `ClaimSubmissionResponse`。新增 `DrizzleCaseService`，依赖数据库与 Crypto Port。Case、事故、Communication、附件、幂等和 Outbox 写入共同构成一次聚合操作，因此完整提交事务由该服务统一负责。

Hono 路由执行以下流程：

1. 接收已经由 Zod 校验的 Path、Header 和 Body。
2. 调用 `CaseService.submit`。
3. 在 HTTP 边界使用 `claimSubmissionResponseSchema` 解析服务结果。
4. 返回 HTTP 201 和解析后的响应。

路由在服务调用之后不得再无条件返回当前的 501 响应。

## 提交流程

### 事务外准备

在打开事务前完成确定性的、无需访问数据库的工作：

- 规范化已校验请求，并计算 SHA-256 Request Hash。
- 使用查询 Pepper 计算 Idempotency Key Hash。
- 加密消费者字段、可选订单号、提交快照和事故描述。
- 生成候选 Case UUID、公开 Reference 和时间戳。

可以先查询一次幂等记录；如果已有成功提交，可以不打开事务而直接返回。只有 Request Hash 相同才能重放，否则返回 409。

### 事务内校验

开启 PostgreSQL 事务，并对 Draft 行加更新锁。在事务内完成：

1. 验证 Draft 存在、Token Hash 匹配、状态为 Active、尚未过期，并且 Draft 所属 Campaign 与 Path Slug 一致。
2. 验证 Campaign 仍为 Active。即使之后发布了更新版本，仍使用 Draft 创建时绑定的 Campaign Version。
3. 验证每个 `campaignProductId` 都属于该固定版本。重新执行产品匹配逻辑并保存匹配结果。预筛结果为 `not_matched` 或 `manual_review` 不直接拒绝 Claim，而是把 Case 路由到 Triage。
4. 验证请求的 Remedy 在固定版本中处于 Active 状态。
5. 拒绝重复 Document ID。验证每个引用附件均属于当前 Draft，并且状态为 `verified`。根据固定版本的附件规则重新计算每种 Evidence Category 的最小和最大数量。
6. 验证两种必需 Consent 都只出现一次，并且均已接受。
7. 查找固定版本与 Locale 对应的 Active 确认邮件模板。模板缺失属于服务端配置错误，不属于消费者输入错误。

### 原子写入

完成校验后，在提交事务前写入以下全部内容：

- `recall_cases`：正常情况下状态为 `submitted`；任一商品需要人工复核，或 `incidentAnswer` 为 `unsure` 时，状态为 `triage`。
- `case_consumers`：保存加密值和查询 Hash。
- 每个申报商品写入一条 `claimed_products`。
- 每个必需 Consent 写入一条 `case_consents`。
- 写入一条加密的 `submission_snapshots`。
- 当答案为 `yes` 或 `unsure` 时，写入一条 `incidents` 和一条 Pending `reportability_reviews`。对于 `unsure`：缺少 Event Type 时规范化为 `unknown`；缺少日期时规范化为 `occurredDateUnknown=true`，确保记录满足数据库约束。
- 将每个被引用的 `document_uploads` 关联到 Case，清除其 Draft Owner 和 Category Slot，状态改为 `linked`，并设置 `linked_at`。
- 将 Draft 状态改为 `submitted`，并设置 `submitted_case_id`。
- 写入一条 `case_events` 提交审计事件，只包含非敏感标识和状态元数据。
- 写入一条收件人已加密、状态为 Queued 的 `communications`。
- 写入一条用于发送确认邮件的 Pending `outbox_events`。Payload 只包含记录标识，不包含明文收件人或邮件正文。
- 写入包含完成响应、并设置有限过期时间的 `idempotency_records`。

`emailStatus: queued` 只表示事务已经提交 Communication 和 Outbox 记录，不表示 Resend 已接受或送达邮件。

### 并发与重放

- Draft 行锁会串行化使用不同 Idempotency Key 提交同一 Draft 的请求。第一次提交成功后，其他请求返回 409；只有命中已提交幂等记录的合法重放可以返回原结果。
- 现有唯一约束 `(endpoint, key_hash)` 是并发使用同一个 Key 时的最终保护。
- 如果最后写入幂等记录时发生唯一键竞争，输掉竞争的事务必须回滚，然后读取获胜事务的记录。仅当 Request Hash 相同时返回原响应，否则返回 409。
- 公开 Case Reference 使用密码学安全随机数生成；如果命中专用唯一约束，以有限次数重试。

任何事务步骤失败时，都不得残留部分 Case、已关联附件、事故记录或已排队邮件。

## 错误映射

继续使用现有 Problem Details Envelope 和 Request ID。

- `400`：请求 Schema 校验失败，在调用 Service 前处理。
- `404`：Path 中的 Campaign 与 Draft 所属公开 Campaign 不匹配。
- `409`：同一 Idempotency Key 对应不同请求、Draft 已提交或并发状态冲突。
- `410`：Draft Token 无效、Draft 已过期或 Draft 不再处于 Active 状态。
- `422`：商品归属、Remedy、Evidence Set、Document 状态或必需 Consent 无效。
- `501`：未配置数据库或加密 Provider。
- `503`：数据库连接或可用性故障。
- `500`：Campaign 所属配置缺失、Service 返回值不符合契约、加密失败或其他非预期服务端错误。

面向消费者的错误不得泄露 Draft ID 是否存在、密文内容、数据库约束名、Provider 响应正文或 Secret 配置值。

## 初期后台与导出边界

本次实现提供可逆的加密和解密能力，但不新增 Admin API。未来实现后台 Case 查看和导出时，Phase 1 使用一个具备完整数据访问能力的授权门槛：

- 不区分脱敏/完整角色，也不设置字段级权限。
- 只有后端应用服务在完成身份认证和权限校验后才能解密。
- 查看完整值和导出时记录审计信息，包括操作者、时间、用途、选择范围和记录数量。
- 导出文件应短期有效，并受访问控制保护。
- 原始 SQL 访问和数据库备份中仍然只能看到密文。

该边界避免过早引入复杂 RBAC，同时保留数据库泄露场景下的保护能力。

## 测试策略

每项行为都按照 Red-Green-Refactor 执行。

### Crypto 测试

- Unicode 以及调用方允许的空可选值可以完成加密/解密往返。
- 由于 Nonce 随机，相同明文会生成不同密文。
- 篡改密文、错误 Envelope 和未知 Version 必须安全失败。
- 规范化后等价值生成相同查询 Hash，不同值生成不同 Hash。
- 无效加密密钥或 Pepper 配置会被拒绝。

### HTTP 与契约测试

- 有效 Service 响应返回 201，并满足 `claimSubmissionResponseSchema`。
- 无效 Service 输出返回 500，不得返回不符合契约的 201。
- Domain Error 正确映射为 404、409、410 和 422 Problem Details。
- 缺少 Provider 时继续返回 501。

### 数据库与事务测试

- Neon 地址选择 Neon Serverless Pool，本地地址选择 node-postgres；两者都支持事务。
- 有效 Claim 会持久化完整 Aggregate，并返回公开 Reference。
- 相同 Idempotency Key 和相同请求返回原响应，不产生重复记录。
- 相同 Key 配合不同请求返回 409。
- 并发提交同一 Draft 时只能创建一个 Case。
- 在部分写入后强制触发失败，验证完整 Aggregate 全部回滚。
- 商品、Remedy、Evidence、Document、Consent 或 Draft 状态不合法时，数据库保持不变。
- `yes` 和 `unsure` 创建 Pending 事故审查；`no` 不创建 Incident。
- 只有请求中引用且已验证的附件会关联到 Case。
- 数据库中不得出现提交的明文 PII、事故描述、订单号、原始 Draft Token 或邮件收件人。

数据库集成测试继续通过 `RUN_DB_INTEGRATION=true` 显式开启。完成本功能前必须针对本地 PostgreSQL 测试数据库运行。

### 完成检查

- 运行完整 Vitest，以及启用后的数据库集成测试。
- 运行 TypeScript Typecheck，并确认 `RequestInit.duplex` 错误已消除。
- 对本任务拥有的文件运行 ESLint 和 Prettier。
- 运行 OpenAPI 一致性检查和 Drizzle Schema 检查。
- 使用种子数据和 Hono `app.request()`，直接验证 Claim 返回 201。

## 文档与运行配置变更

更新 README 和 Phase 1 API/架构文档，说明：

- 配置数据库及加密 Secret 后，Claim 提交由真实数据库支持。
- 确认邮件只在本地进入队列，Resend 发送和 Webhook 仍未实现。
- Draft Cleanup 和物理删除 Blob 仍是独立的后续任务。
- 明确加密 Key 格式及两个 Secret 必须分离。
- Neon 部署必须使用支持事务的 Serverless Pool 路径。

本次工作不得加入真实凭证、部署 Vercel、发送邮件、实现 Admin API，也不得修改公开 Claim 契约。
