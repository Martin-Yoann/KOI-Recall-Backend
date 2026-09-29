# 四个未决事项 — 当前状态

> **2026-09-29 更新：本页主体是此前的运行记录，开头“只剩 D27 未证”“三个仓库均干净、全部已推送”等结论不适用于本轮整改。**
> 本轮代码已在三个仓库的本地工作区实施，尚未推送或部署。当前未决还包括：Page 4 正式时序及 D18/D19 的产品/合规签认，D09 已接受照片替换规则，目标库同任务重复声明只读审计及约束迁移，隔离数据库、真实 Blob、浏览器和测试环境验收，处置材料与保留期限批准。详见 [继续整改计划](superpowers/plans/2026-09-28-disposal-instructions-remediation-continuation.zh-CN.md)和[验收矩阵的最新状态说明](disposal-acceptance.md)。下文历史状态不能视为本轮已关闭证明。

本文件只记录当下四件事的准确状态，取代此前的一切讨论细节。其余内容见
`docs/disposal-acceptance.md`（验收矩阵：**只剩 D27 一行未证**）与
`docs/editing-source.md`（编辑纪律）。三个仓库均干净、全部已推送。

---

## 1. D27 — 示例内容安全性（唯一未证的验收行）

**内容**：示例照片永不展示实验室损毁；步骤永不要求复现冲击测试、打开手柄、取出电池。

**状态：未证。** 代码侧已就位——渲染器只渲染运营内容，参考图强制要求 `altText`，本仓库
从未编写任何此类文案（这一点本身可核对：`disposal-instruction-versions` 里没有任何
真实内容，只有测试夹具，且已清理）。

**卡在：内容包。** 没有获批的示例照片与步骤，这条既无法证实、也无从检查。

**材料到位后**：在管理端内容库创建版本 → 发布 → 逐项核对。**零代码改动。**

**建议的结构性加固（未做）**：在发布路径上拒绝含禁止动作的指引内容（切割、压碎、刺穿、
焚烧、取出电池、复现冲击测试），把 D27 从"依赖运营不写错"变成"结构上不可能发布"。
这是唯一能让这一行不依赖内容包就成立的做法。

---

## 2. E2 部署 — **已关闭（自动进行，且已验证）**

每次 push 到 `main` 都会自动部署生产（GitHub 集成）。生产健康检查：

```
koi-recall-backend.vercel.app/v1/...   → 200
/dev/blobs/upload                      → 404   ← 开发端点未泄漏到生产
www.koiimprtinc.com                    → 200
admin.koiimprtinc.com                  → 200
```

`vercel --prod` 报 `Not authorized` 的原因：后端 `.vercel/project.json` **缺
`projectId`/`orgId`**（前端两个项目有）。不影响自动部署。

**需要你判断的一件事**：仓库**没有生产发布闸门** —— 任何 push 直接上线。是否要加评审
环节（只从 release 分支部署，或启用 Vercel 的 Deployment Protection / 预览环境）。

---

## 3. E4 真实启用 — 等业务材料（我不会伪造）

需要四项输入：**批准材料**（CAP / 书面协调）、**内容包**（步骤、示例照片、安全警告、
声明文案）、**证据保留期限**、**谁有权确认产品受影响**。

唯一的技术路径是插入一条声称"存在授权消费者处置的召回预期函"的 approval 记录。
**那封信不存在，我不会做。** 该表上的 CHECK 约束与黑暗发布机制存在的目的，正是让
"没有材料也能启用"在结构上不可能。

**代码侧已完备**：管理端内容库可创建/发布/撤回版本；保留期可在 `/disposal` 面板调整；
审核结果与例外申报的通知均已接通并验证。材料到位后全是运营动作。

**当前黑暗状态是成立的**：`disposal_instruction_versions` 为空 → 没有获批内容 →
不创建处置任务 → 真实消费者看不到 Page 4。

---

## 4. 生产写入核查 — **已关闭**

本地 `.env` 与生产 `DATABASE_URL` 是**同一个 Neon 库**，因此"回退到生产"的写入（若有）
必然落在同一张表里，可直接查证，不需要生产日志权限：

