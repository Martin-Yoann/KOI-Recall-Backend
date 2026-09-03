# KOI Recall API

KOI 召回平台的独立 Node.js API 服务，提供消费者申请提交、公开进度查询，以及管理后台的 Case 查询和处理能力。现有静态 Demo 保持不变；正式业务数据由本项目的 PostgreSQL 数据模型承载。

当前 `/v1` 召回业务端点已注册并进行运行时校验。配置 `DATABASE_URL`
后，Campaign 查询、商品预筛、匿名 Draft 创建与附件记录管理会读写真实数据库。再同时配置
`FIELD_ENCRYPTION_KEY` 和 `HASH_PEPPER` 后，Claim 提交会在一个事务中写入 Case 聚合、
Confirmation Communication 和 Outbox，成功返回 `201` 与 `emailStatus=queued`。

邮件不会在 Claim 请求内联发送。配置 Resend、Cron、Blob 与 Crypto 后，内部 Job 会异步投递
Outbox 邮件并清理过期 Draft；Resend Webhook 使用 Svix 签名验证。未配置相应适配器的能力仍返回
`501 application/problem+json`。

## Claim 与 Case 的统一口径

领域术语以 [CONTEXT.md](CONTEXT.md) 为准（2026-08-27 确认）：

| 概念        | 含义与边界                                                                                 |
| ----------- | ------------------------------------------------------------------------------------------ |
| Claim       | 消费者对召回申请的称呼，不是后台另一类独立处理记录。                                       |
| Claim Draft | 提交前的临时草稿，用于准备材料和上传附件；不进入正式 Case 处理列表。                       |
| Recall Case | 提交成功时创建的正式记录，承载原始申请及后续审核、补资料、补救和结案；创建不代表审核通过。 |

完整链路为：**Claim Draft → 提交 Claim → 创建 Recall Case → Admin 处理同一 Case**。不存在先审核 Claim 再转换成 Case 的步骤。

- 消费者提交继续使用 `POST /v1/recall-campaigns/{slug}/claims`，成功返回 `caseReference`；不因后台统一命名而改动公开契约。
- Admin 通过 `GET /admin/cases` 与 `GET /admin/cases/{caseRef}` 读取同一条正式记录，操作由 `/admin/cases/{caseRef}/…` 下的授权接口处理。
- 消费者通过 `POST /v1/case-status-lookups` 查询该 Case 的受限公开进度，不能调用 Admin 接口读取完整资料。
- 不新增独立 Claim 表、`/admin/claims` 接口或第二套审核状态。Admin 遗留 Claims 页面及本地桥接存储待退出，不能作为正式业务数据来源；本次文档统一不代表页面已移除。

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

初版单一后台用户模型已由 [ADR-0004](docs/adr/0004-internal-operations-identity-rbac.md) 的固定角色与两级 PII 模型取代。人工查看和处理应经过授权 Admin API，不要把数据库直连当作人工查看接口。

> B 端运营升级：后台使用具名运营主体（`staff_users`）+ 会话令牌 + 两级固定角色
> RBAC（`ADMIN` / `MANAGER`）。两种角色都可以管理业务数据；只有 `ADMIN` 可以创建、修改、停用、删除员工账户，
> 并且状态强制操作会跳过工作流前置校验。密码以哈希保存，审计事件写入 `admin_audit_events`。首个 `ADMIN` 通过
> `pnpm staff:bootstrap` 创建，之后以 `POST /admin/sessions` 登录获取会话令牌。迁移期（M2）旧的
> `ADMIN_API_KEY` 仍被接受作为 `ADMIN` 角色；M3 切换后仅接受会话令牌。

## 关键入口

- `src/app.ts`：Hono 应用与中间件注册。
- `CONTEXT.md`：统一领域词汇表，区分 Claim、Claim Draft 与 Recall Case。
- `src/routes/admin.ts`：后台 Case 列表、详情、分派、状态流转与补救操作入口；另含事故列表（`GET /admin/incidents`）、活动只读总览（`GET /admin/campaigns`）与审计查询。状态流转支持可选 `note`（MANAGER 流转到 `need_info` 时必填）；ADMIN 可强制跳过工作流前置校验，但仍必须使用合法状态值。
- `src/contracts/`：按资源拆分的 Zod 运行时校验、TypeScript 类型和 OpenAPI 契约；`toc.ts` 为兼容导出。
- `src/db/schema/`：按领域拆分的 Drizzle PostgreSQL Schema；`index.ts` 为统一导出。
- `drizzle/`：生成的首个迁移及元数据。
- `openapi/toc-v1.openapi.yaml`：从代码生成的 OpenAPI 3.1 契约。
- `docs/phase-1/`：架构、数据库和 ToC 接口说明。

带日期的 `docs/superpowers/specs/`、`docs/superpowers/plans/` 和带代码基线的优化计划保留其设计时点语境，不作为当前实现完成状态的证明。Claim/Case 口径以本节和 `CONTEXT.md` 为准。
