# KOI Recall API

第一阶段消费者召回 API 的独立 Node.js 服务骨架。现有静态 Demo 保持不变；本项目只定义可部署架构、数据库模型和 ToC 契约。

当前六个 `/v1` 业务端点均已注册并进行运行时校验。其中 `GET /v1/recall-campaigns/{slug}`
在配置了 `DATABASE_URL` 时会读取真实数据库返回公开 Campaign；其余五个端点仍返回
`501 application/problem+json`。本阶段不接入 Vercel Blob 或 Resend，不发送邮件，也不执行 Vercel 部署。

## 本地检查

要求 Node.js 24.x 和 pnpm 11.9.0。

```bash
pnpm install
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

生成物检查：

```bash
pnpm openapi:generate
pnpm openapi:check
pnpm db:generate
pnpm db:check
```

## 数据库适配器与本地运行

`src/db/client.ts` 按连接串自动选择驱动，无需手工切换：

- 主机名以 `neon.tech` 结尾 → Neon HTTP 驱动（`@neondatabase/serverless`），用于 Vercel/Neon。
- 其余（含本地 `127.0.0.1`）→ node-postgres（`drizzle-orm/node-postgres` + `pg`），用于本地开发。

本地首次初始化数据库并读取演示 Campaign：

```bash
# 1) 确保本地 Postgres 已启动，DATABASE_URL 指向它（见 .env）
# 2) 套用迁移（脚本会在缺失时自动创建 koi_recall 库）
pnpm db:migrate
# 3) 写入虚构演示数据（仅允许显式在非生产环境运行）
APP_ENV=local ALLOW_SYNTHETIC_SEED=true pnpm db:seed
# 4) 启动并访问
pnpm dev
curl -i 'http://localhost:3000/v1/recall-campaigns/music-lollipop-demo-2026?locale=en-US'
```

Seed 只允许显式运行于非生产环境：

```bash
APP_ENV=local ALLOW_SYNTHETIC_SEED=true DATABASE_URL='postgresql://...' pnpm db:seed
```

## 关键入口

- `src/app.ts`：Hono 应用与中间件注册。
- `src/contracts/toc.ts`：Zod 运行时校验、TypeScript 类型和 OpenAPI 的唯一契约源。
- `src/db/schema/index.ts`：Drizzle PostgreSQL Schema。
- `drizzle/`：生成的首个迁移及元数据。
- `openapi/toc-v1.openapi.yaml`：从代码生成的 OpenAPI 3.1 契约。
- `docs/phase-1/`：架构、数据库和 ToC 接口说明。
