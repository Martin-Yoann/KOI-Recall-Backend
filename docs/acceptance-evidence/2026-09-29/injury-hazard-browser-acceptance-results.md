# Injury/Hazard 浏览器级验收执行记录 — 2026-09-29

> 执行环境：生产三端（`koi-recall-web.vercel.app` / `koi-recall-admin.vercel.app` / `koi-recall-backend.vercel.app`），活动 `music-lollipop-demo-2026`（虚构演示内容）。执行方式：chrome-devtools 接管浏览器，真实 UI 操作 + 网络层取证。用例定义见 [injury-hazard-browser-acceptance.md](../injury-hazard-browser-acceptance.md)。
>
> **结论先行：执行被生产环境 P0 事故阻断。** 事故申报路径 500（两次复现）、`/admin/cases` 列表与案件详情 500。无事故申报、幂等、隐私、查询、处置安全分支等 9 项通过；其余全部标记为被环境阻塞或待部署，**不能据此关闭任何 A 项**。

## 0. 环境事实（先于一切用例结论）

| # | 事实 | 证据 |
| --- | --- | --- |
| E1 | **事故申报路径生产 500（稳定复现）**。完整结构化伤害申报两次 500，事务回滚无脏数据，草稿仍可用 | requestId `dad614e7-6160-4003-9d04-33f8f10f51da`、`9f516a88-1791-4f57-a05e-f7aa57848cf0`；响应 `problems/internal-error` |
| E2 | **`GET /admin/cases`（列表）与 `GET /admin/cases/{ref}`（详情）生产 500**；无事故案件详情同样 500 | 管理端 `/cases` 显示 "0 cases" + 报错横幅；`/cases/KOI-5C6Q-9UJHGW33` 与 `/cases/KOI-3W7O-8NP4XHSW` 均 "Unable to load case" |
| E3 | `/admin/incidents`（事故列表）正常：7 起事故、2 起 Pending、3 FILED、2 NON-REPORTABLE | 浏览器实测 200 |
| E4 | 正常路径：草稿创建、文件上传+病毒扫描+验证、幂等重放、处置任务创建与读取、客人状态查询全部 200 | 各 TC 证据 |
| E5 | **根因（已由另一会话独立确认）**：本轮三提交已于当日推送上线（API `cb1a179..5b12df7`、Admin `bce9a49..4aa514b`、Front `ae6860a..ff857c0`，CI 全绿），但**生产库从未应用迁移 0022/0024–0026**。部署代码写入 `reportability_reviews.case_id`（0026）、读 `escalated` 枚举（0022）→ 事故申报 500、admin 案件列表/详情 500。另一会话取证 requestId `b942c2ed…`/`21c8355d…`，与本轮 `dad614e7…`/`9f516a88…` 同签名。**修复 = 按 `docs/runbook-apply-prod-migrations.md` 应用生产迁移（需生产凭据，待用户执行）；迁移落地后本记录全部 BLOCKED 项可直接重跑** | E1–E3 差集 + 两会话独立 requestId |
| E6 | 线上三端**已包含本轮提交**（TC-05 Other 输入框未在本次出现仅因未选 `other`；管理端新面板在详情页内，而详情页 500）。TC-22/28/30~34 的"待部署"分类更正为"**被 E1/E2 阻塞**——迁移修复后即可测" | 记忆文件 2026-09-29 更正 + 5b12df7 已在线 |
| E7 | 行为观察：refund 补偿也要求 `currentDeliveryAddress`（首次提交 422 `currentDeliveryAddress is required for the selected Remedy`，补地址后 201）。与本地仓库"退款可省略地址"的规则不一致，值得核对是部署差异还是规则本意 | TC-01 请求 54/55 |
| E8 | 行为观察：无事故申报也创建并返回了处置任务（安全文案状态）。黑暗发布下安全，但"无事故案件建处置任务"是否符合预期值得产品确认 | TC-01 响应 `disposal.taskId=92009404-…` |

## 1. 结果总表

