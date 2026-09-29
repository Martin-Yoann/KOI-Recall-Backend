# Injury/Hazard 浏览器级验收用例

> 用途：对 injury/hazard 申报—合规审查—结案路径做浏览器级验收。基线是 2026-09-29 实施轮（三仓库同题提交 `feat(injury-hazard): the review belongs to the case…`：API `347fa1c`、Front `bdac070`、Admin `a8bcec8` 或其后代）。用例编号 TC-xx，"关联"列映射[原方案 A01–A35](superpowers/plans/2026-09-20-injury-hazard-remediation.zh-CN.md)。执行纪律与已知缺口见文末——**通过本套不等于 A01–A35 全部关闭**。

## 1. 环境与前置条件（不满足则不开测）

| #   | 前置                       | 说明 / 核对方法                                                                                                                                                                 |
| --- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P1  | 三端同版本部署到测试环境   | API、消费者端、管理端构建自上述提交；记录构建版本与部署 URL。**禁止**用本地 `.env` 直连数据库跑验收（本地 `DATABASE_URL` 与生产是同一个 Neon 库，见 open-items.md）             |
| P2  | 测试库已应用迁移 0000–0026 | 含 0025（incidents 加密列）与 0026（审查案件化回填）。0026 执行后抽查：`reportability_reviews.case_id` 无 NULL、`incident_id` 允许 NULL、`reportability_reviews_case_uidx` 存在 |
| P3  | 种子数据就绪               | 活动中的 Campaign（含 pinned 版本、证据规则、补偿方式）；`claim_confirmation` 模板 ≥ v5；`scripts/seed-test-data.ts` 或等价虚构数据已跑                                         |
| P4  | 三个后台账号               | COMPLIANCE、ADMIN、MANAGER 各一（`staff:bootstrap` 创建），可登录管理端                                                                                                         |
| P5  | 开关值按阶段记录           | 阶段一默认：`INCIDENT_STRICT_VALIDATION=false`、`INCIDENT_ESCALATED_STATUS=false`。把测试环境两个开关的**实际值**写进验收记录，不得引用代码默认值当作部署事实                   |
| P6  | 数据纪律                   | 全部使用虚构消费者/虚构事故（人名、邮箱、叙述均为编造）；不触碰生产；测试后不清理需留证的案件                                                                                   |
| P7  | 工具                       | 浏览器 DevTools（Network 面板看提交请求与响应、Application 面板看 sessionStorage）；可选 HAR 录制                                                                               |

**消费者端页面**：召回落地 `/recalls/[slug]`（申报表单在此）、客人状态查询 `/lookup`（Case Reference + 邮箱）、我的申报 `/claims`、处置页 `/recalls/[slug]/disposal/[taskId]`。
**管理端页面**：事故队列 `/incidents`、案件列表 `/cases`、案件详情 `/cases/[caseReference]`（含 Incident Report 卡、Escalations 面板、审查表单、状态流转）。

## 2. 测试数据（虚构）

| 夹具       | 内容                                                                                             | 用途                             |
| ---------- | ------------------------------------------------------------------------------------------------ | -------------------------------- |
| 消费者 A   | 虚构姓名/邮箱（如 `alex.tc01@example.test`），产品带可核验标识（lot/date code 或订单号精确匹配） | 已确认受影响路径                 |
| 消费者 B   | 产品无标识、无订单                                                                               | `potential_match` 待人工核验路径 |
| 事故叙述库 | 预写 5 段虚构叙述：明确受伤、仅电池暴露无伤害、窒息未遂、 Unsure、其他失效模式                   | 各 TC 直接粘贴                   |
| 处置夹具   | 无（当前黑暗发布：无获批指引版本→不创建处置任务）                                                | TC-40 验证黑暗分支               |

## 3. G1 消费者端申报与表单

**TC-01 普通申报无事故（基线）** `关联 A01`

