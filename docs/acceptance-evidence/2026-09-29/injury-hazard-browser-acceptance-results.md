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
| E5 | **判断（假设，待服务端日志确认）**：生产库迁移落后于已部署代码。cases 查询把 `escalated` 枚举值放进 WHERE（0022 引入）→ 缺标签即 500；事故申报的事故证据保留 hold（处置迁移系列）同理。与 9 月 29 日记忆中 BUG-0（生产库缺迁移致事故申报 500）签名一致。**修复 = 按此前 runbook 补齐生产迁移，然后重跑本记录中全部 BLOCKED 项** | E1–E3 的差集：唯一正常的事故列表恰好不触碰缺失枚举/表 |
| E6 | **线上三端是上一轮提交**（API `a91f81b`、Front `ada7f58`、Admin `21c7a4f`）；本轮三提交（`347fa1c`/`bdac070`/`a8bcec8`）未推送。因此 Other 说明字段、其客户端规则、Pending 时长徽章、Escalations 面板、案件级审查卡线上不存在——**非缺陷，待部署** | 草稿响应/页面行为比对 |
| E7 | 行为观察：refund 补偿也要求 `currentDeliveryAddress`（首次提交 422 `currentDeliveryAddress is required for the selected Remedy`，补地址后 201）。与本地仓库"退款可省略地址"的规则不一致，值得核对是部署差异还是规则本意 | TC-01 请求 54/55 |
| E8 | 行为观察：无事故申报也创建并返回了处置任务（安全文案状态）。黑暗发布下安全，但"无事故案件建处置任务"是否符合预期值得产品确认 | TC-01 响应 `disposal.taskId=92009404-…` |

## 1. 结果总表

| TC | 结果 | 关联 | 证据与说明 |
| --- | --- | --- | --- |
| TC-01 无事故普通申报 | **PASS** | A01 | Case `KOI-5C6Q-9UJHGW33`；201；`emailStatus:"queued"`；确认屏措辞合规。首提 422（E7）已记录 |
| TC-02 明确伤害完整申报 | **BLOCKED（E1）** | A02 | 表单侧全部正常：条件展开、字段齐全、payload 与方案 §4 完全一致（eventTypes=[injury]、severity=medical_attention、treatment=emergency、received=yes、usedAsIntended=no、failureMode=battery_exposure、unitType=original、narrative+injuryDescription）。服务端 500 |
| TC-03 无伤害其他失效模式 | **BLOCKED（E1）** | A03 | 同 E1 |
| TC-04 Unsure+日期未知 | **BLOCKED（E1）** | A04 | 同 E1 |
| TC-05 Other 必须说明 | **DEFERRED（E6）** | A05 | 线上前端无 Other 说明输入、线上契约无该字段；单测已覆盖两半规则。部署后重跑 |
| TC-06 治疗组合一致性 | **PARTIAL** | A06 | 客户端半边待部署；**服务端 A06 通过**：received=no+emergency → 400，错误路径 `incidentDetails.medicalTreatmentReceived`（requestId `80f978c0-…`）；no+事故字段 → 400 路径 `incidentDetails`（`d528753d-…`）；received=yes+none 按阶段一预期穿过契约层（开关未开，随后撞 E1 的 500），严格层 422 留待阶段二 |
| TC-07 替换产品识别 | **BLOCKED（E1）** | A07 | unitType 属于事故字段，需事故申报成功 |
| TC-08 幂等重放 | **PASS** | A08 | 同 Idempotency-Key `34e3e207-…` 重放返回**逐字节相同**存储响应（同 caseReference、同 submittedAt `08:22:13.616Z`） |
| TC-09 敏感内容不落浏览器 | **PASS** | A23 负向 | sessionStorage 快照仅含 draftId/draftToken/expiresAt/idempotencyKey/step/remedy/documents/form{locale,incidentAnswer,eventTypes,consents,product}；叙述/伤害描述/姓名/地址/邮箱零泄漏 |
| TC-10 Yes→No 清空 | **PASS** | — | 切 No 后事故区块整体消失；回到 Yes 后叙述空、severity/failure 回 "Select"、injury 未勾选 |
| TC-11 确认页措辞 | **PASS** | A27 部分 | "Your claim was accepted. Reference KOI-5C6Q-9UJHGW33"；无补偿已批准措辞；处置区为安全文案（见 TC-40）。Page 5 核对页不存在（已知缺口） |
| TC-12 移动端/键盘/读屏 | **PARTIAL** | A30 | 本次为桌面自动化，未执行；建议人工补 |
| TC-20 合规队列立即可见 | **BLOCKED（E1/E2）** | A02 | 新案件未建成；cases 列表 500 |
| TC-21 详情与敏感解密 | **BLOCKED（E2）** | A18 部分 | 案件详情 500 |
| TC-22 Pending 时长徽章 | **DEFERRED（E6）** | — | 未部署 |
| TC-23 MANAGER 403 | **SKIP** | A12 | 环境无 MANAGER 账号凭证；路由层 403+拒绝审计由 `tests/admin-rbac.test.ts` 覆盖 |
| TC-24 Filed 四要素 | **BLOCKED（E2）** | A13 | 结案表单在详情页（500）；且不在缺迁移的库上做审查写入，避免混合状态数据 |
| TC-25 Non-Reportable 理由 | **BLOCKED（E2）** | A14 | 同上 |
| TC-26 审查完成≠自动结案 | **BLOCKED（E2）** | A15 | 同上 |
| TC-27 Pending 阻止结案（含强制） | **BLOCKED（E2）** | A09/A10 | 同上 |
| TC-28 Escalated 徽标 | **DEFERRED** | A02 | 生产开关未开 + 徽标未部署 |
| TC-30~34 升级与案件级审查 | **BLOCKED（E2/E6）** | A16 | 管理端面板未部署；API 写入在缺迁移库上刻意不做。**注意：即使部署本轮提交，E2 不修复则详情页仍无法操作** |
| TC-35 legacy key 不能签核 | **SKIP** | — | 测试环境无 legacy key 值；路由级由 `tests/admin-routes.test.ts` 覆盖（401） |
| TC-40 处置黑暗分支 | **PASS** | A24–A26 安全半边 | 处置页（带 token）仅显示 PRODUCT: Being confirmed / YOUR PHOTOS: Not sent yet / PERMISSION TO DISPOSE: Not given + "Instructions are not available… do not dispose on your own initiative"；零可执行步骤 |
| TC-41 无 token 访问 | **SKIP** | — | 无历史任务夹具 |
| TC-50 确认邮件 | **PARTIAL** | A20 | `emailStatus:"queued"` 已取证（TC-01/08 响应）；example.test 信箱无法验证实际投递与正文 |
| TC-51 客人状态查询 | **PASS** | A20 | 正确邮箱 → "CLAIM RECEIVED"+最少事实；错误邮箱 → "No matching record found. Check your case reference and email address…"（与不存在案件同一中性文案） |