| TC | 结果 | 关联 | 证据与说明 |
| --- | --- | --- | --- |
| TC-01 无事故普通申报 | **PASS** | A01 | Case `KOI-5C6Q-9UJHGW33`；201；`emailStatus:"queued"`；确认屏措辞合规。首提 422（E7）已记录 |
| TC-02 明确伤害完整申报 | **BLOCKED（E1）** | A02 | 表单侧全部正常：条件展开、字段齐全、payload 与方案 §4 完全一致（eventTypes=[injury]、severity=medical_attention、treatment=emergency、received=yes、usedAsIntended=no、failureMode=battery_exposure、unitType=original、narrative+injuryDescription）。服务端 500 |
| TC-03 无伤害其他失效模式 | **BLOCKED（E1）** | A03 | 同 E1 |
| TC-04 Unsure+日期未知 | **BLOCKED（E1）** | A04 | 同 E1 |
| TC-05 Other 必须说明 | **BLOCKED（E1）** | A05 | 新代码已在线（E6 更正）；本次未选 `other` 故未触达该输入。事故申报 500 修复后重跑 |
| TC-06 治疗组合一致性 | **PARTIAL** | A06 | 客户端半边待部署；**服务端 A06 通过**：received=no+emergency → 400，错误路径 `incidentDetails.medicalTreatmentReceived`（requestId `80f978c0-…`）；no+事故字段 → 400 路径 `incidentDetails`（`d528753d-…`）；received=yes+none 按阶段一预期穿过契约层（开关未开，随后撞 E1 的 500），严格层 422 留待阶段二 |
| TC-07 替换产品识别 | **BLOCKED（E1）** | A07 | unitType 属于事故字段，需事故申报成功 |
| TC-08 幂等重放 | **PASS** | A08 | 同 Idempotency-Key `34e3e207-…` 重放返回**逐字节相同**存储响应（同 caseReference、同 submittedAt `08:22:13.616Z`） |
| TC-09 敏感内容不落浏览器 | **PASS** | A23 负向 | sessionStorage 快照仅含 draftId/draftToken/expiresAt/idempotencyKey/step/remedy/documents/form{locale,incidentAnswer,eventTypes,consents,product}；叙述/伤害描述/姓名/地址/邮箱零泄漏 |
| TC-10 Yes→No 清空 | **PASS** | — | 切 No 后事故区块整体消失；回到 Yes 后叙述空、severity/failure 回 "Select"、injury 未勾选 |
| TC-11 确认页措辞 | **PASS** | A27 部分 | "Your claim was accepted. Reference KOI-5C6Q-9UJHGW33"；无补偿已批准措辞；处置区为安全文案（见 TC-40）。Page 5 核对页不存在（已知缺口） |
| TC-12 移动端/键盘/读屏 | **PARTIAL** | A30 | 本次为桌面自动化，未执行；建议人工补 |
| TC-20 合规队列立即可见 | **BLOCKED（E1/E2）** | A02 | 新案件未建成；cases 列表 500 |
| TC-21 详情与敏感解密 | **BLOCKED（E2）** | A18 部分 | 案件详情 500 |
| TC-22 Pending 时长徽章 | **BLOCKED（E2）** | — | 徽章在案件详情页，详情 500 |
| TC-23 MANAGER 403 | **SKIP** | A12 | 环境无 MANAGER 账号凭证；路由层 403+拒绝审计由 `tests/admin-rbac.test.ts` 覆盖 |
| TC-24 Filed 四要素 | **BLOCKED（E2）** | A13 | 结案表单在详情页（500）；且不在缺迁移的库上做审查写入，避免混合状态数据 |
| TC-25 Non-Reportable 理由 | **BLOCKED（E2）** | A14 | 同上 |
| TC-26 审查完成≠自动结案 | **BLOCKED（E2）** | A15 | 同上 |
| TC-27 Pending 阻止结案（含强制） | **BLOCKED（E2）** | A09/A10 | 同上 |
| TC-28 Escalated 徽标 | **PENDING 开关** | A02 | 徽章已在线；生产 `INCIDENT_ESCALATED_STATUS` 未开，无 escalated 案件可显示 |
| TC-30~34 升级与案件级审查 | **BLOCKED（E2）** | A16 | 新面板已在线但详情页 500；API 写入在缺迁移库上刻意不做（避免混合状态数据） |
| TC-35 legacy key 不能签核 | **SKIP** | — | 测试环境无 legacy key 值；路由级由 `tests/admin-routes.test.ts` 覆盖（401） |
| TC-40 处置黑暗分支 | **PASS** | A24–A26 安全半边 | 处置页（带 token）仅显示 PRODUCT: Being confirmed / YOUR PHOTOS: Not sent yet / PERMISSION TO DISPOSE: Not given + "Instructions are not available… do not dispose on your own initiative"；零可执行步骤 |
| TC-41 无 token 访问 | **SKIP** | — | 无历史任务夹具 |
| TC-50 确认邮件 | **PARTIAL** | A20 | `emailStatus:"queued"` 已取证（TC-01/08 响应）；example.test 信箱无法验证实际投递与正文 |
| TC-51 客人状态查询 | **PASS** | A20 | 正确邮箱 → "CLAIM RECEIVED"+最少事实；错误邮箱 → "No matching record found. Check your case reference and email address…"（与不存在案件同一中性文案） |

