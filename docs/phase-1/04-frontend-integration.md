# KOI Recall 第一阶段前端集成

## 1. 读者与目标

本文面向前端工程师，说明如何把独立的前端项目接到本仓库的 ToC API。
契约细节（字段、状态码、调用顺序）见 [03-toc-api.md](03-toc-api.md)；本文说明怎么跑起来、怎么消费契约，以及如何验收消费者提交与 Admin Case 之间的关系。

**前置条件**：本机已装 Node.js 24.x、pnpm 11.9.0。只读契约或使用前端 mock 不需要 Vercel 账号和本地 Postgres；联调真实 Campaign/Draft/Claim 流程需要 PostgreSQL 与演示 Seed。

## 2. 快速上手

```bash
# 1. 克隆并安装
git clone <repo-url> koi-recall-api
cd koi-recall-api
pnpm install

# 2. 启动本地 API（监听 http://localhost:3000）
pnpm dev
```

`pnpm dev` 现在跑的是 `tsx watch src/dev.ts`（见 `package.json`），用 `@hono/node-server` 起一个 Node 进程，**不依赖 Vercel CLI**。这只服务本地开发，不会真部署到 Vercel。

可选：起一份本地 Postgres + 演示数据，用于联调真实 Campaign/Draft/Claim 流程：

```bash
# 仅当你要联调真实数据时执行
export DATABASE_URL='postgresql://alexyuan@127.0.0.1:5432/koi_recall'
pnpm db:migrate
APP_ENV=local ALLOW_SYNTHETIC_SEED=true pnpm db:seed
```

真实 Claim 提交另需两个不同的 Crypto Secret。下列值只在当次 API 进程中使用，不要提交、记录或共享生成结果：

```bash
DATABASE_URL='postgresql://alexyuan@127.0.0.1:5432/koi_recall' \
FIELD_ENCRYPTION_KEY="$(openssl rand -base64 32)" \
HASH_PEPPER="$(openssl rand -base64 32)" \
pnpm dev
```

不打算联调真实数据的前端同事可以直接跳过数据库；未配置数据库/Provider 的能力会返回 `501`，前端仍可使用符合 OpenAPI 的 mock。

## 3. 契约的来源与消费

整套 API 契约有**唯一来源**：`src/contracts/toc.ts`（Zod + OpenAPI 路由定义）。后端每次运行 `pnpm openapi:generate` 都会把它摊成 `openapi/toc-v1.openapi.yaml`——**前端所有类型推导都以这份 YAML 为准**。

### 3.1 为什么不直接 import `src/contracts/toc.ts`

那是后端代码，依赖 `@hono/zod-openapi` 和 Drizzle。前端项目的依赖图里不应该有这些。

### 3.2 推荐：在前端项目里生成 TS 类型

把这个 YAML 当成水龙头，自己灌进前端项目：

```bash
# 在前端仓库里（一次性安装）
pnpm add -D openapi-typescript

# 再生类型（指向本仓库的 yaml，可以是本地路径或 GitHub raw URL）
pnpm dlx openapi-typescript \
  https://raw.githubusercontent.com/<org>/koi-recall-api/main/openapi/toc-v1.openapi.yaml \
  -o src/types/api.ts
```

```ts
// src/types/api.ts  （生成产物，禁止手改）
import type { paths, components } from './api';

type GetCampaign = paths['/v1/recall-campaigns/{slug}']['get'];
type CampaignResponse = components['schemas']['CampaignResponse'];
```

**本仓库已经装好了 `openapi-typescript`**，只是为了方便后端 CI 跑类型生成检查。前端**不要**靠这个仓库的 `src/generated/toc-v1.d.ts`，因为它是 `.gitignore` 的，会在你 clone 后缺失。

### 3.3 校验更新

后端改了字段后会同步重生成 `openapi/toc-v1.openapi.yaml` 并提交。前端在合并前重新跑一次 `openapi-typescript`，把新生成的 `src/types/api.ts` 一起提 PR。这样类型错误会在前端 CI 阶段暴露，而不是联调时崩溃。