```
casesSinceSep22: 0        验证窗口内零案件
totalCases: 34            既有真实数据，未受影响
```

结论不是"我倾向没有留痕"，而是**共用库的后果已审计且干净**（清理见
`docs/disposal-acceptance.md` 的运行记录）。

---

## 已确立、无需重复调查的事实

- **黑暗发布成立**，且是本功能唯一的安全保证：无获批内容 → 无任务 → 无 Page 4。
- **处置代码已随 push 上线生产**，但功能是黑暗的；这不矛盾，是设计。
- 本会话修复的**生产级缺陷**（均已上线）：
  1. 一行无法解密的消费者 PII 会让整个案件详情接口 500（已改为显式降级）
  2. 写请求失败会**回退到另一个环境**（已改为只有读可回退）
  3. 写请求沿用读的 10 秒超时，而提交在开发环境实测需 15–17 秒 → 中止了服务端仍在完成的写入
     （已改为写 60 秒 / 读 10 秒）。**那个 15 秒的构成后来量过：主要是跨洲往返，不是应用本身**
     —— 见文末"提交延迟的归因"。
- **集成测试库守卫**：未显式设置 `ALLOW_REMOTE_INTEGRATION_TESTS=true` 时，拒绝对非本地
  库运行集成测试 —— 因为本仓库的 `DATABASE_URL` 就是生产库。

---

## 审查结案的实质依据（reportability ・ 2026-09-24）

`filed` 过去只要求一个 `cpscReference`，`filed_at` 由服务器时钟填入。于是"实报日期"其实是
"某人按下按钮的日期"：一笔迟到一周才补录的实报，读起来像当天报的；除了一串引用号，也没有
任何东西记录这次实报依据什么。规格要求 Filed 记录实质依据，改成了：

- **`filedAt` 由操作人填写**（ISO 8601；拒绝未来日期，但允许 26 小时时差——UTC+14 到
  UTC−12 之间，操作人那一天仍然可能是"今天"）。落库的是操作人给的日期，不是 `new Date()`。
  服务器时钟本来就有它的位置：`decisionAt`。两者含义不同，所以两者都留。
- **新增 `filing_evidence_encrypted`**（迁移 0024）：回执、确认函、提交凭证。加密落库，与
  `rationale` 同一套 AES-256-GCM 信封，并且**只写**——当前没有任何读路径返回它。谁能读一份
  实报回执是角色问题，属于 P1-B 结构化报告的设计范围；在这里顺手给新字段定一个 PII 层级，
  等于替那个决定做了选择。
- 服务端在缺任一项时拒绝（不代填）。管理端两个入口（案件详情、事故队列）已改为把这两件事
  问出来，而不是让服务端替操作人补一个日期。
- `scripts/seed-test-data.ts` 同步补上它自己编造的那份回执。

**验证**：隔离测试库已应用迁移 0024（列存在；约束 `convalidated = false`；迁移计数 24）。
`tests/reportability-filing.integration.test.ts` 直接绕过服务层写表，证明**新写入仍被约束
拒绝**，补齐回执后同一更新被接受——即 NOT VALID 只豁免历史行。单元层 11 项另见
`tests/reportability-filing.test.ts`。

**尚未闭环（不要当成已完成）**：

1. 约束是 `NOT VALID`。既有的 `filed` 行没有回执也不可能有了——该列此前不存在，为几个月前
   做出的安全决定补造依据就是捏造。要让它们也纳入约束，需要人工按原始卷宗回填，然后显式执行
   `ALTER TABLE reportability_reviews VALIDATE CONSTRAINT reportability_reviews_filed_chk;`
   在那之前，历史行的状态是"已知不合规但被豁免"，不是"合规"。
2. 回执写入后只能从数据库读，接口上不可见（原因见上）。

---

## 提交自动进入 `escalated`（P0-B 第二阶段 ・ 2026-09-24）

