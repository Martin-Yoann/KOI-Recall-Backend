# 四个未决事项 — 当前状态

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
  3. 写请求沿用读的 10 秒超时，而提交实际需 15–17 秒 → 中止了服务端仍在完成的写入
     （已改为写 60 秒 / 读 10 秒）
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

### 两处与规格字面不一致，需要你确认（我没有替你决定）

1. **`unsure` 仍进 `triage`，不进 `escalated`。** 规格 B1 写的是"Yes/Unsure 提交 → 新状态
   escalated"。但状态只能存一个，而 `unsure` 在当前状态机里的含义是"消费者无法确认涉事产品"
   ——产品未核验的案子合规无从下手（核验是 triage 的活）。所以我的实现是"产品优先级高于升级"：
   只有 `yes` 且产品全部 potential_match 才进 `escalated`。若你要按规格字面走，需要先回答
   `unsure` 的案子在产品核验之前交给合规，是否可接受。
2. **受伤申报不会自动建 `case_escalations` 记录。** 规格 B1 说的是**状态**，B3/B4 说的是
   **记录表**（分类为 legal / regulator / media 等，由人开启、关闭时必须写凭证）。二者名字相近
   但含义不同：状态=合规正在看，记录=案件已在某个对外对话里（律师、监管、媒体）。因此结案门禁
   （有未关闭升级记录则不得关案）**不适用于**仅仅状态为 `escalated` 的案子。如果规格的原意是
   "受伤申报也应自动开一条记录并受门禁约束"，那是一处实质改动，请确认。

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

**尚未闭环**：写入侧的**键**白名单还没做（现在只约束了值的长度）。要做的话应当做成编译期类型
（`metadata` 的键收成一个联合类型），让新增一个键必须经过一次刻意的修改——这在 21 个调用点上
都有编译错误，适合单独一次改动，不适合塞进这次。