## 4. CORS：让你的前端跑得起来

`src/config/env.ts` 默认只允许 `http://localhost:3000`。前端 dev server 通常跑在：

- Next.js：`http://localhost:3000`（已允许）
- Vite：`http://localhost:5173`
- Remix / Astro：`http://localhost:3000` / `http://localhost:4321`

把你的 dev origin 加到 `.env`：

```bash
# .env（本地）
CORS_ALLOWED_ORIGINS=http://localhost:3000,http://localhost:5173
```

逗号分隔，**不支持通配符 `*`**（后端校验会拒绝）。`pnpm dev` 用 `tsx watch`，改 `.env` 需要重启进程。

## 5. 调试：先用 curl 摸一遍契约

在写前端代码前，建议先跑通 Campaign、Draft、附件、提交和公开进度查询链路，看清楚契约长什么样：

```bash
# Campaign 查询（需要先 seed）
curl -i 'http://localhost:3000/v1/recall-campaigns/music-lollipop-demo-2026?locale=en-US'

# 未配置数据库时，数据库能力会返回 501 application/problem+json
curl -i -X POST 'http://localhost:3000/v1/recall-campaigns/music-lollipop-demo-2026/claim-drafts'

# 提交端点（带 Idempotency-Key 才能渲染完整的请求校验）
curl -i -X POST 'http://localhost:3000/v1/recall-campaigns/music-lollipop-demo-2026/claims' \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: 8a26f959-cc29-4990-b7e7-823031498393' \
  -d '{"draftId":"21326c9a-5dc2-430f-98a6-546729a1065f",...}'
```

后端日志会打 `X-Request-Id`，复制它去服务器终端 grep 自己的请求，整条链路都能追。

## 6. Phase 1 期间的真实与 501 能力

Phase 1 后端按配置渐进启用数据库和 Provider，未配置的能力返回
`501 application/problem+json`（响应体符合 Problem Details 规范）：

- 配置 `DATABASE_URL` 后，Campaign、商品预筛、Draft 和附件记录读写使用真实 PostgreSQL。
- 再配置 `FIELD_ENCRYPTION_KEY` 和 `HASH_PEPPER` 后，Claim 提交返回 `201`，并原子持久化 Communication 与 Outbox。
- 附件直传另需 `BLOB_READ_WRITE_TOKEN`。
- Resend 投递/Webhook、Outbox worker、Draft cleanup 与 Private Blob 实体删除已有实现，仍需对应配置及独立任务/回调触发；提交成功不代表这些动作已经完成。

前端应始终按 OpenAPI 的真实契约编写。未配置后端依赖时，可在前端开发进程用 MSW 或 fetch wrapper 模拟对应能力；联调环境开启真实配置后应删除该能力的 mock。fetch wrapper 仍必须显式处理 `501`，不能当作成功响应渲染。

### 6.1 Claim 幂等 Key 生命周期

进入最终提交时生成一个 16–128 字符的 `Idempotency-Key`，并把它与当次请求体绑定。如果网络超时、连接中断，或客户端无法确定服务端是否已提交，重试必须复用原 Key 和完全相同的请求体。不要为“不确定的重试”生成新 Key；用户主动开始新申请时才生成新 Key。

### 6.2 提交与后台 Case 的联调验收

术语以 [CONTEXT.md](../../CONTEXT.md) 为准。消费者称其为 Claim，后台管理的是提交成功时创建的 Recall Case；没有独立 Claim 审核或“转 Case”步骤。

在同一测试 API/数据库环境、具备合法附件和后台读取权限的前提下验收：

