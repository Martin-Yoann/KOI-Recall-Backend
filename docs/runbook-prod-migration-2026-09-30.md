# 生产库迁移应用 · 验收记录(2026-09-30)

> 本文档是对 2026-09-29《Runbook:生产库迁移应用(BUG-0 修复)》的执行记录与修订版清单。
> 目标库:`ep-steep-truth-awleeryl-pooler.c-12.us-east-1.aws.neon.tech/neondb`(Neon pooled)。
> 连接凭据来源:`koi-recall-backend/.env.production` 的 `koi_DATABASE_URL`(Vercel production 作用域)。

## 0. 背景修正

最初核对本机仓库时发现 `db:drift-check` 与迁移 0022–0027"不存在",后经 `git fetch` 确认:
**本机检出落后 origin/main 10 个提交**(`cb1a179` → `a7ef7be`),原 Runbook 是按远端真实状态写的。
快进后:`db:drift-check` = `tsx scripts/check-migration-drift.ts`(只读),迁移 0022–0027 齐全。原 Runbook 结论有效。

## 1. 漂移检查(只读)

```
$ DOTENV_CONFIG_PATH=.env.production pnpm db:drift-check

[MIGRATION DRIFT] The database at ep-steep-truth-awleeryl-pooler.c-12.us-east-1.aws.neon.tech/neondb
is missing 6 of 27 local migrations:
  - 0022_dashing_the_stranger.sql   (recall_case_status 增加 'escalated')
  - 0023_cooing_junta.sql           (case_escalation_category + case_escalations 表)
  - 0024_late_gamora.sql            (reportability_reviews.filing_evidence_encrypted + NOT VALID 约束)
  - 0025_round_hawkeye.sql          (incidents failure_mode_other 加密列 + 成对约束)
  - 0026_icy_liz_osborn.sql         (审查案件化:case_id 回填 + NOT NULL + 唯一索引 + 枚举新值)
  - 0027_misty_wolverine.sql        (disposal_declarations 每任务唯一索引)
(Applied on this database: 21 migrations.)
```

比原 Runbook(0024–0027)多两个:**0022、0023 也缺失**。缺失集与线上 500 症状吻合(事故申报缺
`case_id`/`filing_evidence` 列,管理端缺 `case_escalations`/`escalated`)。

## 2. 前置审计(只读,全绿)

| 检查 | 结果 | 判定 |
|---|---|---|
| 六项"半应用检测"(枚举/表/列/索引是否已存在) | 全部 false | 无手动改库痕迹,可整批按序应用 |
| 数据规模 | 37 案件 / 7 审查 / 7 事故 / 1 处置声明 | 极小,迁移秒级 |
| 0026 回填:悬空 incident_id | 0 | 回填全量,`SET NOT NULL` 不会失败 |
| 0026 回填:同 case 重复 review 组数 | 0 | 唯一索引可建 |
| 0027:同 task 重复声明组数 / task_id 空值 | 0 / 0 | 唯一索引可建 |
| 0024:filed 行缺 cpsc_reference/filed_at | 0 | NOT VALID 不校验历史行 |

## 3. 应用迁移(受阻 → 修复 → 成功)

**首次执行失败(原子回滚,库无残留):**

```
$ DOTENV_CONFIG_PATH=.env.production pnpm db:migrate
error: new row for relation "reportability_reviews" violates check constraint "reportability_reviews_filed_chk"
```

**根因(仓库迁移缺陷,任何含历史 filed 行的库都会命中):**
0024 的 `filed_chk` 是 `NOT VALID`——它豁免历史行的**校验**,但对历史行的 **UPDATE 依然生效**
(0024 注释原文:"为几个月前做出的安全决定补造依据就是捏造")。0026 的回填 UPDATE 覆盖所有行,
触到 3 条历史 filed 行(均无、也不应有回执,且全部为 `is_test_data=true` 的演示数据)即失败。
CI 每次在空库上跑,发现不了;本库是第一个带数据的应用对象。
drizzle 迁移器把整批迁移包在单个事务里,失败即整体回滚(`drizzle.__drizzle_migrations` 仍为 21)。

**修复(已提交):** `24b4fa1 fix(reportability): the case-scope backfill cannot update grandfathered filed rows`
—— 0026 内回填前 `DROP CONSTRAINT IF EXISTS "reportability_reviews_filed_chk"`,回填后按 0024 的
**原定义、仍为 NOT VALID** 恢复。终态与空库直跑完全一致(豁免语义不变),零数据改动。

