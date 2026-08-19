# KOI Recall API — Resolution / Workflow / Refund Export 改造实施规划（V2）

> 本文是《KOI Recall API：Resolution、Workflow 与 Refund Export 改造设计》(2026-08-18,状态 Proposed) 的工程落地版：把设计拆成可执行、可验收的任务序列,并标注每项对应的代码改动点、依赖、风险与退出条件。
>
> - **代码基线**：`main @ 461a0c9`(2026-08-14)。工作区另有未提交的部署/密钥/错误日志修复与 `product-checks` legacy 映射改动,与本改造正交。
> - **交付形式**：仓库内规划文档(本文)。**不包含代码实施**,不替代 CPSC / 法务 / 业务审批。
> - **迁移策略**：严格按设计第 12 节 M1(加法)→ M2(回填)→ M3(收紧)。生产库只走 `drizzle-kit generate` + `scripts/migrate.ts` 的版本化迁移,禁止 `drizzle-kit push`。
> - **改造原则**：先在 Contract / Policy seam 写失败测试,再改 schema / implementation;CaseWorkflowPolicy 是唯一状态映射事实源,后端与两个前端不再各自维护 `LEGAL_TRANSITIONS`。

---

## 0. 现状核验结论(已对照 main@461a0c9)

设计第 3 节「当前实现证据」逐条核对如下。行号/文件名均为当前仓库实际位置。

| 设计主张 | 代码证据 | 结论 |
| --- | --- | --- |
| Campaign 已配置 Replacement/Refund | `src/db/schema/campaigns.ts:267` `campaignRemedyOptions`(`code`/`requiresMailingAddress`/`active`/`sortOrder`) | ✅ |
| Claim 校验 remedyCode 属于锁定 Version 且 active | `src/modules/cases/drizzle-case-service.ts:216-230` 按 `campaignRemedyOptions.code` + pinned version 查询并判空 | ✅ |
| recall_cases 含 status/assigned_to/assigned_at | `src/db/schema/claims.ts:73` `recallCases`(`status`/`assignedToStaffUserId`/`assignedAt`) | ✅ |
| case_events 已提供时间线 | `src/db/schema/operations.ts:46` `caseEvents` | ✅ |
| Staff 会话 + 固定角色 RBAC + 两级 PII + audit | `src/db/schema/staff.ts`、`src/modules/staff/permissions.ts`、`src/modules/staff/drizzle-audit-service.ts` | ✅ |
| /admin/cases 支持列表/详情/分派/状态流转 | `src/routes/admin.ts`、`src/modules/admin/drizzle-admin-service.ts` | ✅ |
| vercel.json 固定 Function Region iad1 | `vercel.json` `"regions": ["iad1"]` | ✅ |
| **缺口**：remedyCode 校验后未写 Resolution 表 | `drizzle-case-service.ts` 校验 remedy 后只走 claim 提交 + snapshot,无 `case_resolutions` | ✅ 属实 |
| **缺口**：Admin Case Detail 只返回基础字段+Consumer | `drizzle-admin-service.ts:136 getCaseDetail` 只返回 case 基础字段 + `consumer` | ✅ 属实 |
| **缺口**：Legal transitions 前后端重复 | 后端 `drizzle-admin-service.ts:30-37 LEGAL_TRANSITIONS`;admin 前端 `cases/[id]/page.tsx:165` 同款映射 | ✅ 属实 |
| **缺口**：export 只 5 列 | `src/routes/admin.ts:437-443` 导出 `caseReference,status,subtype,incidentFlag,submittedAt` | ✅ 属实 |
| **缺口**：status 不能表达「退款已批准未导出」 | `recall_case_status` 枚举只有 `submitted…closed`,无 resolution/export 维度 | ✅ 属实 |
| **缺口**：Privacy 只记版本不校验 | `caseConsents.textVersion`(`claims.ts:217`)已记录,但 `campaign_versions` 无 privacy 版本字段,提交不比对当前版本 | ✅ 属实 |
| **外部事实**：美国数据驻留 | Neon/Blob/第三方区域属于基础设施事实,不在代码内 | ⚠️ 待核验(见 F3) |

**绿线**：`pnpm typecheck / openapi:check / db:check` 通过;默认 Vitest 通过(集成套件需 `RUN_DB_INTEGRATION=true`)。当前 drizzle 迁移最新为 `0009_bumpy_alex_power.sql`,新迁移从 `0010` 起。

