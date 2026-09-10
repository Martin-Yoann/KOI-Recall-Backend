# ADR-0005：强制状态流转不豁免消费者告知义务

- **状态**：Accepted（2026-09-10 实施，随 `新增6个触点` 触发点批次落地）
- **日期**：2026-09-10
- **决策者**：技术（评审结论：ADMIN 静默驳回为行为空洞，产品语义上不可接受）
- **关联**：ADR-0004（Staff RBAC——ADMIN 角色与 bypass 语义的来源）；`docs/superpowers/specs/2026-08-18-remedy-workflow-refund-export-design.zh-CN.md` §8.2（状态流转加锁与消费者通知）；触发点目录 `src/scripts/verify-all-triggers.ts`

---

## 1. 背景

触发点 02/04/07/08 打通后（提交 `b3a0b01`），状态流转的 note 同时承担两个角色：

1. **内部审计字段**——`case_events.data.note`；
2. **消费者邮件正文**——need_info 的补充材料指引、rejected/duplicate 的驳回理由、withdrawn/force-closed 的关闭原因。

原实现对两者一刀切：路由与服务层均以 `guard.role !== 'ADMIN'` / `!bypassWorkflow` 豁免 note 必填校验。而 `resolveCaseStatusEmail` 对无 note 的理由型状态返回 null（fail-silent，不编造理由）。两规则叠加产生空洞：**ADMIN 无 note 强制流转到 rejected / duplicate / withdrawn / closed（无已完成救济）时，案件正常进入终态，消费者收不到任何邮件**——申请从消费者视角无声死亡。前端 `REASON_REQUIRED` 的客户端拦截不是契约边界，且 `closed` 在前后端两层都漏出了清单。

## 2. 决策

**bypass（强制流转）只豁免 workflow 状态矩阵校验，不豁免消费者告知义务。** 理由型流转无论角色、无论是否 forced，note（≥10 字符）一律必填；服务层校验为准（路由保留快速失败）。

- "哪些状态需要理由"收敛为单一事实来源：`case-status-emails.ts` 的 `transitionRequiresReason(nextStatus, resolutionStatus)`——它与"哪个状态发哪封邮件"是同一份知识的两个面。
- `closed` 的理由要求取决于 resolution 行：救济已 `externally_completed` 的关闭发 `case_completed`（模板不含理由，无需 note）；其余关闭（含 forced）渲染 closureReason，必须给 note。
- `resolveCaseStatusEmail` 无 note 返回 null 的行为保留，作为不发"无理由决策邮件"的最后防线（正常路径已不可达）。

## 3. 后果

- ADMIN 仍可强制流转任意状态（含绕过 workflow 矩阵），但凡流转到消费者可见的理由型终态必须给出会进入邮件正文的原因。
- 对 admin 前端：`cases/[id]` 页同步收紧——理由输入长度对齐后端 ≥10，`closed`（无已完成救济）纳入必填。
- 违规响应：路由 422 `validation-error`（快速失败）；直调服务层为 `ClaimValidationError`（422）。两者消息文案一致，由 `transitionReasonRequiredMessage` 统一。
- 已知残余：非事务版 `registry.services.admin` 同样暴露 `transitionCaseStatus`，仅靠调用纪律（路由唯一入口在 `adminTransactions.run` 内）保证事务性，无编译期防护——见评审记录，待后续以接口收窄解决。