1. `/recalls/[slug]` 用消费者 A，incident 问句选 **No**，完成产品/联系/补偿并提交。
2. 预期：事故区块收起且不可展开出字段；提交 201；响应 `caseReference` 形如 `KOI-XXXX-XXXXXXXX`、`emailStatus: "queued"`、无 `disposal` 对象。
3. 记录：Case Reference、提交响应 JSON。

**TC-02 明确伤害完整申报** `关联 A02（阶段一见 TC-02a 注记）`

1. 消费者 A，incident 选 **Yes**；事件类型勾 injury；填日期（或勾 Date unknown）；severity 选 medical_attention；treatment received 选 Yes、类型选 emergency；used as intended 选 No；failure mode 选 battery_exposure；unit involved 选 original；粘贴"受伤"叙述；injury description 填写。
2. 提交，DevTools 保留提交请求/响应。
3. 预期：201；**阶段一**（`INCIDENT_ESCALATED_STATUS=false`）初始 status 为 `submitted`、subtype `injury_hazard`、incidentFlag true（在管理端案件详情核对）；无需任何人改状态，案件立即出现在 `/incidents` 队列，详情"当前阶段"为 compliance_review / 责任部门 compliance。**阶段二**（开关 true）初始 status 为 `escalated`（补跑 TC-28）。
4. 记录：Case Reference、管理端队列截图、workflow 阶段。

**TC-03 无伤害的其他失效模式** `关联 A03`

1. 消费者 A，incident **Yes**；事件类型只勾 other（不勾 injury/illness）；failure mode 选 battery_exposure；severity 不强制（不填或 none）；treatment received 选 No、类型不选或 none；叙述用"仅危害"段。
2. 预期：客户端不要求 injury description（该输入框不出现）；提交 201；管理端 `/incidents` 可见，与受伤案件同队。
3. 记录：Case Reference。

**TC-04 Unsure + 日期未知** `关联 A04`

1. 消费者 B（产品待核验），incident 选 **Unsure**；叙述用 Unsure 段；勾 Date unknown。
2. 预期：201；管理端 status 为 `triage`（产品核验轴），同时 workflow 阶段 compliance_review（安全轴）——两个事实同时成立；`/incidents` 队列可见。
3. 记录：Case Reference、详情页 stage 与 status 两处截图。

**TC-05 Other 失效模式必须说明（本轮新增）** `关联 A05`

1. 消费者 A，incident **Yes**；failure mode 选 **Other**，不填说明，直接提交。
2. 预期（客户端）：提交被阻止，出现 "You selected Other for how the product failed. Please describe what happened."。
3. 填写说明（如"The candy stick split along a seam."）→ 提交 201。
4. 服务端旁证（阶段一）：DevTools 里把提交请求体改为 `failureMode:"other"` 且删掉 `failureModeOtherDescription` 重放 → **仍 201**（必填在严格层，开关未开）；**阶段二**（strict=true）重放 → 422，错误路径含 `incidentDetails.failureModeOtherDescription`。
5. 矛盾规则（全阶段生效）：请求体 `failureMode:"battery_exposure"` + 带 `failureModeOtherDescription` 重放 → 422，错误定位 `incidentDetails.failureModeOtherDescription`。
6. 记录：三个响应 JSON。

**TC-06 治疗组合一致性（本轮新增客户端半边）** `关联 A06`

1. received 选 **No** 同时治疗类型选 emergency → 提交被阻止（客户端消息）。
2. received 选 **Yes**、治疗类型留空或选 None → 提交被阻止（新客户端规则）。
3. received 选 **Yes**、类型选 Unknown → 允许提交（诚实语义）。
4. 服务端旁证：received=no + emergency 的请求体直接重放 → 422 定位 `incidentDetails.medicalTreatmentReceived`（全阶段）；received=yes + none 重放 → 阶段一 201 / 阶段二 422。
5. 记录：响应 JSON。

**TC-07 替换产品识别** `关联 A07`

