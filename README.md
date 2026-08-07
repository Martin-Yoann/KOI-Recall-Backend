# KOI Recall API

第一阶段消费者召回 API 的独立 Node.js 服务。现有静态 Demo 保持不变；本项目提供可部署架构、PostgreSQL 数据模型和 ToC 契约。

当前六个 `/v1` 业务端点均已注册并进行运行时校验。配置 `DATABASE_URL`
后，Campaign 查询、商品预筛、匿名 Draft 创建与附件记录管理会读写真实数据库。再同时配置
`FIELD_ENCRYPTION_KEY` 和 `HASH_PEPPER` 后，Claim 提交会在一个事务中写入 Case 聚合、
Confirmation Communication 和 Outbox，成功返回 `201` 与 `emailStatus=queued`。

当前不会内联发送邮件。Resend 投递与 Webhook、Outbox worker、Draft cleanup、Private
Blob 实体删除和 Admin API 仍是后续工作，对应的未实现入口保持 `501 application/problem+json`。

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

- 主机名匹配 `ep-...-pooler.*.neon.tech` → Neon Serverless Pool
  （`@neondatabase/serverless` + `drizzle-orm/neon-serverless`），用于 Vercel/Neon。Neon
  直连主机名会在启动时失败关闭，运行时必须提供 pooled connection string。
- 其余（含本地 `127.0.0.1`）→ node-postgres（`drizzle-orm/node-postgres` + `pg`），用于本地开发。

本地首次初始化数据库并读取演示 Campaign：

```bash
export DATABASE_URL='postgresql://alexyuan@127.0.0.1:5432/koi_recall'
# 2) 套用迁移（脚本会在缺失时自动创建 koi_recall 库）
pnpm db:migrate
# 3) 写入虚构演示数据（仅允许显式在非生产环境运行）
APP_ENV=local ALLOW_SYNTHETIC_SEED=true pnpm db:seed
# 4) 启动并访问
pnpm dev
curl -i 'http://localhost:3000/v1/recall-campaigns/music-lollipop-demo-2026?locale=en-US'
```

本地启用 Claim 提交时，为两项用途生成不同的 32-byte Base64 值。下列命令只把值注入当次
`pnpm dev` 进程，不要把它们写入文档、Git 或日志：

```bash
DATABASE_URL='postgresql://alexyuan@127.0.0.1:5432/koi_recall' \
FIELD_ENCRYPTION_KEY="$(openssl rand -base64 32)" \
HASH_PEPPER="$(openssl rand -base64 32)" \
pnpm dev
```

Claim 仅在数据库和两项 Crypto Secret 都已配置时返回 `201`。未配置数据库，或缺少任一
Crypto Secret 时，Claim 能力返回条件性 `501`；非空但非法的数据库 URL、Secret 或相同的两个
Secret 会在组合阶段失败关闭。

Seed 只允许显式运行于非生产环境：

```bash
APP_ENV=local ALLOW_SYNTHETIC_SEED=true DATABASE_URL='postgresql://...' pnpm db:seed
```

真实 Neon 事务 smoke 使用独立测试连接串并需显式 opt-in；默认测试不会创建 Neon 客户端或联网：

```bash
RUN_NEON_POOL_INTEGRATION=true \
NEON_POOLED_TEST_DATABASE_URL='postgresql://...@ep-...-pooler....neon.tech/neondb?sslmode=require' \
pnpm exec vitest run tests/neon-pooled-transaction.integration.test.ts
```

## 敏感数据与人工查看边界

Claim 的姓名、联系方式、地址、订单号、事故叙述和提交快照以 AES-256-GCM 密文持久化；查询用值使用
独立 `HASH_PEPPER` 生成 HMAC。密钥必须与数据库分开保存，两项 Secret 也必须彼此不同。

Phase 1 的权限模型只有一种授权后台用户：未来 Admin API 在授权后端边界内解密，允许查看/导出完整数据；
本阶段不实现多级权限或字段脱敏。当前仓库尚未实现 Admin API，因此不要把数据库直连当作人工查看接口。

## 关键入口

- `src/app.ts`：Hono 应用与中间件注册。
- `src/contracts/toc.ts`：Zod 运行时校验、TypeScript 类型和 OpenAPI 的唯一契约源。
- `src/db/schema/index.ts`：Drizzle PostgreSQL Schema。
- `drizzle/`：生成的首个迁移及元数据。
- `openapi/toc-v1.openapi.yaml`：从代码生成的 OpenAPI 3.1 契约。
- `docs/phase-1/`：架构、数据库和 ToC 接口说明。