---

## 1. 改造目标与不做清单

**目标**(设计第 2.1 节):
- 每个 Recall Case 可回答 Requested 与 Approved Resolution;运营可批准金额/币种/批准人/时间。
- Case 详情可展示当前步骤、责任部门、下一步动作与完整历史。
- Finance 可获得经授权、可审计的 Refund CSV(不调用支付,不存卡/银行资料)。
- Case 关闭受 Resolution 完成 + Incident reportability gate 双重门槛约束。
- Claim 记录并校验消费者接受的 Privacy Notice 实际版本。

**明确不做**(设计第 2.2 节):
- 不从 KOI 发起退款;不接 Stripe/PayPal/ERP/WMS/银行;不保存卡/借记卡/银行账户资料。
- 不把导出成功解释为退款成功。
- 不建部门账号/部门队列/在线审批/通知/SLA;不自动提交 CPSC;不自动删除已提交 Case。
- 不把 `responsibleDepartment` 字符串当授权主体(设计第 17 节)。

---

## 2. Decision Gates(默认值已在用,确认前不进对应实现)

| Gate | 暂用默认值 | 影响任务 |
| --- | --- | --- |
| **G1 退款金额单位** | `refund_amount_minor` 为**分**(ISO 4217 最小货币单位),仅支持两位小数货币;其他货币上 UAT 前需确认 | A1/A2/C2 |
| **G2 多商品退款取数** | Refund CSV 的 `purchaseChannel`/`orderNumber` 取**首个 claimed product**;多商品多订单时本阶段不拆分行,进异常清单 | C2 |
| **G3 批准权限** | Resolution approve/complete 沿用 `case.status.transition`(reviewer 及以上);`approved→cancelled` 仅 administrator(设计 §8.1) | A4/B3 |
| **G4 CSV 字段清单** | 采用设计 §9.5 的 12 列;增列可 UAT 追加,删/改含义需新契约版本 | C2 |
| **G5 补充信息阻塞** | `closure_review→closed` 的「无未处理补充信息阻塞」暂以 `status ≠ need_info` 表达;若需跟踪多次往返,再建模 `information_requests` 表 | B3 |
| **G6 共享限流方案** | `case-status-lookup` 生产限流需跨实例(Upstash Redis 等),替换 `InMemoryRateLimiter` 的进程内 Map | E4/F4 |
| **G7 publicStatus 文案** | 采用设计 §9.9 映射表;消费者可读文案进入 Campaign Localization,不在代码写死 | E4/B1 |

> 业务确认与默认值不同时,只调整对应任务的 schema 枚举 / 契约字段,不改变任务序列与依赖。

---

## 3. 任务总览与依赖

```
M1 加法迁移(新增枚举/表 + 双写 + 新读路径,旧路径不动)
   │
   ├─ A Resolution 数据 + 模块 + 审批    [A1 → A2 → A3 / A4]
   ├─ B Workflow 策略 + 关闭门槛          [B1 纯函数; B2/B3 依赖 A+B]
   ├─ C Refund Export                     [C1 → C2 → C3]
   ├─ D Privacy Notice 版本               [D1 → D2]
   └─ E 新 Admin/公开端点                 [E1 依赖 A+B; E4 依赖 B1]
              │
              ▼
M2 回填  [F1,依赖 A1]  ──► 异常清单人工处理
              │
              ▼
M3 收紧  [F2 约束 NOT NULL; E5 移除旧 export]
   ── 横切: F3 美国数据驻留核验、F4 共享限流,与 M1 并行
```