1. TC-02 流程中 unit involved 选 **A replacement unit**。
2. 预期：提交 201；管理端案件详情 Incident Report 卡 "Unit involved" 显示 replacement；响应体无需断言（报告导出未实现）。
3. 记录：Case Reference、详情截图。

**TC-08 同一请求重试不重复建案** `关联 A08`

1. TC-02 提交成功后，在 DevTools 对该 POST "Copy as fetch" 原样重放一次。
2. 预期：重放返回**同一** `caseReference` 与同一响应体（幂等重放）；管理端 `/cases` 按引用搜索只有一条。
3. 记录：两次响应、案件列表截图。

**TC-09 敏感内容不落浏览器** `关联 A23 的负向半边`

1. 填写事故叙述/伤害描述/Other 说明后，DevTools → Application → Session Storage 检查。
2. 预期：快照中**无**叙述、伤害描述、Other 说明、姓名地址明文；刷新页面后这三项为空（已知缺口：服务端续填未实现，"恢复"不是本例预期）。
3. 记录：Session Storage 内容截图、刷新后表单截图。

**TC-10 切回 No 清空事故数据**

1. 选 Yes 填好部分字段 → 改选 **No** → 再改回 Yes。
2. 预期：回到 Yes 时事故字段全部为初始空值（无残留）。
3. 记录：可选截图。

**TC-11 确认页措辞** `关联 A27（核对页为已知缺口，只验确认页）`

1. TC-02 提交后的确认屏。
2. 预期：显示 Case Reference、受理状态、下一步、客服入口；**不出现**补偿"已批准/已寄出"类措辞；无 disposal 续办链接（黑暗分支）。
3. 记录：整屏截图。

**TC-12 移动端/键盘/读屏基础可操作性** `关联 A30`

1. 375px 视口走完 TC-02；仅键盘完成 Other 说明定位与填写；读屏确认事故区块各控件有可读名称、错误提示可感知。
2. 预期：无布局破碎、focus 顺序合理、错误信息朗读。
3. 记录：逐项打勾，不留截图也可。

## 4. G2 管理端事故审查

**TC-20 合规队列立即可见**

1. TC-02 提交后立即（不改任何状态）以 COMPLIANCE 登录 `/incidents`。
2. 预期：新案件在队列首位；筛选 Pending review 可见。
3. 记录：队列截图。

**TC-21 事故详情与敏感解密**

1. 打开 TC-02 案件详情。
2. 预期（masked）：事故字段全展示（answer/severity/treatment/occurred/usedAsIntended/failureMode/treatment received/unit），Narrative/Injury/Other 显示"加密，需 View raw PII"。
3. 点 **View raw PII** → 三段明文展示且标注 decrypted · audited；审计出现 `pii.view_raw`。
4. 预期：TC-05 的 Other 说明在 raw 层可见（"Other failure mode · decrypted · audited"块）。
5. 记录：两态截图、审计行。

**TC-22 Pending 时长徽章（本轮新增）**

1. TC-02 案件详情 Incident Report 卡。
2. 预期：审查 Pending 时显示 "Pending xx h since company obtained" 徽章；等待或改本机时钟不可行——以提交时刻为基准人工核对小时数≈(现在−提交时间)；审查关闭后徽章消失。
3. 记录：徽章截图与计算值。

**TC-23 角色门禁（审查操作）** `关联 A12`

1. 以 MANAGER 打开同一案件详情与 `/incidents`。
2. 预期：无 Review/Close review 入口、Escalations 面板无开启/关闭按钮（只读）；DevTools 直接 fetch `POST /admin/reportability-reviews/:id/close` → 403。
3. 以 COMPLIANCE 重复 → 表单与按钮存在。
4. 记录：两角色截图、403 响应。

**TC-24 Filed 四要素** `关联 A13`

1. COMPLIANCE 在 `/incidents` 或案件详情对 TC-02 审查选 **Filed with CPSC**，分别缺：CPSC 引用、filing date、filing evidence、rationale（<10 字）各提交一次。
2. 预期：每次被拒且界面显示 API 拒绝原因（filing date 缺失时服务端不接受补时钟）；四项齐备后成功，审查状态变 Filed 并显示引用号与日期。
3. 记录：四次失败信息、成功后状态。

