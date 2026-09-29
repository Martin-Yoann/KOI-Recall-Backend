# Disposal 缺口修复 浏览器级验收用例

> 用途：对 2026-09-29 第二轮处置缺口修复做浏览器级验收。基线是三仓库提交：API `5b12df7`、Admin `4aa514b`（及其后撤销提示文案修正，见第 9 节备注）、Front `ff857c0` 或其后代。本轮修复内容：消费者证据删除/重试、审核人识别要求清单、单任务撤销许可、`disposal.issue_authorization` 展示条件与硬门禁对齐、声明每任务唯一索引（迁移 0027）、hold 原因回显、Refresh 刷新任务状态。用例编号 TC-xx，"关联"列映射[原方案 D01–D29](superpowers/plans/2026-09-20-disposal-instructions-remediation.zh-CN.md)与[09-28 继续计划](superpowers/plans/2026-09-28-disposal-instructions-remediation-continuation.zh-CN.md)。执行纪律与已知缺口见文末——**通过本套不等于 D01–D29 全部关闭**。

## 1. 环境与前置条件（不满足则不开测）

| # | 前置 | 说明 / 核对方法 |
| --- | --- | --- |
| P1 | 三端同版本部署到测试环境 | API、消费者端、管理端构建自上述提交；记录构建版本与部署 URL。**禁止**用本地 `.env` 直连生产库跑验收 |
| P2 | 测试库已应用迁移 0000–0027 | 0027（`disposal_declarations_task_uidx`）执行**前**先跑只读审计：`SELECT task_id, count(*) FROM disposal_declarations GROUP BY task_id HAVING count(*) > 1` 预期零行；执行后抽查索引存在。生产库不在本套范围 |
| P3 | 处置"点亮"夹具就绪 | 与黑暗验收不同，本套需要真实可用的处置内容：管理端 `/disposal-instructions` 创建指引版本（步骤/示例图含替代文本/安全警告/识别要求≥3 条，记录识别要求原文备用）→ 录入批准材料 `recall_expectation_letter` + `consumer_held_product` + `consumer_disposal`（可留空有效期）→ Publish。记录版本号 |
| P4 | 两个后台账号 | COMPLIANCE（持 `disposal.review`/`disposal.hold.manage`/`disposal.instructions.publish`）与 MANAGER（三者皆无）各一，可登录管理端 |
| P5 | 本地 Blob 显式启用 | `LOCAL_BLOB_DIR` 已设置，浏览器预检（OPTIONS/PUT 对本地上传路径）通过——curl 成功不代表浏览器 CORS 通过。TC-03 另需 DevTools Network Request Blocking |
| P6 | 邮件模板就绪 | `claim_confirmation` ≥ v6（含 `{{disposalSection}}`）、`disposal_update` 已安装；测试环境无投递时以 outbox 入队为证据 |
| P7 | 数据纪律 | 全部虚构消费者/照片；照片用本地生成的图片文件，不用任何真实消费者材料；测试后不清理需留证的任务 |
| P8 | 工具 | 浏览器 DevTools（Network 看请求、Request Blocking 造失败、Application 看 token 会话）；DB 只读查询通道（核对写入结果） |

**消费者端页面**：申报表单 `/recalls/[slug]`、处置页 `/recalls/[slug]/disposal/[taskId]`（token 走 URL fragment，首次进入即消耗）。
**管理端页面**：处置队列 `/disposal`、指引库 `/disposal-instructions`、案件详情 `/cases/[caseReference]`（含 Disposal 面板）。

**进入处置页的标准路径**（各 TC 复用）：消费者在 `/recalls/[slug]` 完成无事故申报（产品可核验）→ 提交响应含 `disposal.taskId` → 从入队的确认邮件 payload 里取 resume URL（含 `#token=…`）→ 打开即进入处置页。任务编号不得被当成 Case ID 使用。

## 2. 测试数据（虚构）