| ID | 任务 | 优先级 | 依赖 | 迁移阶段 |
| --- | --- | --- | --- | --- |
| A1 | case_resolutions 表 + 2 枚举 | P0 | — | M1 |
| A2 | CaseResolutionModule(接口 + 实现) | P0 | A1 | M1 |
| A3 | CaseService.submit 双写 Resolution | P0 | A1, A2 | M1 |
| A4 | resolution approve/complete 路由 | P0 | A2 | M1 |
| B1 | CaseWorkflowPolicy 纯函数 | P0 | —(并行) | M1 |
| B2 | Admin list/detail 接入 workflow + 移除前端重复 transitions | P0 | B1, A1, E1 | M1 |
| B3 | 关闭门槛 + 并发安全 | P0 | A2, B1 | M1 |
| C1 | refund_export_batches/items 表 | P0 | — | M1 |
| C2 | RefundExportModule + CSV 生成 | P0 | C1, A2 | M1 |
| C3 | refund-exports 路由 | P0 | C2 | M1 |
| D1 | campaign_versions 加 privacy 字段 + 契约 | P0 | — | M1 |
| D2 | Claim 校验 privacy 版本 | P0 | D1 | M1 |
| E1 | Case Detail 扩展(产品/证据/Incident/Resolution/Workflow/Events) | P0 | A2, B1 | M1 |
| E2 | GET /admin/incidents | P1 | — | M1 |
| E3 | GET /v1/claim-drafts/{id}/documents | P1 | — | M1 |
| E4 | POST /v1/case-status-lookups 公开查询 | P0 | B1, G6 | M1 |
| E5 | 移除旧 /admin/cases/export | P1 | C3 | M3 |
| F1 | M2 回填脚本 | P0 | A1 | M2 |
| F2 | M3 收紧约束 | P0 | F1 | M3 |
| F3 | 美国数据驻留核验清单 | P0 | —(横切) | 上线门 |
| F4 | 共享限流 + Upload 上线门槛 | P0 | —(横切) | 上线门 |

---

## 4. 任务详细设计

### 工作流 A — Resolution(数据 + 模块 + 审批)

#### A1 — case_resolutions 表与枚举(M1 加法)

**改动点**:新增 `src/db/schema/resolutions.ts`(2 个 `pgEnum` + `caseResolutions` 表),在 `src/db/schema/index.ts` barrel 导出。迁移 `drizzle/0010_*.sql`。

- 枚举 `case_resolution_type`(`replacement`/`refund`)、`case_resolution_status`(`requested`/`approved`/`externally_completed`/`cancelled`)。
- 字段按设计 §6.2:`requested_type` **M1 nullable**、`requested_remedy_option_id`(FK `campaign_remedy_options`)、`approved_type`/`refund_amount_minor`/`currency`/`approved_by_staff_user_id`/`approved_at`/`external_reference`/`completion_note_encrypted`/`completion_note_key_version`/`completed_by_staff_user_id`/`completed_at`/`version`(默认 1,>0)。
- 约束与索引按设计 §6.2:唯一 `case_id`;`index(approved_type, status, approved_at)`、`index(status, updated_at)`;check 约束覆盖「approved/externally_completed ⇒ approved 字段必填」「refund ⇒ amount+currency 必填」「replacement ⇒ amount+currency 为空」「externally_completed ⇒ completed 字段必填」。
- `case_id` FK `recall_cases` `ON DELETE RESTRICT`(Resolution 是 Case 的强一致事实源,不随 Case 级联删除)。

**验收**:`pnpm db:check` 绿;`drizzle-kit generate` 生成 `0010` 后再跑为 no-op;集成测试覆盖 FK/unique/check 约束与事务回滚。

#### A2 — CaseResolutionModule 接口 + 实现

**改动点**:新增 `src/modules/resolutions/service.ts`(接口)+ `drizzle-case-resolution-service.ts`(实现)。

- 接口(设计 §5.1):`requestFromSubmission(input)` / `approve(input)` / `recordExternalCompletion(input)` / `getForCase(caseId)`。
- 不变式:refund 批准时 `refund_amount_minor > 0`、`currency` 为大写 ISO 4217;replacement 批准时两者为空;note 长度按路由契约(10–1000 / 10–2000)。
- 乐观版本:`expectedVersion` 不匹配 → `409`;并发批准仅一个成功。
- 同事务写 `caseEvents`(resolution.requested/approved/externally_completed/cancelled,`data` 只含非敏感业务摘要)与 `adminAuditEvents`(resolution.approve/complete/cancel)。
- 调用方不直接更新 `case_resolutions`;纠错通过新审计操作,不覆盖历史。

**验收**:单测覆盖 requested→approved→externally_completed 全链路、expectedVersion 冲突 409、refund/replacement 数据约束、`externally_completed` 不可回退、审计写入失败时整单失败关闭。

#### A3 — CaseService.submit 双写 Resolution

**改动点**:`src/modules/cases/drizzle-case-service.ts` `submit`(line 123)在锁定 remedy 后,同事务 `insert case_resolutions`:

- `requested_type` = 由 `remedy.code` 映射(`refund` → refund,其余 → replacement)。
- `requested_remedy_option_id` = `remedy.id`。
- `status` = `requested`;`version` = 1。
- 同步写 `caseEvents`(resolution.requested)。

旧读路径不动(仍可从 submission snapshot 恢复)。

**验收**:新 claim 提交后 `case_resolutions` 有且仅有一行 requested;remedyCode 映射正确;默认 Vitest 新增断言;旧 claim 路径不回归。

#### A4 — resolution approve / complete 路由

**改动点**:`src/routes/admin.ts` 新增:

- `POST /admin/cases/{caseRef}/resolution/approve` — 请求 `type`/`refundAmountMinor`(refund 必填)/`currency`(refund 必填)/`note`(10–1000)/`expectedVersion`。权限沿用 `case.status.transition`(G3)。审计 action = `resolution.approve`。
- `POST /admin/cases/{caseRef}/resolution/complete` — 请求 `externalReference?`/`note`(10–2000)/`expectedVersion`。只记人工确认,不调外部系统。审计 action = `resolution.complete`。

**验收**:HTTP 测试成功路径、`expectedVersion` 冲突 409、无权限 403、note 长度 422;`approved→cancelled` 仅 administrator,非 admin 403。

---

### 工作流 B — Workflow(策略 + 关闭门槛)

#### B1 — CaseWorkflowPolicy 纯函数

**改动点**:新增 `src/modules/workflow/policy.ts`。

- 唯一接口 `evaluate(caseState) -> WorkflowSnapshot`,输出 `currentStage`/`responsibleDepartment`/`nextAction`/`allowedActions`/`blockingReasons`(设计 §5.2、§7)。
- 输入:case status/subtype/incidentFlag、reportability review status、resolution type/status。
- 覆盖设计 §7 全 13 行映射;`responsibleDepartment` 是**展示值**,不产生授权;`publicStatus` 的消费者映射也在此提供(设计 §9.9)。
- 不访问数据库、无副作用,可被 admin list/detail/状态流转校验/测试复用。

**验收**:纯函数单测覆盖 §7 全状态组合 + blockingReasons + publicStatus 映射;无副作用断言。

#### B2 — Admin 接入 workflow + 收敛前端 transitions

**改动点**:

- 后端 `DrizzleAdminService.listCases` summary 增加 `resolution.requestedType/approvedType/status` + `workflow.currentStage/responsibleDepartment/nextAction/blockingReasons`;`GET /admin/cases` 新增过滤 `resolutionType`/`resolutionStatus`/`incident`(设计 §9.1)。
- `getCaseDetail` 返回 workflow snapshot(设计 §9.2)。
- **admin 前端**(`koi-recall-admin/src/app/cases/[id]/page.tsx:165`)删除本地 `LEGAL_TRANSITIONS`,状态流转按钮改由后端返回的 `allowedActions` 驱动。

**验收**:list/detail 响应含 resolution + workflow 字段;前端不再维护状态映射;旧硬编码 transitions 删除;typecheck 绿。

#### B3 — 关闭门槛 + 并发安全

**改动点**:`DrizzleAdminService.transitionCaseStatus`(line 231)改造:

- 先 `SELECT … FOR UPDATE` 锁 `recall_cases` 行,校验当前 status 后条件更新(防两个运营同时推进)。
- `approved → closure_review` 要求 resolution `externally_completed`。
- `approved → closed` 禁止直接发生。
- `closure_review → closed` 要求:resolution `externally_completed` + 若 `incidentFlag` 则 reportability review ≠ `pending` + 无 `need_info` 阻塞(G5)。
- 同事务写 `caseEvents`(case.status.transitioned)。

**验收**:集成测试覆盖 reportability pending 阻止 closed、并发推进仅一个成功、非法跳转 422/409、`approved→closed` 被拒。

---

### 工作流 C — Refund Export

#### C1 — refund_export_batches / items 表

**改动点**:新增 `src/db/schema/refund-exports.ts`,迁移 `drizzle/0011_*.sql`。

- `refundExportBatches`:`id`/`requested_by_staff_user_id`/`purpose`(varchar 500)/`row_count`(>0)/`file_sha256`(小写 hex)/`created_at`。
- `refundExportItems`:主键 `(export_batch_id, case_resolution_id)`;`resolution_version`/`row_sha256`/`created_at`;FK `refund_export_batches` 与 `case_resolutions` `ON DELETE RESTRICT`;`index(case_resolution_id, created_at)`。
- 只存引用与摘要,不复制 PII 或 CSV 原文。