**通过 9 项 / 阻塞 13 项 / 待部署 3 项 / 部分 3 项 / 跳过 3 项。**

## 2. TC-02 被拦请求的关键证据

完整请求体（与整改方案 §4 字段清单逐项一致）已留存于执行过程；要点：

```json
{"incidentAnswer":"yes","incidentDetails":{"narrative":"The battery cover came off …","occurredDate":"2026-08-15","occurredDateUnknown":false,"eventTypes":["injury"],"injurySeverity":"medical_attention","medicalTreatment":"emergency","usedAsIntended":"no","failureMode":"battery_exposure","injuryDescription":"A small blister …","medicalTreatmentReceived":"yes","unitType":"original"}}
```

→ 500 `{"type":"…/problems/internal-error","title":"Internal Server Error","status":500}`。同环境无事故申报 201，证明失败点在事故/处置 hold 写入路径，而非鉴权、草稿、上传或幂等。

## 3. 建议的处置顺序

1. **先修环境（P0）**：按处置轮 runbook 核对生产库已应用迁移（重点 0021–0024 与 `escalated`/hold 枚举），补齐后在 `/cases`、案件详情、事故申报三条路径复测 200。**迁移补齐前不要推送/部署本轮新提交**（否则故障面更大、归因更难）。
2. 部署本轮三提交后重跑：TC-05、TC-06 客户端半边、TC-22、TC-28、TC-30~34。
3. E1 修复后重跑：TC-02/03/04/07 → 顺着把 TC-20/21/24/25/26/27 一次走完（同一条案件链：申报→队列→审查 Filed→结案门禁→强制拒绝→放行）。
4. TC-12 人工移动端/读屏走查；TC-23/35 在有 MANAGER 账号与 legacy key 的环境补测。
5. E7（refund 必填地址）与 E8（无事故建处置任务）交产品/合规确认是否为本意。

## 4. 诚实性声明

- 本轮所有测试数据均为虚构（`example.test` 邮箱、编造叙述与订单号）；写入生产的仅 TC-01 一条无事故案件（`KOI-5C6Q-9UJHGW33`）与 6 个已验证上传文件；未对生产做任何审查决策、状态流转或升级写入。
- PASS 判定全部基于响应体/DOM 证据，截图不作为依据；本记录未持久化页面截图（MCP 截图保存受工作区限制），关键状态以引用文本快照留存于执行过程。
- 本记录不关闭原方案任何 A 项；"3.2.1 处理流程未实现"维持开放。