| 夹具 | 内容 | 用途 |
| --- | --- | --- |
| 消费者 A | 虚构姓名/邮箱，产品带可核验标识 | 已确认受影响主路径 |
| 好照片 2 张 | 本地生成的清晰 JPEG/PNG（内容随意，如纯色+文字） | 正常上传、送审 |
| 坏照片 1 个 | 一个文本文件改扩展名为 `.jpg` | 触发 mime_mismatch 拒绝（若本地 reconciliation 不产生 rejected，见 TC-02 备注） |
| 识别要求原文 | P3 创建指引时填写的 recognitionRequirements 列表 | TC-10 与消费者页/管理面板两处比对 |

## 3. G1 消费者照片：上传、删除与恢复

**TC-01 好照片基线：上传→技术通过→送审** `关联 D06`
1. 标准路径进入处置页，Add photos 上传好照片 1 张。
2. 预期：行内状态 Uploading → Checking → **Passed our checks**；出现 "Send for review" 且可点；页头说明"通过检查≠被接受"文案仍在。
3. 点 Send for review → 出现 "Sent for review…" 与 "Your photos are with our team for review" 横幅。
4. 记录：三态截图、提交响应、DB `disposal_evidence_batches` 新行 `review_status='pending'`。

**TC-02 被拒照片可删除并解锁送审（本轮核心）** `关联 修1；D06/D07`
1. 新任务（或 TC-01 需补交后的任务），上传坏照片。
2. 预期：行显示 **Rejected** 与 "The file type did not match what was sent."；"Send for review" 禁用；下方提示改为 "…Use Remove on any that were rejected, then add them again."。
3. 该行出现 **Remove** 按钮（仅 rejected/expired/uploading 行有）→ 点击 → 行消失、提示消失。
4. 再传好照片 → Send for review 恢复可用 → 送审成功。
5. 服务端旁证（DevTools fetch）：对已删除照片的 documentId 重放 `DELETE /v1/disposal-tasks/{taskId}/documents/{documentId}`（带 `X-Disposal-Token`）→ 404/422 均可接受，但不得 204 二次成功。
6. 记录：删除前后截图、DB `document_uploads.upload_status` 变为 `deletion_pending`。
7. 备注：若本地 reconciliation 未产生 rejected 行，改为在测试库直改一行 `upload_status='rejected'` 后刷新页面继续 3–5。

**TC-03 悬挂 uploading 行可删除（恢复路径）** `关联 修1；09-28 Review Focus 4`
1. 新任务，DevTools → Network → Request blocking 屏蔽本地上传路径（如 `*/dev/blobs/upload*`）。
2. Add photos 选好照片 → 授权成功但传输失败 → 行卡在 **Uploading**，页面出现错误提示。
3. 预期：该行有 **Remove** → 点击后行消失；解除屏蔽，重新上传同文件 → 正常走到 Passed our checks。
4. 记录：卡住与恢复两态截图。

**TC-04 已送审照片不可删除（UI 与 API 双侧）** `关联 D22；修1`
1. TC-01 送审后（pending review）回到处置页。
2. 预期：照片行仍列出，但**无** Remove、**无** Add photos（送审后 `maySubmitEvidence=false`，按钮随门禁消失）。
3. 服务端旁证：DevTools 对批次内照片重放 DELETE → 422 problem+json，detail 含 "cannot be removed"。
4. 记录：页面截图、422 响应。

**TC-05 已接受照片同样不可删除** `关联 D09（冻结项的现状边界）；修1`
1. 管理端接受该批次后回处置页。
2. 预期：照片行无 Remove；横幅 "Our team accepted your photos."；API 重放 DELETE → 422。
3. 记录：截图、响应。

**TC-06 Refresh 同时刷新审核状态（无需整页重载）** `关联 观察项；D18 续填体验`
1. 消费者打开处置页（photos pending），保持不刷新。
2. 管理端另一会话接受照片。
3. 消费者点 **Refresh status** → 预期：**不重载页面**即出现 accepted 横幅；Network 面板可见一次任务 GET 200 与一次文档列表 GET 200。
4. 记录：点击前后同页截图、Network 截图。

## 4. G2 审核人识别清单