**通过 9 项 / 阻塞 15 项 / 待开关 1 项 / 部分 3 项 / 跳过 3 项。全部阻塞同源于 E5（生产库缺迁移）。**

## 2. TC-02 被拦请求的关键证据

完整请求体（与整改方案 §4 字段清单逐项一致）已留存于执行过程；要点：

```json
{"incidentAnswer":"yes","incidentDetails":{"narrative":"The battery cover came off …","occurredDate":"2026-08-15","occurredDateUnknown":false,"eventTypes":["injury"],"injurySeverity":"medical_attention","medicalTreatment":"emergency","usedAsIntended":"no","failureMode":"battery_exposure","injuryDescription":"A small blister …","medicalTreatmentReceived":"yes","unitType":"original"}}
```

→ 500 `{"type":"…/problems/internal-error","title":"Internal Server Error","status":500}`。同环境无事故申报 201，证明失败点在事故/处置 hold 写入路径，而非鉴权、草稿、上传或幂等。

## 3. 建议的处置顺序

1. **先修环境（P0，最高优先）**：按 `docs/runbook-apply-prod-migrations.md` 对生产库应用缺失迁移（0022/0024–0026；需生产凭据，待用户执行）。**这是当前线上事故申报与 admin 案件主路径全断的唯一根因**；在迁移落地前，任何代码侧排查或新提交都无济于事。
2. 迁移落地后按链重跑：TC-02/03/04/05/07 → TC-20/21/22 → TC-24/25/26/27 → TC-30~34（同一条案件链走完：申报 Other+说明 → 队列 → Pending 时长 → 开 legal 升级自动建审查 → 双重拒绝结案 → Filed → 放行）。
3. TC-28 在打开 `INCIDENT_ESCALATED_STATUS` 后补测（含 `/lookup` 措辞复核）。
4. TC-12 人工移动端/读屏走查；TC-23/35 在有 MANAGER 账号与 legacy key 的环境补测。
5. E7（refund 必填地址）与 E8（无事故建处置任务）交产品/合规确认是否为本意。

## 4. 诚实性声明

- 本轮所有测试数据均为虚构（`example.test` 邮箱、编造叙述与订单号）；写入生产的仅 TC-01 一条无事故案件（`KOI-5C6Q-9UJHGW33`）与 6 个已验证上传文件；未对生产做任何审查决策、状态流转或升级写入。
- PASS 判定全部基于响应体/DOM 证据，截图不作为依据；本记录未持久化页面截图（MCP 截图保存受工作区限制），关键状态以引用文本快照留存于执行过程。
- 本记录不关闭原方案任何 A 项；"3.2.1 处理流程未实现"维持开放。

---

# Re-run — 2026-09-30（生产迁移补齐后）