1. 完成 Draft 和附件准备，提交 `POST /v1/recall-campaigns/{slug}/claims`，确认返回 `201` 与 `caseReference`；草稿创建成功或本地缓存出现记录不算提交完成。
2. 后台登录后刷新 Cases 列表，并通过 `GET /admin/cases/{caseRef}` 核对同一 `caseReference`。列表有分页或过滤时，以详情接口确认记录，不以当前页是否可见推断提交失败。
3. 核对该 Case 的提交时间和授权可见的申请资料；没有第二条待审核 Claim，也不需要额外创建 Case。初始状态以 API 为准，不假设全部为 `submitted` 或已经批准。
4. 使用原 Key 和相同请求体重试，确认返回同一 `caseReference`，不产生第二条 Case。
5. 对允许公开查询的测试数据，使用该 Reference 与提交邮箱调用 `POST /v1/case-status-lookups`，显示 API 返回的公开状态。标为 `is_test_data=true` 的 Campaign 按设计不允许公开查询，应验证拒绝结果，不为通过测试而解除保护。

上述为验收要求，不是本次文档修改已完成运行环境验收的声明。`emailStatus=queued` 不等于邮件送达，Case 创建也不等于退款或换货批准。

### 6.3 Admin 遗留 Claims 页面的处理方向

- 正式处理入口统一为 Cases；原始申请资料和运营处理记录归入同一 Case 详情。缺失字段应在 Case 契约与页面中补齐，不再扩建独立 Claims 模块。
- Campaign 下的申请列表和统计应改为读取关联 Cases，并跳转 `/cases/{caseReference}`；关联字段、筛选及页面接入需另行核对和实施。
- 当前旧 `/claims`、`/claims/{id}` 及 `shared-claims-store` 仍存在，不可把本地读取或状态修改当作后端结果。
- 后续清理时，仅对能关联到真实 Case 的旧链接做兼容跳转；本地演示编号不能冒充 `caseReference`。退出旧路由和存储仍是待办，不因本次文档修改而视为完成。

## 7. 明确边界

- **不要 clone 后端仓库只为了读类型**——`src/generated/toc-v1.d.ts` 是 `.gitignore`，不会在仓库里出现。
- **不要把 draftId / draftToken / 上传 pathname 写进 URL、Sentry、PostHog**——后端契约不允许丢日志。第三阶段补 draftToken 安全 playbook。
- **不要写死 `evidenceRequirements` 规则**——必须从 `GET /v1/recall-campaigns/{slug}` 响应里读 category / minimumFiles / mimeTypes，相应当前 Campaign 版本。
- **不要假设 `emailStatus=queued` 等于邮件已送达**——这只是 Outbox 入队状态，实际投递与送达需单独验证。
- **不要在提交后又改 `incidentAnswer` 又复用同一 `Idempotency-Key`**——后端会返回 409，要求"用户开始新申请"必须生成新 Key。
- **不要在前端持有 `FIELD_ENCRYPTION_KEY` 或 `HASH_PEPPER`**——这两项只属于后端运行环境，且必须与数据库分开保存。

## 8. 校验命令（前端不需要跑，但要知道）

| 命令                 | 用途                                                              |
| -------------------- | ----------------------------------------------------------------- |
| `pnpm openapi:check` | 验证 `openapi/toc-v1.openapi.yaml` 与 `src/contracts/toc.ts` 一致 |
| `pnpm typecheck`     | `tsc --noEmit`，类型层校验                                        |
| `pnpm test`          | 跑 Vitest 套件，包括契约 round-trip 测试                          |
| `pnpm build`         | `typecheck && openapi:check && db:check` 三个全过才算 build green |

后端 CI 跑这四个。前端 CI 至少要跑自己的 `tsc` + `openapi-typescript` 重新生成，确保 git pull 之后类型不漂。

## 9. 后续文档

- `03-toc-api.md` — 消费者端点契约、错误码、调用顺序与公开进度查询
- `01-server-architecture.md` — 服务端架构（了解部署形态时读）
- 第二阶段补：`05-frontend-quirks.md`（draftToken 边界、Idempotency-Key 生命周期、错误 → UI 映射、状态机）