第一阶段让所有读路径都认识 `escalated`；没有任何东西写它。第二阶段是这次写入，放在开关
`INCIDENT_ESCALATED_STATUS` 之后，**默认关闭**——因为"读路径已部署"是它的前提，而在一个仓库
一次 push 的结构里，把这个前提写成默认值比记在某人的脑子里可靠。打开是配置改动，关回去是
完整回滚：`escalated` 是 `submitted` 的平行态，面向消费者的投影与它完全相同（都映射为
Received）。开关关闭时，状态判定与改动前**逐字节相同**。

**接线证据**（`tests/incident-escalation.integration.test.ts`，隔离库）：同一份受伤申报，
开关开 → `escalated` + `injury_hazard` + 审查 pending；开关关 → `submitted` + 审查 pending；
开关开但 `incidentAnswer='no'` → `submitted` + `standard` + 无事故、无审查。三条一起才证明
是**开关**在起作用，而不是"受伤申报本来就这样"。

### 两处与规格字面不一致 —— 已按"两个轴各归其位"处理（2026-09-28）

结论先说：**不需要在"产品核验"和"交给合规"之间二选一。** 这个仓库本来就有两个轴——

- `status`：案件走到了流水线的哪一步（triage / submitted / under_review / ...）
- **派生阶段**（`workflow/policy.ts` 的 `stageKey` → `STAGE_RULES`）：谁在处理它

而"派生阶段"里已经有一条合规覆盖规则：**只要事故审查还是 pending，案件就派生成
`compliance_review`（责任部门 = compliance）**，与 status 无关。规格 B1 说的"派生阶段为
compliance"就是这一条。所以：

1. **`unsure` 不需要进 `escalated`。** 它的 status 是 `triage`（产品待核验），派生阶段是
   `compliance_review`（安全待审）——同一时刻两个事实都在，任何一个都没被挤掉。测试里
   `puts an unsure injury submission with compliance while it stays triage for the product`
   钉的就是这一点。
2. **受伤申报不自动开 `case_escalations` 记录，这是对的。** 因为"关不了案"的自动保护**已经
   存在且覆盖所有状态**：`policy.ts` 的 `closure_review → closed` 要求审查不再是 pending
   （`BLOCKING_REASONS.REPORTABILITY_PENDING`），而每一起事故申报都会自动建一条审查。再自动
   开一条升级记录，等于要求操作人把同一个问题关两次（一次审查、一次升级凭证），不增加安全性。
   记录因此保留它真正的用途：**由人开启的、超出报告性问题的对外对话**（律师、监管、媒体），
   以及伤情本身升级成这类事情的时候 —— 这也是 `injury` / `battery_ingestion` 两个分类的含义。
   记录可以挂在审查上（`case_escalations.review_id` 已在表里）。

#### 顺带修掉一个真缺陷（这是这次最有价值的部分）

`escalated` **不在**上面那条覆盖集合里，而 `stageKey` 的末尾是 `return 'final'`。于是：

- 一个 `escalated` 且审查 pending 的案件 → 派生阶段 **`final`**（"没什么可做的了"），
  而它其实是**正在合规手里**；
- 审查关掉之后的 `escalated` 案件 → 同样是 `final`。

这正是规格自己警告的那类问题（"未知值不得当作 standard"）：新状态加进了枚举，读取方没有全部
认识它，而失败方向恰好是"看起来已完成"。修法：

- 覆盖集合补上 `escalated`（与 `triage` 同理）；
- `stageKey` 由 if 链改成 `switch`，`escalated` 显式落到 `submitted` 阶段（它的平行态），
  并且**穷尽性由类型保证**：末尾是 `const unhandled: never = state.caseStatus`，新增状态而没
  决定它的阶段就是编译错误，而不是一个悄悄读成"已终结"的案件。
- 这条守卫做了**变异检验**：往 `CaseStatus` 里塞一个 `quarantined_mutation_probe`，编译器立刻
  报 `Type '"quarantined_mutation_probe"' is not assignable to type 'never'`（同时
  `BASE_TRANSITIONS` 缺键也报错），恢复后干净。守卫是有效的，不是装饰。

---

## 审计元数据：把操作人的原话请出去（P1-B D2 前半 ・ 2026-09-24）