**TC-10 面板显示 Photo checklist 且与消费者页一致** `关联 修2；方案 §6`
1. 任务有 pending 批次，COMPLIANCE 打开案件详情 Disposal 面板。
2. 预期：照片审核区上方出现 "Photo checklist · instructions v{P3 版本号}"，逐条列出 P3 录入的 recognitionRequirements。
3. 另开会话以消费者身份看处置页的 "photos must show" 识别要求 → 两处内容一致（同一来源）。
4. 记录：两处截图并排。

**TC-11 hold 期间清单仍可见（关键语义）** `关联 修2；D12`
1. 对该任务放置 hold（compliance investigation）。
2. 预期：管理面板 checklist **仍在**（审核人需要核对清单）；消费者页处置指引**不可见**（暂停横幅替代）。
3. 记录：两端截图。

**TC-12 指引撤回后清单仍可见** `关联 修2；D15`
1. 指引库 Withdraw 该版本（理由≥10 字）。
2. 预期：面板 checklist 标注 "(withdrawn — photos still need deciding)" 且仍列出清单；消费者页无可执行指引。
3. 记录：两端截图、撤回返回的 suspendedAuthorizations 数。

## 5. G3 许可与撤销

**TC-20 签发基线** `关联 D08`
1. 走完：确认产品 → 资格 confirmed → 批次 accepted → 面板点 **Issue permission to dispose**。
2. 预期：成功；面板 Permission 卡显示 **active**；消费者页 "Permission to dispose: Given"。
3. 记录：DB `disposal_authorizations` 行 status=active + items 覆盖正确产品数量。

**TC-21 撤销控件的出现条件与理由门槛** `关联 修3`
1. 无许可任务的面板 → 无 Revoke 控件。
2. TC-20 的任务 → 出现 Revoke 区；理由 <10 字时按钮禁用。
3. 记录：两态截图。

**TC-22 撤销执行与消费者感知（P0）** `关联 修3；D15/D20 语义`
1. 对 TC-20 任务填理由（≥10 字，如 "Issued against a withdrawn approval basis."）→ Revoke permission。
2. 管理端预期：面板 Permission 显示 **revoked**；Revoke 控件消失。
3. 消费者端（原标签页点 Refresh 或重开 resume 链接）预期："Permission to dispose: **Withdrawn**"；完成声明控件消失、例外声明（"I had already disposed of it…"）出现；页面**不**出现倒签许可的表述。
4. 通知：outbox 出现 `disposal.permission.revoked` 一条，payload 含 updateSection（"no longer applies"措辞）且**无** `#token=`。
5. 审计：`admin_audit_events` 一行 `action='disposal.authorization.revoke'`、metadata 含 authorizationId、**不含**理由原文（理由在 `disposal_authorizations.revoke_reason`）。
6. 记录：两端截图、四项 DB 查询结果。

**TC-23 撤销后重签（门禁对齐行为的钉子）** `关联 修3 的 policy 变更`
1. TC-22 之后（许可 revoked、批次仍 accepted、资格/批准/无 hold 均成立）刷新面板。
2. 预期：**Issue permission to dispose 再次出现**（"无在 force 许可"即满足；与硬门禁一致）→ 点击 → 签发成功，消费者页回到 Given；同一时刻只有一条 active。
3. 语义说明：重签在签发时刻重新过全部门禁（批准被撤回/任务关闭等场景按钮不会出现——可在 TC-22 前把批准 `effectiveUntil` 改为过去后重刷面板，验证按钮**不**出现）。
4. 记录：两态截图、DB 新 active 行。
5. ⚠ 若合规后续裁决"撤销后必须新照片才能重签"，本例与策略需一并修订，不得只在 UI 隐藏按钮。

**TC-24 MANAGER 不能撤销** `关联 D16`
1. MANAGER 会话打开同案件面板 → 无 Revoke 控件（也无签发/审核控件）。
2. DevTools 直接 fetch `POST /admin/disposal-tasks/{taskId}/authorization/revoke`（body 带合规理由）→ 403；审计出现一条 denied 行。
3. 记录:截图、403 响应。