**验收**:`pnpm db:check` 绿;迁移再跑 no-op;集成测试覆盖 FK 与主键。

#### C2 — RefundExportModule + CSV 生成

**改动点**:新增 `src/modules/refund-exports/service.ts`(接口)+ `drizzle-refund-export-service.ts`。

- `createExport(input, actor) -> RefundExportFile`、`listExports(filter, actor) -> RefundExportBatchPage`(设计 §5.3)。
- CSV 按设计 §9.5 的 12 列;RFC 4180 转义;Spreadsheet Formula Injection 防护(`=`/`+`/`-`/`@` 开头加 `'`)。
- `sha256`、`rowCount`、`exportBatchId`;同事务写 batch + items + `caseEvents`(refund.exported)+ audit(`refund.export`,metadata 仅 batchId/rowCount/sha256/筛选摘要)。
- PII 解密仅在授权后端调用栈;`orderNumber`/`purchaseChannel` 取首个 claimed product(G2);任一 case 不合格 → 整批失败,不生成部分 CSV;导出前锁定相关 resolution version。
- 不写 CSV 原文/卡号/银行资料到 DB/Blob/日志/审计 metadata。

**验收**:单测覆盖 CSV 转义、公式注入、金额格式、稳定列序、整批失败、重复导出生成新 batch+审计、导出不改 resolution 完成状态。

#### C3 — refund-exports 路由

**改动点**:`src/routes/admin.ts` 新增:

- `POST /admin/refund-exports` — 请求 `caseReferences`(1–1000,唯一)/`purpose`(10–500)/`includePreviouslyExported`(默认 false);响应 `text/csv`,`Content-Disposition` 含 UTC 时间 + batch ID;权限 `case.export`。
- `GET /admin/refund-exports` — 返回 batch metadata 分页(`exportBatchId`/`createdAt`/`createdBy`/`purpose`/`rowCount`/`fileSha256`),不返回 CSV/PII,不提供旧文件重下载。

**验收**:HTTP 测试成功/权限/参数校验;CSV 不含卡号银行字段;GET 不泄露 PII;`Content-Disposition` 正确。

---

### 工作流 D — Privacy Notice 版本

#### D1 — campaign_versions 加 privacy 字段 + 契约

**改动点**:`src/db/schema/campaigns.ts` `campaignVersions`(line 49)新增 `privacyNoticeVersion`(varchar 80)/`privacyNoticeUrl`(text),**M1 nullable**;迁移 `0012_*.sql`(或并入 0010)。Campaign 契约/响应返回 `privacyNotice: { version, url }`。

**验收**:`pnpm db:check` 绿;契约 openapi:check 绿;seed 写入 privacy 版本。

#### D2 — Claim 校验 privacy 版本

**改动点**:`DrizzleCaseService.submit` 校验 `privacy_notice` consent 的 `textVersion` == 锁定 `campaignVersion.privacyNoticeVersion`,不一致 → 422(设计 §6.5)。

**验收**:版本不一致 claim 失败 422;单测覆盖一致/不一致/缺失三态。

---

### 工作流 E — 新 Admin / 公开端点

#### E1 — Case Detail 扩展

**改动点**:`DrizzleAdminService.getCaseDetail`(line 136)扩展返回:claimed products + identification 结果、document metadata(下载走受保护端点)、incident + reportability review、requested/approved resolution、workflow snapshot、最近 100 条 `caseEvents`(occurredAt 正序)。PII 仍按角色脱敏/解密,audit 失败即失败关闭。

**验收**:HTTP 测试详情返回全字段;reviewer 见 masked、compliance/admin 见 raw 且写 `pii.view_raw` 审计;audit 失败 → 请求失败。

#### E2 — GET /admin/incidents

**改动点**:`src/routes/admin.ts` 新增,返回 incident 运营摘要(`incidentId`/`caseReference`/`eventTypes`/`companyObtainedAt`/`injurySeverity`/`reportabilityReviewId`/`reportabilityStatus`/`reviewerId`/`nextAction`),**不含 narrative**;权限沿用现有 incident/audit 读取路径。

**验收**:HTTP 测试摘要字段;narrative 不出现在响应;`nextAction` 由 B1 workflow 派生。

