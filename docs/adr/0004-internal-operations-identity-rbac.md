# ADR-0004：内部运营身份与权限模型（Staff 主体 + 固定角色 RBAC + 两级 PII + 跨表面审计）

- **状态**：Accepted（2026-08-11 M2 实施落地：B1–B9 完成，M3 切换待运营迁移后执行）
- **日期**：2026-08-10（2026-08-11 Vercel 复核修订 + 实施落地）
- **决策者**：技术
- **关联**：优化规划 `docs/optimization-plan-v1.md` §1"明确不在本轮实现"中的"多层 RBAC / 字段级遮罩"——本 ADR 将其重新立项为下一阶段；ADR-0002（Policy 不输出明文文案）；Claim 提交设计 `docs/superpowers/specs/2026-08-06-claim-submission-design.md`（"Initial admin and export boundary"节已预告的审计边界）
- **替代方案**：见 §6

---

## 1. 背景（Context）

### 1.1 现状

B 端运营表面（T8/O10）已于 `aa9177f` 落地，但权限模型是**单密钥、单角色**：

- `src/routes/admin.ts:8-14` 的 `requireAdminKey` 是全部署唯一的 `ADMIN_API_KEY` 字符串比较；持有该密钥者获得**全部**后台能力。
- `README.md` 明确："Phase 1 的权限模型只有一种授权后台用户……本阶段不实现多级权限。"
- 消费者 PII 在 `case_consumers`（姓名/邮箱/电话/地址）、`claimed_products`（订单/购买凭证）、`incidents`（伤害叙述）中以 AEAD 密文存储，但**当前没有任何端点解密展示**——`listCases` / `exportCases` 只输出非 PII 摘要（`caseReference/status/subtype/incidentFlag/submittedAt`）。
- "谁操作了什么"无统一记录：`reportability_reviews.reviewer_id`（`incidents.ts:70`）、`case_events.actor_id`（`operations.ts:55`）、`campaign_versions.published_by`（`campaigns.ts:66`）均为**游离 uuid/字符串、无 FK、无统一审计表**。
- 无 principals/users 表，无会话层，无 auth 中间件（`src/middleware/` 仅含 request-context / rate-limit / body-limit）。

### 1.2 问题

| 问题                  | 后果                                                                                                                       |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| 单密钥无法区分操作者  | 出现误操作或越权时**无法定位到人**；密钥泄露即全量失守，无法"只读"降权                                                     |
| 无 PII 可见性分层     | 一旦开放案件详情/导出，要么全量解密给所有人（合规风险），要么完全不开放（运营受阻）                                        |
| 审计缺失              | "谁在何时看了哪个消费者的原始 PII / 导出了哪些案件 / 关闭了哪条可报告性审查"**无法回答**——这是 CPSC 合规与隐私审计的硬要求 |
| 离散 actor 列无主体表 | `reviewer_id` 等列无法约束、无法关联、无法随人员变动更新                                                                   |
| 案件无分派概念        | `recall_cases` 无 `assignedTo`；"谁负责哪个案件"只能口口相传或外挂表格                                                     |

`docs/superpowers/specs/2026-08-06-claim-submission-design.md` 的 "Initial admin and export boundary" 节早已预告："Future admin viewing and export operations must call backend application services that authorize the user, decrypt only the requested records, and record an audit event." 本 ADR 兑现该承诺。

---

## 2. 决策（Decision）

引入四件事，构成内部运营的**身份—权限—脱敏—审计**闭环：

1. **Staff 主体 + 会话令牌**：`staff_users` + `staff_sessions` 承载运营人员身份与有状态会话。
2. **固定角色 RBAC**：4 个固定角色（`viewer` / `reviewer` / `compliance` / `administrator`），角色→权限映射**硬编码**。
3. **两级 PII 可见性**：默认脱敏，`pii:view_raw` 权限方可看明文，每次看明文写审计。
4. **跨表面审计表**：`admin_audit_events` 记录所有授权操作（不限于 case）。

### 2.1 Staff 主体与认证因子

```ts
// src/db/schema/staff.ts
staff_users: {
  id, emailLookupHash (HMAC, 唯一索引), email (明文, 仅供展示),
  displayName, role (enum), status ('active'|'disabled'),
  passwordHash (scrypt, nullable), passwordChangedAt, lastLoginAt, timestamps
}
staff_sessions: {
  id, userId (FK), tokenHash (SHA-256, 唯一索引), status,
  issuedAt, expiresAt, revokedAt, lastUsedAt, issuedIpHash, issuedUserAgentHash
}
```

