# KOI Recall 第一阶段前端集成

## 1. 读者与目标

本文面向前端工程师，说明如何把独立的前端项目接到本仓库的 ToC API。
契约细节（字段、状态码、调用顺序）见 `03-toc-api.md`；本文只关心**第 0 步到第 1 步**：怎么跑起来、怎么消费契约、怎么不踩坑。

**前置条件**：本机已装 Node.js 24.x、pnpm 11.9.0。前端同事不需要 Vercel 账号、不需要本地 Postgres——除非前端要联调 `GET /v1/recall-campaigns/{slug}` 的真实数据。

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

可选：起一份本地 Postgres + 演示数据，这样 `GET /v1/recall-campaigns/{slug}` 能返回真实 Campaign：

```bash
# 仅当你要联调真实数据时执行
cp .env.example .env
# 编辑 .env，把 DATABASE_URL 指向你的本地 Postgres
pnpm db:migrate
APP_ENV=local ALLOW_SYNTHETIC_SEED=true pnpm db:seed
```

不打算联调真实数据的前端同事可以**直接跳过数据库**，5 个 501 端点不影响前端骨架开发。

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

在写前端代码前，建议先把 6 个端点都跑一遍，看清楚契约长什么样：

```bash
# 唯一接 DB 的端点（需要先 seed）
curl -i 'http://localhost:3000/v1/recall-campaigns/music-lollipop-demo-2026?locale=en-US'

# 其余 5 个端点此时都会返回 501 application/problem+json
curl -i -X POST 'http://localhost:3000/v1/recall-campaigns/music-lollipop-demo-2026/claim-drafts'

# 提交端点（带 Idempotency-Key 才能渲染完整的请求校验）
curl -i -X POST 'http://localhost:3000/v1/recall-campaigns/music-lollipop-demo-2026/claims' \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: 8a26f959-cc29-4990-b7e7-823031498393' \
  -d '{"draftId":"21326c9a-5dc2-430f-98a6-546729a1065f",...}'
```

后端日志会打 `X-Request-Id`，复制它去服务器终端 grep 自己的请求，整条链路都能追。

## 6. Phase 1 期间的 501 端点策略

**现实**：Phase 1 后端只接了 1 个端点。剩下 5 个返回 `501 application/problem+json`（响应体符合 Problem Details 规范）。

前端有两条路：

### 6.1 推荐：先按真契约写，前端 mock 业务分支

拿 `openapi-typescript` 生成的类型写代码。在前端进程里**拦截 501**，临时返回一组符合契约的成功 payload——这样 Phase 1 期间前端可以**完整跑完提交流程**，到 Phase 2 后端真接通时只删掉 mock 层。

### 6.2 备选：前端只写 GET，前端 mock 5 端点

通过 service worker / MSW / 直接在 fetch wrapper 里短路返回 stub。简单但 Phase 2 切换时容易漏改。

**两种方案都要保证**：前端代码不能"忘了 501"。至少在 fetch wrapper 里显式处理 501，避免 Phase 2 真实接通时把 5 端点当 200 渲染。

## 7. 明确边界

- **不要 clone 后端仓库只为了读类型**——`src/generated/toc-v1.d.ts` 是 `.gitignore`，不会在仓库里出现。
- **不要把 draftId / draftToken 写进 URL、Sentry、PostHog**——后端契约不允许丢日志。第三阶段补 draftToken 安全 playbook。
- **不要写死 `evidenceRequirements` 规则**——必须从 `GET /v1/recall-campaigns/{slug}` 响应里读 category / minimumFiles / mimeTypes，相应当前 Campaign 版本。
- **不要假设 `emailStatus=queued` 等于邮件已送达**——这只是 Outbox 入队状态。Phase 1 不会真的发邮件。
- **不要在提交后又改 `incidentAnswer` 又复用同一 `Idempotency-Key`**——后端会返回 409，要求"用户开始新申请"必须生成新 Key。

## 8. 校验命令（前端不需要跑，但要知道）

| 命令 | 用途 |
| --- | --- |
| `pnpm openapi:check` | 验证 `openapi/toc-v1.openapi.yaml` 与 `src/contracts/toc.ts` 一致 |
| `pnpm typecheck` | `tsc --noEmit`，类型层校验 |
| `pnpm test` | 跑 Vitest 套件，包括契约 round-trip 测试 |
| `pnpm build` | `typecheck && openapi:check && db:check` 三个全过才算 build green |

后端 CI 跑这四个。前端 CI 至少要跑自己的 `tsc` + `openapi-typescript` 重新生成，确保 git pull 之后类型不漂。

## 9. 后续文档

- `03-toc-api.md` — 6 端点契约、错误码、调用顺序
- `01-server-architecture.md` — 服务端架构（了解部署形态时读）
- 第二阶段补：`05-frontend-quirks.md`（draftToken 边界、Idempotency-Key 生命周期、错误 → UI 映射、状态机）