**TC-25 Non-Reportable 需理由** `关联 A14`

1. 对另一 Pending 审查选 Documented non-reportable，rationale <10 字提交。
2. 预期：被拒；≥10 字成功。
3. 记录：失败信息。

**TC-26 审查完成≠自动结案（补偿门禁）** `关联 A15`

1. TC-24 之后立即尝试把案件流转到 closed。
2. 预期：被拒，阻塞原因含 `resolution_not_externally_completed`（结案清单可见）。
3. 走完补偿：approve remedy → 记录外部完成 → 再试 closed。
4. 预期：此时放行（审查已决 + 补偿完成）。
5. 记录：两次流转结果、最终状态。

**TC-27 Pending 阻止结案，含强制** `关联 A09/A10`

1. 新建一起受伤申报（同 TC-02），审查保持 Pending，尝试普通流转 closed → 被拒（"…reportability review is pending…"）。
2. 用 ADMIN 账号的 **force/bypass** 路径（详情页强制流转）再试 → 同样被拒。
3. 关闭该审查后再强制 closed → 放行（补偿已满足时）。
4. 记录：三次结果与错误文案。

**TC-28 Escalated 徽标（阶段二）** `关联 A02`

1. `INCIDENT_ESCALATED_STATUS=true` 后新提交一起已核验的受伤申报。
2. 预期：列表与详情 StatusBadge 显示 **Escalated**（玫红点+文字，不再是灰点）；消费者 `/lookup` 状态仍为 Received 类措辞（不泄漏内部状态）。
3. 记录：两端截图。

## 5. G3 升级与案件级审查（本轮新增，对应 A16）

**TC-30 无事故案件：开升级→自动 Pending→阻止结案**

1. 选一起 TC-01 类**无事故**已申报案件，COMPLIANCE 在详情 Escalations 面板开 **Legal / attorney contact** 升级（理由≥10 字）。
2. 预期：面板出现该升级（Open）；同页出现 **Reportability Review (case-level)** 卡，状态 Pending；尝试 closed（普通与 ADMIN 强制）→ 均被拒（pending）。
3. 记录：三处截图、两次拒绝文案。

**TC-31 开放升级本身阻止结案；关闭需依据**

1. TC-30 案件在升级 Open 状态下尝试 closed → 被拒（"…open escalation…"）。
2. Close escalation 不填依据或 <10 字 → 被拒；填依据（虚构"Decision letter D-2026-…"）→ 成功，面板显示 Closed + 依据。
3. 记录：拒绝与成功文案。

**TC-32 升级关闭≠安全签核（关键语义）**

1. TC-31 关闭升级后**不**动审查，立即尝试 closed。
2. 预期：仍被拒（case-level 审查 Pending）——关闭升级只结束对外对话，不替代报告决定。
3. 关闭该审查为 documented_non_reportable（理由≥10 字）→ 补偿完成前提下 closed 放行。
4. 记录：三步结果。

**TC-33 案件级审查走 Filed 全要素**

1. 另取无事故案件开 **Regulator contact** 升级 → 自动 Pending。
2. 按 TC-24 同样四要素要求将其关为 Filed（引用虚构 CPSC 编号、填写实际报送日期与回执描述）。
3. 预期：成功后 case-level 卡显示 Filed + 引用号 + 日期。
4. 记录：表单与结果。

**TC-34 fraud / privacy 分类不建审查**

1. 无事故案件分别开 **Suspected fraud** 与 **Data privacy incident** 升级。
2. 预期：不出现 case-level 审查卡（这两类默认无报告签核义务）；Open 期间 closed 被拒（开放升级门禁）；关闭升级且补偿完成后 closed 放行。
3. 记录：面板与流转结果。

