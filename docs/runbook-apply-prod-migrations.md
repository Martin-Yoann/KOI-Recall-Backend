# Runbook：生产库迁移应用（BUG-0 修复 · 2026-09-29）

> **状态：待执行。** 需要生产 `DATABASE_URL`（本机没有凭据），且按仓库纪律生产迁移需单独授权——本文档就是那份授权的执行清单。
>
> **故障背景**：2026-09-29 发现生产库落后于已部署代码（缺 0024–0027，至少 0026）：事故申报直接 500（`b942c2ed`），管理端案件列表/详情对所有案件 500（`21c8355d`、`a2e941ff`）。根因：push 自动部署只发代码，从不跑迁移，而 0024–0026 的列已被线上代码读写。

## 执行步骤（按序，全部在能连生产库的环境）

### 1. 漂移检查（只读，确认现状）

```
DATABASE_URL=<prod> pnpm db:drift-check
```

预期输出缺失迁移清单（应为 `0024_…`、`0025_…`、`0026_…`、`0027_…` 中的若干个）。把完整输出贴进验收记录。

### 2. 0027 前置审计（只读）

0027 给 `disposal_declarations` 加每任务唯一索引。若存在同任务多条声明，迁移会**创建失败而非删数据**——先确认：

```sql
SELECT task_id, count(*) FROM disposal_declarations GROUP BY task_id HAVING count(*) > 1;
```

预期零行。若非零：停止，人工核对这两条声明哪条是事实，再决定处理方式（不得让迁移自动删除）。

### 3. 应用迁移

```
DATABASE_URL=<prod> pnpm db:migrate
```

drizzle 会按序补齐所有缺失迁移（含 0024 filing evidence、0025 other 说明加密列、0026 审查案件化回填、0027 声明唯一索引）。0026 含回填（先加列→回填→收紧 NOT NULL），非空表不会中途失败。

### 4. 复核（全部应通过）

```
DATABASE_URL=<prod> pnpm db:drift-check        # all N migrations applied
```

- 事故申报恢复：浏览器提交一份**带事故**的测试申报（demo 活动）→ 201，案件自动带 `reportability_reviews` pending。
- `GET /admin/cases?status=submitted` → 200；任一案件详情 → 200。
- 消费者 lookup 与处置页不受影响（迁移前后行为不变）。

### 5. 顺手验证本轮代码修复（与迁移相互独立）

- 处置页上传照片 → 不再报 "Evidence category 'disposal_evidence' is not accepted by this campaign."（BUG-3 已在代码层修复，随本部署生效，无需迁移）。
- 管理端指引库列表的 Approvals 计数（BUG-1 的观察点）。

## 后续防复发（本次已随代码交付）

- `pnpm db:drift-check`（只读）可在任何环境执行；**建议纳入发布前检查**：部署后跑一次，缺失即告警。是否升级为部署流水线强制门禁（或在 API 启动时自检并告警）待产品决定。