**认证因子默认值**：email + 密码（`node:crypto.scrypt` 哈希，OWASP 认可的 memory-hard KDF）。选 scrypt 而非 argon2id 是**全仓密码学一律只用 Node 内置 `node:crypto`**（AEAD `createCipheriv`、HMAC `createHmac`，见 `src/platform/crypto/node-sensitive-data-crypto.ts`）的延续——argon2id 需引入全仓第一个原生模块依赖，与现有约定和 serverless 冷启动目标冲突。scrypt 零依赖、内置、同为 memory-hard；若未来仓库已普遍引入原生模块依赖，可由新 ADR 升级为 argon2id。这是内部小团队起步的务实默认，**保留 SSO/OIDC 扩展点**（`passwordHash` nullable；未来加 `staff_external_identities` 表绑定外部 IdP subject，登录路径分流）。SSO 的引入以新 ADR 覆盖，不在此预承诺。

**会话令牌**：不透明随机串（48 字节 base64url），服务端存 `SHA-256(token)`——**延续 `claim_drafts.token_hash` 的 capability-token 模式**，天然可吊销、无需 JWT 密钥管理。访问令牌短期有效 + 滑动续期（默认上限 7 天）；密码变更 / 角色降级 / 主动登出 → 批量吊销该用户会话。

> 不选 JWT：内部工具无需无状态跨服务传递身份；JWT 吊销难，与"可追责、可即时封禁"的运营要求冲突。

### 2.2 固定角色与权限矩阵

4 个固定角色，对齐召回运营的真实职能分层；权限是 `资源:动作` 动词，角色→权限映射在代码中**不可配置**（避免引入权限管理 UI 的复杂度）。

| Permission                               | viewer | reviewer | compliance | administrator |
| ---------------------------------------- | :----: | :------: | :--------: | :-----------: |
| `case.queue.read`（队列/列表）           |   ✓    |    ✓     |     ✓      |       ✓       |
| `case.detail.read`（案件详情，**脱敏**） |   ✓    |    ✓     |     ✓      |       ✓       |
| `case.detail.read_pii_raw`（明文 PII）   |   ✗    |    ✗     |     ✓      |       ✓       |
| `case.export`（全量导出）                |   ✗    |    ✗     |     ✓      |       ✓       |
| `case.assign`（分派）                    |   ✗    |    ✓     |     ✓      |       ✓       |
| `case.status.transition`（状态流转）     |   ✗    |    ✓     |     ✓      |       ✓       |
| `review.close`（关闭可报告性审查）       |   ✗    |    ✗     |     ✓      |       ✓       |
| `audit.read`（查看审计日志）             |   ✗    |    ✗     |     ✗      |       ✓       |
| `staff.manage`（用户/角色/会话管理）     |   ✗    |    ✗     |     ✗      |       ✓       |

**规约**：`pii:view_raw` 是**独立权限**，不隐含于任何能看案件详情的角色——`reviewer` 默认只见脱敏，只有 `compliance` / `administrator` 看明文。这是"两级 PII"决策的直接体现。

### 2.3 两级 PII 可见性

- **脱敏默认**：所有能进案件详情的角色看到的 PII 字段经纯函数脱敏（邮箱 `a***@x.com`、电话 `+1 ••• ••• 1234`、姓名首字 + `•`、地址仅留城市/州/国）。脱敏在服务层完成，**密文不出 DB、不解密即不出错**。
- **明文需特权 + 审计**：仅 `case.detail.read_pii_raw` 授权的请求才解密明文；**每次返回明文 PII 写一条 `admin_audit_events`**（`action=pii.view_raw`，记录 caseReference、字段集合、actor）。
- 导出（`case.export`）同理：每次导出写审计，记录选区范围与行数（延续 claim-submission-design "Full-value views and exports create audit records with actor, time, purpose, selection scope, and record count"）。

> 这不是"字段级权限"（逐字段授权），而是**字段集合级**的粗粒度分层——全部 PII 字段要么全脱敏、要么全明文。字段级细粒度被列为后续，不在本 ADR。

### 2.4 跨表面审计

```ts
admin_audit_events: {
  id, actorUserId (FK, nullable for system/legacy), actorRole (快照当时的角色),
  action, resourceType ('case'|'review'|'user'|'session'),
  resourceId (caseReference/reviewId/userId), outcome ('success'|'denied'|'error'),
  reasonCode, occurredAt, ipAddressHash, userAgentHash, metadata jsonb
}
```