**TC-25 撤销幂等：审计只留一条（API 级重放）** `关联 D17/D24`
1. TC-22 成功后，DevTools 原样重放同一撤销 POST。
2. 预期：仍 204（幂等），但 `disposal.authorization.revoke` 的 success 审计**仍只有一条**，`disposal_authorizations` 无第二行变化。
3. 记录：重放响应、审计计数查询。

## 6. G4 hold 原因回显

**TC-30 手工 hold 的原因显示** `关联 修5`
1. 面板放置 hold：`compliance_investigation`（备注≥10 字）。
2. 预期：`/disposal` 队列该行徽章 **Held for compliance**；案件面板 Permission 卡显示同一原因（不再是泛化的 "evidence on hold"）。
3. Release hold 后徽章消失。
4. 记录：放置/释放两态截图。

**TC-31 事故自动 hold 的原因** `关联 D12；修5`
1. 消费者提交一份**带事故**申报（同 A16 套 TC-02 材料），任务自动建立。
2. 预期：队列徽章 **Held for an incident**（自动保留，无人按下）；面板同理。
3. 记录：队列截图、DB `disposal_holds` 行 `placed_by_staff_user_id IS NULL`。

**TC-32 原因不泄漏给消费者** `关联 修5 的边界`
1. TC-30/31 hold 中的任务，消费者看处置页。
2. 预期：仅通用暂停横幅（"This step is paused. … Please do not dispose of anything yet."）；**不出现** "compliance investigation"/"incident" 等内部措辞。
3. 记录：截图。

## 7. G5 通知一致性

**TC-40 处置通知入队且不含凭据** `关联 D24；修3`
1. 汇总核对 TC-01/06/22 触发的 `disposal_update` 通知：接受（photos passed）、补交（need different photos）、撤销（no longer applies）各一条。
2. 预期：deduplicationKey 互不相同且与事件对应；payload 一律**无** `#token=`、无 token 明文。
3. 记录：outbox 查询结果。

## 8. 环境矩阵

| 环境 | 条件 | 必跑 |
| --- | --- | --- |
| 本地 Blob | `LOCAL_BLOB_DIR` 设置 | 全部 TC（TC-02/03 依赖本地传输路径） |
| 真实 Blob（测试环境） | Vercel Blob + 回调 | 复跑 TC-01/02/04/06（浏览器 CORS 与回调链路）；TC-03 的屏蔽目标改为真实上传域名 |

无开关变量；`DISPOSAL_EVIDENCE_RETENTION_DAYS` 保持未设置（retentionUntil=null，即"保守保留"），TC-04/05 依赖该默认。

## 9. 已知缺口（本套**不可**宣称关闭的验收项）

- D09（已接受照片替换规则）与 D18（提交前审核时序）**冻结待合规**；TC-05/TC-23 只钉现状边界，不是裁决。
- 6 个新数据库集成用例（删除、撤销正反例、声明唯一索引）未在隔离库执行——本套浏览器证据**不替代**它们。
- 迁移 0027 仅测试库范围；生产应用与前置只读审计另行执行。
- TC-23 钉的是"重签重新过门禁"的当前设计；合规若要求新照片，需同轮修订 policy 与本例。
- Admin `4aa514b` 中撤销提示原文写 "a new permission needs newly accepted photos"，与门禁行为不符，已修正为"重签时重新核验全部门禁"；执行本套时确认管理端为修正后文案。
- D23 完整无障碍（读屏/键盘/移动端专项）属原方案套件，本套只在各 TC 中顺带走键盘可达。
- 生产部署虽已上线本轮代码，但处置功能仍黑暗（无获批内容不建任务）；本套全程在点亮夹具的测试环境执行。

## 10. 通过标准与记录模板

每个 TC 一行记录：

| TC | 结果(P/F/Skip) | Task/Case Reference | 环境版本 | 证据(截图/HAR/DB查询) | 备注 |

- P 判定以**预期列全部成立**为准；截图不单独构成通过依据，关键断言须有 DB 查询或响应 JSON 佐证。
- 任一 P0 语义（TC-22、TC-24、TC-25）失败即整轮回退，不接受"仅 UI 表现正确"。
- 全套通过后，第 9 节所列项维持开放，不得据此关闭原方案 Page 4 总项或 09-28 计划的对应任务。