规格里那句"现状 `admin_audit_events.metadata` 是无约束 jsonb，且已有多处自由文本进入"是真的，
而且比预想的多。逐块清点后发现 **7 处把操作人写的整句话写进了这张表**：

| 位置                                | 键                   | 原话现在住在哪里                                  |
| ----------------------------------- | -------------------- | ------------------------------------------------- |
| `routes/admin.ts` 案件流转          | `note`（≤2000 字）   | 流转记录（并进消费者的邮件）                      |
| `routes/disposal.ts` 资格确认       | `note`               | `disposal_tasks.eligibility_note`                 |
| `routes/disposal.ts` 批次审查       | `rationale`          | `disposal_reviews.rationale`                      |
| `routes/disposal.ts` 放置 hold      | `note`               | `disposal_holds.note`                             |
| `routes/disposal.ts` 解除 hold      | `note`               | `disposal_holds.release_note`                     |
| `routes/disposal.ts` 撤回指引       | `reason`             | `disposal_instruction_versions.withdrawal_reason` |
| `modules/refund-exports/service.ts` | `purpose`（≤500 字） | `refund_export_batches.purpose`                   |

七处的共同点是：**原话在它自己的记录上已经有一份**，而审计表里那一份是唯一没有读权限把守的
一份（`admin_audit_events` 每个内部角色都能读）。所以处理方式是"不写第二份"，而不是"加密第二份"
——信息一点没少，少的是一个所有人都能看的副本。枚举与标识符照旧保留（例如放置 hold 的 `reason`
是枚举，留下；撤回指引的 `suspendedAuthorizations` 是计数，留下）。

**写入侧新增兜底**（`src/modules/staff/audit-metadata.ts`，接入 `DrizzleAuditService.record`）：
超过 200 字符的值在落库时被替换为 `[withheld: too long for the audit trail]` —— 留标记而不是静默
丢弃，审计员看得到"这里有东西被扣下了"，而不是读到一行看起来完整的记录。

**这条兜底的边界要说清楚：它不是散文过滤器。**"Refund issued after counsel confirmed it." 只有
40 来字符，照样通过。真正把散文挡在外面的是上面那七处不再写它；兜底只拦明显不是值的值（整段、
整个 dump）。测试里专门留了一条注释说明这一点，避免后来的人误以为有 200 字符上限就安全了。

### 键白名单已落地（2026-09-28）

上一节留下的"还没做"做完了。写入契约现在是
`AuditMetadata = Partial<Record<AuditMetadataKey, AuditMetadataValue>>` —— 34 个键逐一点名，
**没有索引签名**。新增一个键而不在这里登记就是编译错误。这是把"审计表里不放散文"从习惯变成规则
的那条分界：习惯正是当初七个调用点把整句话写进去的原因。

- **完整性由编译器证明**：收紧类型后 tsc 报出的每一处都是真问题（见下），修完 tsc 干净，说明代码
  里不存在未登记的键。清单里也没有"登记了却没人写"的死条目（我逐块核对过；用脚本核对时脚本自身
  的解析有噪声，那不算证据）。
- **类型立刻抓出两处真问题**：
  1. 案件流转的审计行写的是 `body.status` —— **未经验证的 `unknown`**，而不是白名单校验通过的
     `nextStatus`。也就是审计行记的是原始请求值，不是案件实际迁到的状态。已改用 `nextStatus`。
  2. 我自己上一轮写的兜底测试用的是 `note` 这个键：类型一收紧它直接编译失败，改用清单内的
     `assertedReviewerId` —— 现在是"用真键测真约束"。
- **两个条目留给下次修订时再看一眼**（注释已写在 `audit-metadata.ts`）：
  `fileName` 可能含人名，留着是因为审计表**不是新的泄露信道**（能读审计表的角色同样能读案件详情
  的文档列表，那里显示同样的名字；真关掉它要改文档列表，而不是从这个键上删）；
  `assertedReviewerId` 来自旧 admin key 的请求体、是调用方给的文本，长度上限兜住它且只有旧路径写。