> 同事确认生产库补齐迁移（0022/0024–0026）后，按记录第 3 节顺序重跑全部 BLOCKED 项。执行者会话：管理端 ADMIN（alex.yuan@rjfresh.com）；消费者端为匿名访客。**结论：迁移修复生效，13 项前次阻塞用例全部转 PASS；另发现 2 个管理端 UI 缺陷（记为 D1/D2）。**

## R0. 修复验证（Phase 0）

| 路径 | 前次 | 本次 |
| --- | --- | --- |
| `GET /admin/cases`（列表） | 500 | **200**，38→44 cases 实时 |
| `GET /admin/cases/{ref}`（详情） | 500 | **200**（KOI-5C6Q 等全部可开） |
| 事故申报 POST /claims | 500 ×2 | **201**（TC-02 重跑建案） |

## R1. 本轮新建案件（全部虚构数据）

| Case | 用例 | 内容 | 终态 |
| --- | --- | --- | --- |
| `KOI-KNQ9-MZYTPS8X` | TC-02 重跑 | 完整结构化伤害申报（payload 与方案 §4 逐项一致） | Filed `CPSC-TEST-2026-0031` → 补偿批准 $19.99 + 外部完成 → **Closed/Completed** |
| `KOI-LGBS-AMCGWSUG` | TC-03+07 | 仅危害（无伤害）、battery_exposure、**replacement unit**、Date unknown（客户端拦了一次缺失日期） | 审查 Pending |
| `KOI-NLBW-ULF4KU9W` | TC-05 | **failureMode=other + failureModeOtherDescription 持久化** | Non-reportable（API 决策） |
| `KOI-VUL9-9RPJ4NEP` | TC-04 | Unsure + 日期未知、无批次码 | **Triage + compliance 阶段**；强制 closed 422 |
| `KOI-LZ24-EXLNXFPR` | TC-33 | 无事故案件；regulator 升级 → 自动案件级审查 | Filed `CPSC-TEST-2026-0044`（filedAt=2026-09-29 操作人日期） |
| `KOI-SUGP-G52S696Y` | TC-34 | 无事故案件；suspected_fraud + data_privacy 升级 | **未建审查**；升级已凭据关闭 |

## R2. 结果更新（前次 BLOCKED 项）

| TC | 前次 | 本次 | 关键证据 |
| --- | --- | --- | --- |
| TC-02 | BLOCKED | **PASS** | 201 `KOI-KNQ9`；管理端事故卡八字段全对；Safety gate → Review Closed |
| TC-03 | BLOCKED | **PASS** | 仅勾 Other 时无伤害描述输入框（条件显示）；队列显示 OTHER/battery exposure |
| TC-04 | BLOCKED | **PASS** | Unsure→`triage` + workflow 阶段 `compliance_review`（双轴并存，9-28 决策的线上实证） |
| TC-05 | BLOCKED | **PASS** | 客户端阻断文案 "You selected Other…describe what happened."；说明随 other 持久化；**切走 other 自动清空**（回来为空） |
| TC-06② | PARTIAL | **PASS**（客户端半边） | "You answered that medical treatment was received, but no treatment type is selected." |
| TC-07 | BLOCKED | **PASS** | 队列+详情 "unit: replacement" 可识别 |
| TC-20 | BLOCKED | **PASS** | 4 案未经人工操作全部入队 PENDING |
| TC-21 | BLOCKED | **PASS** | raw 层叙述+伤害描述 "· DECRYPTED · AUDITED"；审计 2×`pii.view_raw` ADMIN success |
| TC-22 | BLOCKED | **PASS** | "Pending 0 h since company obtained" 徽章（<1h，算术正确） |
| TC-24 | BLOCKED | **PASS** | 三次缺项拒（理由/CPSC 引用/报送日期，各带明确文案）→ 四要素齐 → FILED |
| TC-25 | BLOCKED | **PASS** | 短理由客户端拒；**意外实证服务端矛盾门禁**（non-reportable 携带 filedAt → 422 "cannot carry filedAt or filingEvidence"）→ 合规理由 204 |
| TC-26 | BLOCKED | **PASS** | Filed 后案件仍 Submitted（不自动结案）；批准+外部完成后经矩阵 submitted→under review→approved→closure review→**closed** 全链放行 |
| TC-27 | BLOCKED | **PASS** | ADMIN 会话直接 POST closed（pending 审查）→ **422** "cannot be closed while its safety reportability review is pending"（requestId `17f99efe`）——服务层门禁压过 ADMIN bypass |
| TC-30 | BLOCKED | **PASS** | legal 升级开启 → **"Reportability Review (case-level)" 卡自动出现（pending）** → closed 422（open escalation 门禁，requestId `f96b87ff`） |
| TC-31 | BLOCKED | **PASS** | 依据 <10 字拒 → 合规凭据关闭成功 |
| TC-32 | BLOCKED | **PASS** | 升级关闭后审查 pending 仍 422（requestId `3502a225`）——**关闭升级≠安全签核**；审查决定后 closed 放行（204） |
| TC-33 | BLOCKED | **PASS** | regulator 升级 → 案件级审查自动 pending → API Filed 四要素 → 详情 `filed + CPSC-TEST-2026-0044 + filedAt` |
| TC-34 | BLOCKED | **PASS** | fraud/privacy 均 **未建审查**（escalations.reviewId=null，详情无 reportability）；开放期间 closed 422；凭据关闭后干净 |