- **新增表，不改 `case_events`**：`case_events` 是**案件视角**的时间线（消费者提交、状态变更），归案件所有；`admin_audit_events` 是**运营视角**的合规日志（谁看了 PII、谁导出、谁关审查），归主体/资源所有。两者互补不重复。
- **覆盖所有写操作与 PII 读**：关闭审查、状态流转、分派、导出、看明文 PII、用户/角色变更——全部入审计。被**拒绝**的越权尝试也记 `outcome=denied`。
- 现有离散 actor 列（`reviewer_id` / `actor_id` / `published_by`）**保持现状不加 FK**，避免历史数据迁移风险；新代码在写这些列的同时，向 `admin_audit_events.actorUserId`（有 FK）写入规范化的主体引用。

### 2.5 模块结构

```
src/db/schema/staff.ts                 # staff_users / staff_sessions / admin_audit_events
src/middleware/staff-auth.ts           # 解析会话令牌 → resolve principal → set context
src/modules/staff/                     # 主体/会话/审计服务
  password.ts                          # node:crypto.scrypt 哈希（纯函数可测，零依赖）
  permissions.ts                       # ROLE_PERMISSIONS 矩阵 + hasPermission()（纯函数）
  sessions.ts                          # 令牌签发/校验/吊销（对齐 draftToken 模式）
  drizzle-staff-service.ts             # DB 实现
  drizzle-audit-service.ts             # 审计写入/查询
src/modules/admin/
  pii-masking.ts                       # 纯函数 mask()（新增）
  service.ts                           # 扩展：getCaseDetail(带脱敏/原文分流)、分派、状态流转
src/routes/admin.ts                    # 现有 3 端点 + 会话端点 + 案件详情/分派/状态端点
```

`AppEnv`（`src/middleware/request-context.ts:3-9`）扩展 `Variables.principal?: StaffPrincipal`——staff-auth 中间件 resolve 后挂入，handler 与服务层据此判定权限。

---

## 3. 动机（Rationale）

1. **可追责**：每个后台动作绑定到具名主体，出现问题时可定位到人——单密钥模型做不到。
2. **最小权限**：日常审核（reviewer）不需要看明文 PII 也不需要导出；只有合规岗（compliance）接触原始消费者数据，缩小合规暴露面。
3. **兑现既定审计边界**：claim-submission-design 已声明"full-value views and exports create audit records"——本 ADR 是其下游兑现，而非新增设计负担。
4. **可吊销、可封禁**：会话令牌存服务端，人员离职/密钥疑泄露可即时吊销，不像 JWT 或静态 API key 那样只能等过期。
5. **对齐 CPSC / 隐私审计硬要求**：监管或隐私审查要求"谁在何时访问了哪个消费者的原始 PII"可查——`admin_audit_events` 直接回答。

---

## 4. 后果（Consequences）

### 正面

- B 端运营从"单钥匙开门"升级为"具名主体 + 分层权限 + 全程审计"，满足合规审计与最小权限。
- PII 解密有明确的特权边界与审计轨迹，消费者数据访问可追溯。
- 案件可分派到具体负责人，运营流程从"看队列"进化为"认领/分派/流转"。
- Staff 主体表为后续 SSO、操作报表、权限审计提供单一事实源。

### 负面 / 代价

- **新增 schema**：3 张表（`staff_users` / `staff_sessions` / `admin_audit_events`）+ `recall_cases` 加 `assigned_to_staff_user_id` / `assigned_at`。需 drizzle 迁移。
- **会话管理运维**：登录/登出/刷新/吊销/密码重置流程，相比单密钥增加了操作面（CLI 或最小管理端点 bootstrap 第一个 administrator）。
- **PII 解密 + 脱敏的运行时成本**：案件详情端点需解密（仅 read_pii_raw 时）或脱敏（纯字符串操作，廉价）；脱敏是纯函数，成本可忽略。
- **审计写入吞吐**：每个授权写 + 每次 PII 明文读都写一行；通过索引（actor/resource/action + occurredAt）控制查询成本，写入是单 INSERT 不影响主流程。

### 规约

- `pii:view_raw` **禁止**隐含于任何"能看案件详情"的角色；它是独立权限。
- 解密明文 PII 的服务方法**禁止**在无审计写入的情况下返回——审计与解密在同一事务/同一调用栈。
- `/admin/*` 全部**必须**经过 staff-auth 中间件；无 principal 的请求 401（M3 之后移除 legacy `ADMIN_API_KEY` 兜底）。
- 密码哈希**必须**用 `node:crypto.scrypt`（OWASP 认可的 memory-hard KDF，零依赖延续全仓"只用内置 `node:crypto`"约定）；**禁止**用 MD5/SHA 直接哈希，**禁止**引入原生模块依赖（argon2/bcrypt）；`passwordHash` 列禁止存明文。未来升级 argon2id 须由新 ADR 覆盖。
- 会话令牌**禁止**以明文存表（只存 `SHA-256(token)`），禁止写入日志/响应体除首次签发外。