- **两向都做了变异检验**：往调用点加未登记的键 → 编译错误；把禁用键塞回白名单 → 那条
  `@ts-expect-error` 变成"未使用"→ 编译错误。守卫不是装饰。

---

## 部署事实核对（C4 的第一半 ・ 2026-09-24）

规格要求"`INCIDENT_STRICT_VALIDATION` 的实际部署值必须核实，不得以代码默认值当部署事实"。
查法以前是看仓库里的 `.env.*` 快照——那是推断，不是核实。这次直接读了部署环境本身：

```
npx vercel env ls production      # 只读；项目 genkiyancub-8961s-projects/koi-recall-backend
```

**结论：生产环境的生产环境变量里没有任何 `INCIDENT_*` 变量，也没有 `DISPOSAL_*`。** 因此生效的是
代码默认值：

- `INCIDENT_STRICT_VALIDATION` → **false**（结构化事故字段是可选，不是必填）
- `DISPOSAL_EVIDENCE_RETENTION_DAYS` → 未设置 → null（证据不设保留期，与设计的默认一致）
- `INCIDENT_ESCALATED_STATUS` → 未设置 → **false**（P0-B 第二阶段在线上是关闭的，符合预期：
  开关必须是有人刻意打开才生效）
- `LOCAL_BLOB_DIR` → 未设置 → 走 Vercel Blob 适配器

所以 C4 的另一半——"旧客户端兼容策略确认后再启用严格必填"——现在的状态是：**严格必填未启用**，
且启用它是一个写环境变量的动作，不需要改代码。

**另一处值得你过目的部署事实**：生产设置了 `ALLOW_SYNTHETIC_SEED`。它存在（不是"未设置"），
所以线上是允许合成种子写入的——这也解释了此前看到的 34 个案件。这是有意还是留在了演示状态，
由你判断；我没有改动它。

---

## 提交延迟的归因：那 15 秒是网络，不是应用（2026-09-28）

上面第 3 条当时写的是"提交实际需 15–17 秒"。那是**开发机跨洲**测出来的，没人量过它的构成。
今天量了（只读、打隔离测试库、20 次采样）：

| 操作                           | 耗时                         |
| ------------------------------ | ---------------------------- |
| 单条语句（开发机 → us-east-1） | 均值 **274ms**（最快 222ms） |
| 一次交互事务（1 条语句）       | 均值 **999ms**               |
| 事务内每多一条语句             | **248ms**                    |

提交路径的**一个交互事务里有 17 条语句** → 在这个往返成本下约 **5.4 秒**，其余是夹具准备与断言
读取。所以那 15 秒里绝大部分是**每次往返 250–275ms 的跨洲延迟**；生产与数据库同区
（Vercel + Neon），同样十几次往返是**几十毫秒**级。

结论，以及要改的记录：

- **写 60 秒的决定不变**：一个写请求不该在第 10 秒被中止，这个理由本身成立。
- 但**它的理由要改**：不是"应用需要 15 秒"，而是"一次写入包含十几次往返，需要一个不轻易中止的
  上限"。前者我当时并没有证据。
- 因此**不建议**基于这个数字做应用层优化（合并往返、分批）。先要的是**同区内的真实数字**，那需要
  给提交路径加分段计时 —— 目前完全没有度量。这是仍然开着的第 4 项。
- 附带代价：集成套件跑在这个远程隔离库上，每次提交十几秒，一次完整回归因此很慢。方案 0.2 原本
  要的是**本地** Postgres（docker-compose），正是为了避免这个；这台机器上**没有 docker**，所以
  隔离库落在 Neon 上 —— 这是有代价的折中，不是等价选择。

---

## 提交路径有了分段计时（优化 4 ・ 2026-09-28）

这一项的目的一开始就写清楚了：不是"优化慢代码"，而是**先能看见**。仓库里 `SafeLogFields` 早就声明了
`elapsedMs`，但**没有任何地方写过它** —— 也就是说在这之前，这个平台完全没有请求计时。

现在每次提交打一行结构化日志，三段：

```
{"level":"info","message":"Claim submission timed","caseReference":"KOI-...","prepareMs":1,"transactionMs":8466,"elapsedMs":8467}
```