#### E3 — GET /v1/claim-drafts/{draftId}/documents

**改动点**:`src/routes/documents.ts` 新增,`X-Draft-Token` 鉴权,返回该 Draft 的 document processing status(`documentId`/`category`/`uploadStatus`/`scanStatus`/`failureCode`/`updatedAt`);不返回 Blob token / 公开 URL。字段以 `src/db/schema/documents.ts` 现状为准,缺 `scanStatus`/`failureCode` 则本任务补齐。

**验收**:HTTP 测试区分 uploaded/verified/scan pending/rejected;无 token 或无效 token 401。

#### E4 — POST /v1/case-status-lookups(公开免登录)

**改动点**:`src/routes/` 新增公开端点。

- 请求 `caseReference`/`email`;用 `caseConsumers.emailLookupHash` 与输入 email 的 HMAC 做恒定形态校验。
- Case 不存在与 email 不匹配返回相同 Problem Details 形态,防枚举;不返回/不记录 email 原文。
- 响应只含 `caseReference`/`campaignTitle`/`publicStatus`/`publicStatusLabel`/`consumerNextAction`/`requestedResolution`/`approvedResolution`(仅可见时)/`lastUpdatedAt`(设计 §9.9)。
- `publicStatus` 由 B1 的消费者映射产生。
- **限流必须跨实例**(G6):不能用 `InMemoryRateLimiter` 进程内 Map 作为 Production 唯一限流。

**验收**:正确组合返回公开状态;错误组合不泄露 case 是否存在;响应不含内部 status/assignee/narrative/reportability/audit;跨实例限流生效(F4)。

#### E5 — 移除旧 /admin/cases/export(M3)

**改动点**:`src/routes/admin.ts:422-447` 旧 `exportCases` 路由在 admin/consumer 前端完成新契约切换后移除;`AdminService.exportCases` 同步删除。

**验收**:旧路径 404;OpenAPI 无残留;前端不再调用旧 export。

---

### 工作流 F — 迁移与上线门槛

#### F1 — M2 回填脚本

**改动点**:新增 `scripts/backfill-case-resolutions.ts`。

- 用应用层 Crypto Adapter 解密 `submissionSnapshots.encryptedPayload`,提取旧 Case 的 `remedyCode`,映射为 replacement/refund,写 `case_resolutions`。
- 必须支持 `--dry-run`、显式 Case allowlist、幂等重跑、结果统计;无法解密/无法映射进人工异常清单,不静默猜测。

**验收**:dry-run 不写库;幂等重跑无重复;异常清单明确;集成测试覆盖。

#### F2 — M3 收紧约束

**改动点**:确认所有 Case 有 resolution 后,`requested_type` 设 NOT NULL;确认所有 published Campaign Version 有 privacy 版本/URL 后设 NOT NULL;迁移 `0013_*.sql`。

**验收**:`drizzle-kit generate` 再跑 no-op;`pnpm db:check` 绿;约束收紧不破坏既有数据。

#### F3 — 美国数据驻留核验清单

**改动点**:不写代码,产出核验记录(可并入本文或 docs/)。

- Neon Production 项目位于美国区域;restore window/branch/备份不复制到美国以外。
- Private Blob Store 创建于美国区域(区域创建后不可变更,错误区域需新建+迁移)。
- Vercel Function 默认及 failover region 均在美国(当前仅 `iad1`,需补 failover 声明)。
- Resend/日志/错误追踪/分析/备份/支持工具不接收超范围 PII,数据处理符合批准 Privacy Terms。
- Admin/Consumer Front 不把敏感动态响应缓存到全球 CDN。

**验收**:逐项有书面确认;任何一项不满足即阻断上线(设计 §11.2)。

#### F4 — 共享限流 + Upload 上线门槛

**改动点**:`src/middleware/rate-limit.ts` 的 `InMemoryRateLimiter` 不能用于 E4 公开端点与 Upload;引入共享限流存储(Upstash Redis 等),提供 `RateLimiter` 新实现并接线。同时满足设计 §9.10 的 Upload 门槛(Draft 配额/Token reservation 防重放/Category Slot 并发唯一/Blob/MIME/malware)。

**验收**:E4 与 upload-token 在共享限流下压测;Token reservation 不可重放绕过配额;Category Slot 并发唯一约束有集成测试。

---

## 5. 迁移阶段与发布顺序

对应设计第 12/15 节:

1. **M1** 落地 A1–A4、B1–B3、C1–C3、D1–D2、E1–E4(加法迁移,旧读路径不动)。
2. **M2** 跑 F1 回填 + 人工处理异常清单。
3. 发布扩展后的 OpenAPI;重新生成 admin/consumer 前端 generated types。
4. 发布 Admin 新 Case/Resolution/Export 界面;发布 Consumer 真实 Claim + Privacy 流程。
5. 完成 F3(美国区域)与 F4(共享限流)检查。
6. 运行 UAT(第 6 节)。
7. **M3** 执行 F2 收紧约束 + E5 移除旧 export。

---

## 6. 新增关键验收场景(每阶段回归)

单元 / 接口:

- [ ] CaseWorkflowPolicy 覆盖设计 §7 全状态组合。
- [ ] Refund/Replacement 数据约束;`approved_type` 与金额/币种互斥正确。
- [ ] CSV 转义、公式注入、金额格式、稳定列序。
- [ ] Privacy Notice 版本匹配;不一致 422。
- [ ] publicStatus 映射与 status-lookup 响应裁剪。
- [ ] Requested → Approved → Externally Completed;并发批准仅一个成功;expectedVersion 冲突 409。
- [ ] Reportability pending 阻止关闭;Export 不改 resolution 完成状态;重复导出生成新 batch + 审计。

集成:

- [ ] FK/unique/check 约束、事务回滚、行锁;回填 dry-run 不写库。
- [ ] 两个运营同时推进同一 Case 仅一个成功。

UAT(设计 §16 九条):Replacement/Refund 全链路、CPSC 改判 Refund、Refund 导出不含卡号、导出后仍显示外部处理未确认、记录外部完成进入 Closure Review、Incident pending 阻止关闭、Reviewer 脱敏/Compliance 明文审计、Privacy 版本过期拒绝提交、Case Reference+Email 正确/错误组合不泄露。

---

## 7. 完成定义(Definition of Done)

- 所有 P0 schema/契约/OpenAPI/前端 generated types/文档同步更新。
- 默认 + DB 集成测试均通过;CI 不静默跳过 PostgreSQL 集成套件。
- Case 详情可展示 Resolution、Workflow Snapshot、产品/证据/Incident、最近 Events。
- Refund Export 可审计(导出人/目的/时间/范围/行数/摘要),CSV 不含卡号/银行资料,不写 DB/Blob/日志。
- Case 关闭受 Resolution 完成 + Incident reportability 双重门槛约束,并发安全。
- 前后端不再各自维护状态映射,CaseWorkflowPolicy 是唯一事实源。
- Privacy Notice 版本纳入 Campaign 契约并参与 Claim 校验。
- 美国数据驻留与共享限流核验书面确认后方可上线。

---

## 8. 风险与回滚

| 风险 | 缓解 |
| --- | --- |
| Resolution 与 Case 状态两套枚举不一致 | 只由 CaseResolutionModule 写 resolution;CaseWorkflowPolicy 统一计算;前后端不各自映射 |
| 退款金额单位/取数口径争议 | G1/G2 先按默认值,业务确认后局部调整,不改任务序列 |
| 共享限流(Upstash)引入外部依赖 | G6 先隔离在 E4/Upload 端点;存量端点继续用 InMemory 作为单实例兜底 |
| 回填脚本误解密/误映射 | F1 强制 dry-run + allowlist + 幂等 + 异常清单,不静默猜测 |
| M3 约束收紧破坏旧数据 | 收紧前先跑 F1 回填 + 完整性校验,确认 100% 覆盖再 `NOT NULL` |
| CSV 公式注入/金额精度 | C2 专项单测 + UAT;金额用整数 minor 单位 |
| 数据驻留不达标 | F3 作为独立上线门槛,任何一项不满足即阻断 |

---

## 9. 后续阶段(本次不做,仅 Rubie 确认第 6 条后另行设计)

部门主体与成员、部门 Work Item、独立工作队列、在线审批与动作表单、SLA/通知/升级/替班、角色与部门授权关系。**不得用 `responsibleDepartment` 字符串直接演化成授权系统**(设计第 17 节)。

---

**资料来源**：《KOI Recall API：Resolution、Workflow 与 Refund Export 改造设计》(2026-08-08,Proposed);`koi-recall-api main@461a0c9`(2026-08-14 逐条核验第 0 节)。