---

## 5. 验证（Verification）

- **密码与令牌**：scrypt 哈希/校验往返（参数对 OWASP 推荐值）；错误密码恒定时间失败；令牌只存哈希、原文不可逆；吊销后旧令牌立即失效；密码变更使该用户既有会话全部失效。
- **RBAC**：每个角色对每个权限的判定符合 §2.2 矩阵；越权请求返回 403 且写 `outcome=denied` 审计。
- **PII 两级**：reviewer 查案件详情 → PII 字段全脱敏、无审计写入；compliance 查同一案件 → 明文返回、写一条 `pii.view_raw` 审计；viewer 查 → 同 reviewer 脱敏。
- **导出审计**：每次 `case.export` 写审计，含选区范围与行数。
- **审计完整性**：关闭审查、状态流转、分派、用户角色变更均有审计行；`actorRole` 是操作时的角色快照（即使后来角色变更，历史记录不变）。
- **schema 不变量**：`staff_users.email_lookup_hash` 唯一；`staff_sessions.token_hash` 唯一；`recall_cases.assigned_to_staff_user_id` 是 nullable FK（onDelete set null）；`admin_audit_events.actor_user_id` onDelete set null（主体删除不抹除历史，但解引用）。
- **回归**：现有 6 个 `/v1` 消费者端点、3 个 legacy admin 端点（M2 双模式期）行为不变；默认 Vitest 与 DB 集成套件全绿。

---

## 6. 替代方案（Alternatives Considered）

| 方案                                                   | 否决理由                                                                                                                                                                                          |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A. 保持单密钥 + 请求体声明操作者**                   | 操作者身份可伪造，无法真正鉴权/吊销，审计无意义——用户已否决                                                                                                                                       |
| **B. 固定角色 + 细粒度 permission scope（RBAC+权限）** | 灵活但引入权限管理 UI 与授权决策复杂度，内部小团队过度设计——用户选了固定角色                                                                                                                      |
| **C. ABAC（基于属性，如"只看分派给自己的"）**          | 实现成本高，判定引擎复杂；本阶段 4 角色已够——留作未来                                                                                                                                             |
| **D. 外部 IdP / OIDC（如 Google Workspace SSO）**      | 合理且省去密码管理，但当前无 IdP 集成痕迹，默认 email+password 起步，SSO 以新 ADR 引入                                                                                                            |
| **E. JWT 无状态令牌**                                  | 吊销难，与"可即时封禁"的运营要求冲突；服务端有状态会话更适合内部工具                                                                                                                              |
| **F. 全员明文 PII / 全员脱敏**                         | 前者合规风险高（伤害报告类敏感数据），后者运营受阻——用户选了两级分层                                                                                                                              |
| **G. 字段级权限（逐字段授权）**                        | 配置面爆炸，本阶段用"字段集合级"粗粒度即可，字段级留后续                                                                                                                                          |
| **H. argon2id 密码哈希**                               | 同为 memory-hard 且略优于 scrypt，但需引入全仓第一个原生模块依赖（`@node-rs/argon2` 或 node-gyp `argon2`），与"只用内置 `node:crypto`"约定及 serverless 冷启动目标冲突——降为未来升级项（见 §2.1） |

---

## 7. 关联与后续

- **驱动**：本 ADR 把 `docs/optimization-plan-v1.md` §1"明确不在本轮实现"中的"多层 RBAC / 字段级遮罩"重新立项为下一阶段（B 端运营升级）。
- **依赖**：Claim 提交设计（`docs/superpowers/specs/2026-08-06-claim-submission-design.md`）已定义的 AEAD 加密 + HMAC 查询哈希模式——本 ADR 的 PII 解密/脱敏层在其之上构建。
- **下游**：设计草案 `docs/superpowers/specs/2026-08-10-b-end-admin-rbac-design.md` 给出 schema、端点、迁移 M1–M3 与权限矩阵的实现细节。
- **扩展点（后续 ADR）**：SSO/OIDC 集成（`staff_external_identities` 表）；字段级权限；CPSC 自动提交（当前 `review.close` 仅记录，不自动上报）；审计留存与归档策略。