- `prepareMs`：事务之前的本地工作 —— 校验、规范化哈希、幂等 HMAC、整份载荷的 AES 加密。
- `transactionMs`：那一个交互事务（里面 17 条语句）。
- `elapsedMs`：整个调用。三者同一时钟，所以 `elapsedMs === prepareMs + transactionMs` 精确成立，
  测试就钉这一条不变量（数字本身是输出，不是断言对象）。
- `errorCode` 出现即表示这次尝试**失败**；级别仍是 `info`，因为被驳回的提交是常态，而真正异常的
  东西已经由应用的错误处理器记了。
- `replayed: true` 只覆盖**第三条**重放路径（唯一键冲突在提交时才浮现的那条）。另外两条更常见的
  重放是在事务内部直接 `return` 已存响应，所以它们记成成功 —— 测试里写明了这一点，免得以后有人
  以为"重放会被标出来"。

**第一份数据（跨区，因此仍然不是生产数字）**：`prepareMs` **0–1ms**，`transactionMs` **7.7–10.6s**。
这有两点价值：一是确认了**本地工作（含加密）可以忽略**，应用层没有可优化的东西；二是把成本完整地
落在事务的往返上，与前面那次归因一致。**同区的真实数字要等部署后从日志里读** —— 这份计时的意义
就是让那时有人能读。

**顺带记录一个不稳定的测试**：`opens both real PostgreSQL transactions before releasing concurrent work`
在一次全量运行里以 `Concurrent test gate timed out waiting for participants` 失败（另一次通过）。它的
等待预算（7 秒）是按本地库定的，而这个隔离库在另一洲（每条语句 ~250ms）。这不是本次改动引起的，
但会让完整回归偶发变红，值得单独处理。

---

## `submit` 拆出了三块纯逻辑（优化 2 ・ 2026-09-28）

`submit` 原本 559 行，编排和规则混在一起。这一轮**只抽纯函数部分**，不重写事务编排。抽走三块：

| 新模块                       | 抽走的规则                                    | 为什么是它                                                                                            |
| ---------------------------- | --------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `submission-status.ts`       | 首个状态、`hasIncident`、子类型               | 唯一决定案件初始状态的地方；优先级不显然（产品核验压过升级），而此前只有真库提交才能碰到它            |
| `evidence-requirements.ts`   | 文档可提交性 + 证据数量规则（含订单匹配豁免） | 真业务规则，此前同样只能靠提交验证。"豁免只免 proof-of-purchase 的最小值、不免上限"这类细节值得直测   |
| `submission-notification.ts` | 确认邮件的变量组装                            | 面向消费者的文案，且受渲染器约束（无条件分支、占位符未解析即拒发）—— 这个约束很容易被后来的人无意破坏 |

`submit` 现在 **507 行**（少 52 行）。新增直测 **32 项**（`submission-rules` 25 项、
`submission-notification` 7 项）：这些规则第一次能不经数据库被测。

**刻意没做的，写清楚**：事务编排本身（17 条语句、幂等插入、事件与通知入队）仍在 `submit` 里。继续拆它得把
`tx` 和十几个局部值在函数之间传递，那是"重写"而不是"抽纯函数"，风险性质不同。到此为止是选择，不是遗漏。

顺带一处类型选择值得记：`claimConfirmationVariables` 返回**类型别名**而不是 `interface` —— 别名带隐式索引
签名，所以既满足邮件队列的 `Record<string, string>`，调用方与测试又能按名字取字段（`interface` 不带隐式索引
签名，会逼出 `!` 或下标访问）。

---

## 两份公开状态映射合成一份（优化 3 ・ 2026-09-28）

`workflow/policy.ts` 的 `publicStatus` 与 `cases/public-status.ts` 的 `mapToPublicCaseState` 是**同一个
事实的两份实现**：前者挂在 admin 的 workflow 快照（`evaluate()`）上，后者是消费者 API（状态查询与
consumer-auth）真正在用的那套，且有专测。逐项比对后，两份**已经在三处分叉**：