**TC-35 legacy key 不能签核审查（API 级，浏览器内验证）**

1. 管理端会话内 DevTools 以 legacy `ADMIN_API_KEY` Bearer 直接 fetch `POST /admin/reportability-reviews/:id/close`（任意 Pending 审查 id，body 带 outcome/rationale）。
2. 预期：401；审查状态不变；审计无 `review.close` success 行。
3. 记录：响应与审计查询结果。

## 6. G4 处置衔接（黑暗分支）

**TC-40 无获批指引→无处置步骤** `关联 A24–A26 的安全半边`

1. TC-02 受伤申报提交后查看确认页与 `/claims`。
2. 预期：无 disposal 区块、无处置链接、响应无 `disposal` 对象（黑暗发布=安全默认）。案件后台若有处置任务则应处于 incident 证据保留 hold 且访客不可见可执行步骤——当前无内容不建任务，记录"无任务"即为通过。
3. 记录：确认页截图、响应 JSON。

**TC-41 处置页凭 token 访问的安全拒绝（如环境有历史任务）**

1. 若测试库存在带 visitor token 的处置任务：直接访问 `/recalls/[slug]/disposal/[taskId]`（无/错 token）。
2. 预期：不展示可执行处置步骤。
3. 记录：可选，仅当夹具存在。

## 7. G5 通知与消费者查询

**TC-50 确认邮件入队** `关联 A20`

1. TC-02 提交响应 `emailStatus:"queued"`；管理端/后台确认通知已入队（模板 v5）。
2. 预期：测试环境若配置了邮件投递则收到确认信，正文**不含**事故叙述/伤害描述；未配置投递则只记录 queued 事实。
3. 记录：响应字段、邮件全文或入队证据。

**TC-51 客人状态查询** `关联 A20`

1. `/lookup` 输入 TC-02 的 Case Reference + 正确邮箱 → 状态为受理类措辞（Received 等），无敏感事故内容；错误邮箱 → 统一的中性"未找到"文案（不区分两种错误）。
2. 记录：两态截图。

## 8. 阶段矩阵

| 阶段       | 开关                          | 必跑                                                                                                                                                  |
| ---------- | ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| 一（默认） | strict=false, escalated=false | 全部 TC；TC-05/06 的服务端重放按"阶段一"预期；TC-02 初始 status=submitted                                                                             |
| 二         | strict=true                   | 补跑：TC-05③④、TC-06④ 的 422 断言；旧客户端兼容观察（若有未更新前端在跑，提交应仍成功——严格层只挡"yes 且缺结构化字段"，需以真实旧包验证或跳过并记录） |
| 二         | escalated=true                | 补跑：TC-28；TC-02 初始 status=escalated；`/lookup` 与确认页措辞复核                                                                                  |

## 9. 已知缺口（本套**不可**宣称关闭的验收项）

- A17 "历史未采集"显式标签（详情只显示 "—"）。
- A18 专用结构化报告导出（仅 5 列普通 CSV）。
- A23/A28 服务端加密续填与首次获知时间（刷新即丢，TC-09 只验负向）。
- A27 Page 5 核对页不存在（TC-11 只验确认页）。
- A29 平台预填、A31–A35 监管事项与历史归集。
- 结案门禁的**拒绝**不落审计行（只有越权 denied 审计）。
- 0026 迁移仅测试库演练；历史 filed 行的回执约束仍 NOT VALID。

## 10. 通过标准与记录模板

每个 TC 一行记录：

| TC | 结果(P/F/Skip) | Case Reference | 环境版本 | 开关值 | 证据(截图/HAR/响应) | 备注 |

- P 判定以**预期列全部成立**为准；证据必须含 Case Reference 与关键响应，截图不单独构成通过依据。
- 任一 P0 语义（TC-27/30/32/35）失败即整轮回退，不接受"仅 UI 表现正确"。
- 全套通过后，第 9 节所列 A 项维持开放，不得据此关闭"3.2.1 处理流程未实现"总项。