**本轮总计：新增 PASS 17 项。累计 PASS 26 项；剩余 SKIP/未建：TC-12（人工读屏/移动端）、TC-23/35（需 MANAGER 账号与 legacy key 凭据）、TC-28（`INCIDENT_ESCALATED_STATUS` 生产未开）、TC-50 实际投递（example.test 不可达）。第 9 节缺口清单（A17/A18/A23/A27/A28/A31–A35）不变，维持开放。**

## R3. 新发现的缺陷与行为

| # | 级别 | 描述 | 影响 |
| --- | --- | --- | --- |
| D1 | **P2** | ~~案件详情页的结案表单不渲染~~ **已定位并修复（admin 提交 `91e4505`，待推送部署）**：根因是表单嵌在 Closure Checklist 卡内，而该卡有 `["approved","closure_review"].includes(status)` 门禁——submitted/triage/under_review 状态整卡不渲染。修复=表单移出为独立块（挂在 Escalations 面板之后），条件与状态解耦；案件级审查因此获得控制台决策入口 | 部署后浏览器复验 |
| D2 | P3 | ~~队列结案弹窗切 outcome 不清空默认 filedAt~~ **已修复（同一提交）**：两处表单（队列弹窗+案件详情）payload 均按 `outcome === "filed"` 守卫 filing 事实，且切换 outcome 时清空 cpsc/date/evidence（切回 filed 时重置今天为默认值） | 部署后浏览器复验 |
| N1 | 记录 | KOI-5C6Q 在审查决定后由 ADMIN 强制 closed（204）——此时其补偿仍为 requested。这与 ADR 一致（force 绕过流转顺序与补偿门禁，**不绕过**安全门禁），不是泄漏；但意味着 ADMIN 强制结案可以跳过补偿完成检查，是否合意值得产品确认 | 无 |
| N2 | 记录 | 管理端会话在执行中途过期且 `koi_admin_session` 被清空，UI 侧自动续期后恢复；API 重放需改用 `session.token` 键名 | 运维备忘 |

## R4. 诚实性声明（补充）

- 本轮写入生产（演示活动）的案件 6 条 + TC-01 的 1 条；审查决策 4 次（filed ×2、non-reportable ×2，均虚构编号/依据）；升级 5 次（legal/regulator/fraud/privacy ×2）全部关闭或随案闭环；状态流转仅 KOI-KNQ9 全链与 KOI-5C6Q 强制 closed。无真实消费者数据接触。
- D1 未深挖（bundle 静态分析到条件为止）；TC-23/35 仍需凭据；TC-12 建议人工执行。
- 本记录不关闭原方案任何 A 项；"3.2.1 处理流程未实现"总项维持开放，但 A02/A04/A05/A06/A07/A09/A10/A12 部分/A13/A14/A15/A16/A20 的浏览器级证据现已齐备或部分齐备，可交合规/运营负责人做相应确认。