| 状态                          | 快照（旧）               | 消费者 API            |
| ----------------------------- | ------------------------ | --------------------- |
| `approved` + 处置已外部完成   | `resolution_in_progress` | `resolution_approved` |
| `closed`（无已批/已完成处置） | `completed`              | `closed`              |
| `duplicate`                   | `closed`                 | `not_approved`        |

`duplicate` 那条最值得说：操作员看到"已关闭"，而消费者被告诉"未通过"。

**做法**：删掉快照里那套 switch，让它调用唯一的实现，字段类型也随之收紧为契约类型 `PublicCaseStatus`。
不构成运行时环 —— `cases/submission-status.ts` 对 policy 只有 type-only 导入，运行时被擦除。
`PUBLIC_STATUSES` 常量随之无人引用，已删除；测试改为直接断言消费者 API 返回的字面量。

**这次合并本身发现的缺口（已记录，未擅自改）**：`approved` 且处置已 `externally_completed` 时，消费者
映射一律给"已批准"，要等操作员把案件推进到 `closure_review` 才变成"进行中"—— 也就是消费者在"补发已经
在路上"的窗口里看到的仍是"已批准"。这**不是被测试钉住的决定**（权威实现只为 `status: 'approved'` 写过
断言），而旧快照在这里用的正是"进行中"，词汇表里也确实有更贴切的标签。但它**改变消费者可见输出**，
所以没有顺手在重构里改：要么确认是缺口、单独改（含消费者文案核对），要么确认现状可接受。快照现在忠实
反映消费者视图，而不是持有第二种意见 —— 那才是这个字段的承诺。

---

## 字段规则：代码**已经**强制的那一半（2026-09-28）

规格把"字段规则"列为需要合规给的东西。给之前，先把**当前已经强制**的规则盘出来 —— 这样合规要做的
是"确认或修改"，而不是从零写。以下都是代码里跑着的，不是提议：

| 规则                                                                                           | 在哪强制                                                                                                                                                           |
| ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `incidentDetails` 必须与 `incidentAnswer` 一致：非 `no` 时必填、为 `no` 时必须省略             | 契约（`contracts/claims.ts` 的 refine）                                                                                                                            |
| `narrative` 10–4000 字符                                                                       | 契约                                                                                                                                                               |
| `eventTypes` 出现时至少 1 个                                                                   | 契约                                                                                                                                                               |
| **`medicalTreatment` 对 injury / illness 事件必填**                                            | 契约（A4 走查时被它当场纠正，所以现在才知道它已存在）                                                                                                              |
| `usedAsIntended`、`unitType`、`failureMode`、`medicalTreatmentReceived` 四个结构化字段**必填** | 服务层，仅在 `INCIDENT_STRICT_VALIDATION=true` 且 `incidentAnswer='yes'` 时；`unsure` 故意不强制（那是消费者说"我确认不了"，强制它恰好会挡掉合规最需要看到的申报） |
| 证据类别的最小/最大份数                                                                        | 服务层，按**钉住的活动版本**的 `campaign_evidence_requirements`                                                                                                    |
| 订单精确匹配可豁免 **proof_of_purchase 的最小值**，**不豁免上限**、也不豁免其它类别            | 服务层（`assertEvidenceRequirements`，本轮已抽出并直测）                                                                                                           |
| 文档必须 `verified` 且扫描干净；`MALWARE_SCAN_REQUIRED=false` 时 `not_run` 可接受              | 服务层（`assertDocumentsSubmittable`）                                                                                                                             |
| 两项同意（隐私告知 + 信息准确）必须勾选                                                        | 契约（`accepted: true`，至少 2 项）                                                                                                                                |
| 换货必须给当前收货地址；退款可省略                                                             | 服务层（按处置方式判定，`requiresMailingAddress`）                                                                                                                 |

**合规需要定的是"改什么"**：哪些该更严（例如 `unsure` 是否也要结构化字段）、哪些组合应判为矛盾
（例如同时报"无伤害"与"就医"）、以及历史缺失该怎么表述。上面这张表是把讨论的起点从零挪到"逐条确认"。