**修复后执行成功:**

```
$ pnpm db:check                                        # 本地快照一致性
Everything's fine 🐶🔥
$ DOTENV_CONFIG_PATH=.env.production pnpm db:migrate   # 应用 0022–0027
Applying migrations via neon-serverless driver...

$ DOTENV_CONFIG_PATH=.env.production pnpm db:drift-check
Migration drift check passed: all 27 local migrations are applied on ...neondb.
```

**迁移后状态核对(逐项):**

| 项 | 结果 |
|---|---|
| 已应用迁移数 | 27 / 27 |
| 0022 `escalated` 枚举 | ✓ |
| 0023 `case_escalations` 表 + `suspected_fraud`/`data_privacy` 枚举值 | ✓ |
| 0024 `filing_evidence_encrypted` 列 | ✓ |
| 0025 `incidents` other 加密列 | ✓ |
| 0026 `case_id` 回填 7/7、incident_id 可空、case 唯一索引 | ✓ |
| 0027 处置声明唯一索引 | ✓ |
| `filed_chk` 仍为 NOT VALID 且定义含证据子句 | ✓(与 0024 一致) |
| 历史数据 | 未改动(3 条 filed 行原样) |

## 4. 端到端复核

### 4a. 事故申报(已验证 ✓)

浏览器(www.koiimprtinc.com,演示活动 `music-lollipop-demo-2026`)按消费者流程提交带事故的测试申报
(事件类型 Injury/Choking/Ingestion,含 product_photo + proof_of_purchase 真实上传),结果:

- 提交成功,案件编号 **KOI-XGNW-GUA7VWXK**(subtype=injury_hazard, incident_flag=true)
- `reportability_reviews` 自动生成:**status=pending**,case_id/incident_id 均已关联(0026 落库验证)
- `document_uploads`:product_photo、proof_of_purchase 均 **linked**
- 全库案件数 37 → 38

> 注:该测试申报会经 Outbox 在下次排空时向 `koi-migration-test@example.com` 发送确认邮件(合成地址)。

### 4b. 管理端(已验证 ✓,使用测试 ADMIN 账号)

- 未鉴权 `GET /admin/cases?status=submitted` → **401**(路由正常,仅缺会话;此前为鉴权后 500)
- `GET /admin/cases?status=submitted`(Bearer)→ **200**,返回含 workflow/resolution 元数据的完整列表
- `GET /admin/cases/KOI-XGNW-GUA7VWXK`(Bearer)→ **200**,详情完整(campaign/products/disposal 等)
- 管理端列表/详情所依赖的关联查询形态(recall_cases × reportability_reviews.case_id ×
  case_escalations × case_resolutions)已在生产库完整执行(38 行)

### 4c. BUG-1 / BUG-3(已验证 ✓)

- **BUG-1(指引库 Approvals 计数)**:`GET /admin/disposal-instructions` → 200,响应含
  `approvalCount`(demo 指引 v2:approved,approvalCount=1)——相关子查询计数修复(f1cc0e0)生效
- **BUG-3(处置证据上传)**:推进测试案件的处置任务(解除事故证据保留挂起 → 确认产品受影响 →
  确认资格 confirmed_eligible)后,消费者处置页上传流程:
  - `POST /v1/disposal-tasks/{taskId}/upload-tokens` → **201**(此前会报
    "Evidence category 'disposal_evidence' is not accepted by this campaign."——未再现)
  - `POST /v1/disposal-tasks/{taskId}/evidence` → **201**(批次送审)
  - 页面状态:"Your photos are with our team for review."
  - DB:`disposal_evidence_batches` 1 条(review_status=pending),3 份
    `disposal_evidence` 文档 upload_status=verified

## 4d. 过程中发现并修复的第三个生产问题:admin 来源 CORS 缺失

**症状**:用户在 admin.koiimprtinc.com 登录报"Cannot reach the server. Is the backend running?",
但凭据正确、后端健康、账号未被锁定(failed_login_attempts=0)。

**根因**:`CORS_ALLOWED_ORIGINS`(Vercel production,49 天前设置,Sensitive 不可拉取)只含
`https://www.koiimprtinc.com`,**不含 `https://admin.koiimprtinc.com`**。浏览器侧所有 admin→API
响应因缺少 `Access-Control-Allow-Origin` 被拦截(fetch status 0),curl 无 CORS 限制故一直正常。
管理端此前通过 API 直接操作,浏览器路径从未被真正打开过。

**修复**:Vercel CLI 更新 production 环境变量为
`https://www.koiimprtinc.com, https://admin.koiimprtinc.com, https://koiimprtinc.com,
https://koi-recall-web.vercel.app, https://koi-recall-admin.vercel.app`,并 `vercel redeploy`。
修复后预检与真实登录均返回正确的 ACAO 头(admin/www 两个来源都验证)。

**测试凭据说明**:账号 `admin@koi-platform.com`(ADMIN)状态 active、未锁定、可正常登录
(登录成功记录已入审计)。建议上线验证完成后修改该密码或停用。

## 4e. 过程中发现并修复的第四个问题:门禁拒绝映射为 500(已修复 ✓)

- `POST /admin/disposal-tasks/{id}/authorization` 在"尚无已接受证据批次"时返回 **500**。根因:
  `DisposalGateViolationError` 只继承普通 `Error`、未接入 Problem Details 体系(`onError` 仅映射
  `HttpProblemError`),客户端的工作流冲突被渲染成服务端故障。文档注释显示作者原以为 500 可接受,
  实际运维无法区分"门禁拒绝"与"服务端故障"。
- **修复**:`17338ef fix(disposal): a refused authorization gate reads as 409 conflict, not 500` —
  该错误改为继承 `HttpProblemError`(409 Conflict,type=`…/conflict`,detail 携带被拒门禁原因),
  `instanceof` 与 `.reason` 不变,33 个 policy 单测全过,typecheck/lint 干净。部署后生产验证:
```
POST /admin/disposal-tasks/{taskId}/authorization
→ 409 {"type":"…/conflict","detail":"Disposal authorization was refused: evidence_not_submitted."}
```

## 4g. 批次验收 → 发授权 全流程(已验证 ✓)

用测试案件把此前只到"409"的链路走完:

| 步骤 | 调用 | 结果 |
|---|---|---|
| 批次验收 | `POST /admin/disposal-batches/{batchId}/review`(decision=accepted) | 204;批次 review_status=**accepted** |
| 门禁复核 | `GET /admin/disposal-tasks/{taskId}` | blockingReasons=[];allowedActions 出现 **disposal.issue_authorization** |
| 发授权 | `POST /admin/disposal-tasks/{taskId}/authorization` | **201** {authorizationId: 7faba280…, status: active};覆盖已确认产品 ×1 |
| 消费者可见 | 处置页(Refresh status 后) | photos=**Accepted by our team**;**Permission to dispose: Given**;声明按钮激活 |

> 同一条 authorization 路径先 409(批次未验收)→ 验收后 201——409 修复的完整闭环。
> 消费者页初始加载可能命中 Data Cache 旧状态,页面自带 "Refresh status" 即时拉新(设计如此)。
> 剩余未验证步骤:消费者声明完成(`disposal.declare_completion`,页面按钮已可用)。
- 测试案件 KOI-XGNW-GUA7VWXK 的处置任务已推进到"证据待审"状态(演示数据),供管理端复核流程使用。

## 5. 命令清单(可复现)

```bash
cd koi-recall-backend
git fetch --all && git merge --ff-only origin/main        # 确保与部署一致
DOTENV_CONFIG_PATH=.env.production pnpm db:drift-check    # 只读:漂移检查(可入发布后检查)
DOTENV_CONFIG_PATH=.env.production pnpm db:migrate        # 写:应用迁移
DOTENV_CONFIG_PATH=.env.production pnpm db:drift-check    # 复核:应 all 27 applied
curl -s https://koi-recall-backend.vercel.app/health/ready
```

## 6. 防复发建议(待产品决定)

- 建议将 `pnpm db:drift-check`(只读)纳入**部署后检查**,缺失即告警;是否升级为流水线强制门禁待定
- 已交付的 `scripts/check-migration-drift.ts` 可安全对任意环境执行(仅 SELECT)
- 提醒:CI 仅覆盖空库迁移路径;本次 0026 类"数据依赖缺陷"需靠对真实库的 drift/审计发现
