# KOI Recall 第一阶段 ToC API

## 1. 范围与状态

本文是前端对接说明；字段名和示例保持英文，说明使用中文。机器契约见 `openapi/toc-v1.openapi.yaml`，其唯一来源为 `src/contracts/toc.ts`。

当前 Campaign 查询、商品预筛、匿名 Draft 创建、附件记录管理和 Claim 提交均有 PostgreSQL 实现。附件直传在配置 `BLOB_READ_WRITE_TOKEN` 后接入 Vercel Private Blob（含完成回调回写 `document_uploads`）。

Claim 只在 `DATABASE_URL`、`FIELD_ENCRYPTION_KEY` 和 `HASH_PEPPER` 都已配置时返回 `201`；未配置数据库或缺少任一 Crypto Secret 时返回条件性 `501 Not Implemented`。成功事务会原子持久化 Case 聚合、Confirmation Communication 与 Outbox，但当前不调用 Resend。

不提供消费者账户、Case 查询、状态门户、修改或撤回接口。确认页使用提交响应，不通过公开 GET 暴露 Case。

## 2. 通用协议

- Base URL：本地 `http://localhost:3000`；生产域名待定。
- 版本前缀：`/v1`。
- 请求/成功响应：`application/json`；错误：`application/problem+json`。
- 首期 locale 只接受 `en-US`。数据库允许未来加入 `es-US`；启用前端语言后更新 API enum。
- `X-Request-Id`：可由客户端提供，也可由服务端生成；响应总会返回。
- CORS：只允许配置的消费者站点 Origin，不允许 `*`。
- 除一次性上传授权响应中的受限 `pathname` 外，公开响应不会包含 Blob 存储标识、内部 Case UUID、密文、HMAC、Provider 错误正文或数据库顺序号。

Problem Details 示例：

```json
{
  "type": "https://api.example.invalid/problems/validation-error",
  "title": "Invalid Request",
  "status": 400,
  "detail": "The request did not satisfy the API contract.",
  "requestId": "f76433fd-fc42-43e6-a60c-7d208829fdb5",
  "errors": [
    {
      "path": "incidentDetails.narrative",
      "message": "String must contain at least 10 character(s)"
    }
  ]
}
```

## 3. 推荐调用顺序

1. `GET /v1/recall-campaigns/{slug}?locale=en-US`
2. `POST /v1/recall-campaigns/{slug}/product-checks`
3. `POST /v1/recall-campaigns/{slug}/claim-drafts`
4. 每个附件调用 `POST /v1/claim-drafts/{draftId}/upload-tokens`，然后浏览器直传 Private Blob。
5. 直传期间轮询 `GET /v1/claim-drafts/{draftId}/documents` 获取附件的六态状态（见第 12 节）。
6. 用户删除附件时调用 `DELETE /v1/claim-drafts/{draftId}/documents/{documentId}`。
7. `POST /v1/recall-campaigns/{slug}/claims` 完成提交。
8. 提交后以案件号 + 邮箱调用 `POST /v1/case-status-lookups` 查询公开进度（见第 13 节）。

前端必须以 GET 返回的 `evidenceRequirements` 决定必传类别、数量、MIME 和大小，不能把 Demo 规则写死。最终提交时服务端会按 Draft 绑定的 Campaign 版本再次验证。

## 4. 获取公开 Campaign

`GET /v1/recall-campaigns/{slug}?locale=en-US`

Query：

| Name     | Required | Description                        |
| -------- | -------: | ---------------------------------- |
| `locale` |       No | 首期只能是 `en-US`，默认 `en-US`。 |

成功 `200`：

```json
{
  "campaign": {
    "slug": "music-lollipop-demo-2026",
    "code": "ML-DEMO-2026",
    "version": 1,
    "locale": "en-US",
    "defaultLocale": "en-US",
    "title": "Music Lollipop Safety Recall",
    "summary": "Fictional test content for the KOI Phase 1 service skeleton.",
    "hazard": "Fictional component-separation hazard.",
    "immediateAction": "Stop using a potentially affected product until its lot code has been checked.",
    "remedySummary": "Replacement or refund after manual review.",
    "support": {
      "email": "demo-support@example.invalid",
      "phone": "(555) 010-2042",
      "hours": "Monday-Friday, 9:00 a.m.-5:00 p.m. ET"
    },
    "products": [
      {
        "productId": "5e41d8b9-03c4-46d4-9b87-80c40cdfbde5",
        "sku": "MUSIC-LOLLIPOP-DEMO-18G",
        "brand": "Candy Master",
        "name": "Music Lollipop",
        "flavors": ["Peach", "Strawberry"],
        "shapes": ["Bear", "Dinosaur", "Strawberry", "Heart"],
        "affectedLots": [{ "lotCode": "ML-2406-A", "dateCode": "06/2024", "attributes": {} }]
      }
    ],
    "remedies": [{ "code": "replacement", "displayName": "Replacement" }],
    "evidenceRequirements": [
      {
        "category": "product_photo",
        "required": true,
        "minimumFiles": 1,
        "maximumFiles": 5,
        "allowedMimeTypes": ["image/jpeg", "image/png", "image/heic"],
        "maximumFileSizeBytes": 10485760,
        "instructions": "Upload a clear product and lot-label photo."
      }
    ]
  }
}
```

响应包含 `ETag` 和 `Content-Language`，允许浏览器/CDN 缓存公开内容。可能错误：`400/404/429/500/503`；未配置 `DATABASE_URL` 时该端点仍返回 `501`。

## 5. 商品预筛

`POST /v1/recall-campaigns/{slug}/product-checks`

请求：

```json
{
  "shape": "Bear",
  "flavor": "Peach",
  "lotCode": "ML-2406-A",
  "dateCode": "06/2024"
}
```

成功 `200`：

```json
{
  "result": "potential_match",
  "message": "The product may be included in this recall.",
  "checkedCampaignVersion": 1,
  "disclaimer": "This check is preliminary and is not a final eligibility decision."
}
```

`result` 为 `potential_match|not_matched|manual_review`。预筛结果不能阻止用户提交，提交事务会重新核查。可能错误：`400/404/429/500/503`；未配置 `DATABASE_URL` 时另返回 `501`。

## 6. 创建匿名 Draft

`POST /v1/recall-campaigns/{slug}/claim-drafts`

无请求体。成功 `201`：

```json
{
  "draftId": "21326c9a-5dc2-430f-98a6-546729a1065f",
  "draftToken": "one-time-secret-with-at-least-32-characters",
  "expiresAt": "2026-08-05T12:00:00.000Z"
}
```

`draftToken` 只显示一次。前端仅在当前提交流程的内存/受控状态中保存，不写日志或分析事件。本阶段不支持 Save and Resume。可能错误：`400/404/429/500/503`；未配置 `DATABASE_URL` 时该端点仍返回 `501`。

## 7. 获取附件直传权限

`POST /v1/claim-drafts/{draftId}/upload-tokens`

Header：

```http
X-Draft-Token: one-time-secret-with-at-least-32-characters
```

请求：

```json
{
  "category": "product_photo",
  "fileName": "product-front.jpg",
  "mimeType": "image/jpeg",
  "sizeBytes": 2483120
}
```

成功 `201`：

```json
{
  "documentId": "a996d56a-da5e-49c3-bf76-665130bbb88a",
  "pathname": "drafts/21326c9a-5dc2-430f-98a6-546729a1065f/a996d56a-da5e-49c3-bf76-665130bbb88a/product-front.jpg",
  "clientToken": "short-lived-private-blob-token",
  "expiresAt": "2026-08-04T13:15:00.000Z"
}
```

前端用短期 `clientToken` 与 `pathname` 调 `@vercel/blob/client` 的 `put()` 直传 Private Blob：

```ts
import { put } from '@vercel/blob/client';

await put(authorization.pathname, file, {
  access: 'private',
  token: authorization.clientToken,
  contentType: file.type,
});
```

`pathname` 只用于这次上传，不得写入日志、分析事件或持久化到浏览器。
申请提交前需等待上传回调/状态验证；`documentId` 是后续提交使用的唯一文件引用。服务端按 Draft
绑定的 Campaign 版本校验类别、数量、MIME 和 `sizeBytes`（不满足分别返回 `413/415/422`），上传完成
回调（`POST /webhooks/vercel-blob`）会用 `head()` 取到的实际元数据再次核对 MIME，不一致则置
`rejected`，一致则置 `verified`。需要配置 `BLOB_READ_WRITE_TOKEN` 才接入真实 Blob；未配置时该
端点返回 `501`。

可能错误：`400/404/410/413/415/422/429/500/503`；未配置 `BLOB_READ_WRITE_TOKEN` 时另返回 `501`。

## 8. 删除未提交附件

`DELETE /v1/claim-drafts/{draftId}/documents/{documentId}`

Header 同上。成功 `204 No Content`。此操作只适用于尚未提交的 Draft；服务端把记录置为
`deletion_pending`，真实 Private Blob 对象由后续清理任务删除。

可能错误：`400/404/410/429/500/503`；未配置 `BLOB_READ_WRITE_TOKEN` 时另返回 `501`。

## 9. 提交 Recall Claim

`POST /v1/recall-campaigns/{slug}/claims`

Header 必填：

```http
Idempotency-Key: 8a26f959-cc29-4990-b7e7-823031498393
Content-Type: application/json
```

请求示例（无事故）：

```json
{
  "draftId": "21326c9a-5dc2-430f-98a6-546729a1065f",
  "draftToken": "one-time-secret-with-at-least-32-characters",
  "locale": "en-US",
  "consumer": {
    "firstName": "Taylor",
    "lastName": "Example",
    "email": "taylor@example.com",
    "phone": "+1-555-010-2042",
    "mailingAddress": {
      "line1": "100 Example Street",
      "city": "Austin",
      "state": "TX",
      "postalCode": "78701",
      "countryCode": "US"
    }
  },
  "products": [
    {
      "campaignProductId": "5e41d8b9-03c4-46d4-9b87-80c40cdfbde5",
      "quantity": 1,
      "shape": "Bear",
      "flavor": "Peach",
      "lotCode": "ML-2406-A",
      "dateCode": "06/2024",
      "purchaseChannel": "amazon",
      "purchaseDate": "2026-07-10",
      "orderNumber": "DEMO-ORDER-1001"
    }
  ],
  "remedyCode": "replacement",
  "documentIds": ["a996d56a-da5e-49c3-bf76-665130bbb88a", "de0d8447-2889-4500-89bc-e81a27d17de5"],
  "consents": [
    { "type": "privacy_notice", "textVersion": "2026-08-04", "accepted": true },
    { "type": "information_accuracy", "textVersion": "2026-08-04", "accepted": true }
  ],
  "incidentAnswer": "no"
}
```

成功 `201`：

```json
{
  "caseReference": "KOI-7N4Q-A91M2X6P",
  "submittedAt": "2026-08-04T13:00:00.000Z",
  "emailStatus": "queued",
  "nextStep": "Keep this reference. We will email you after your claim has been received."
}
```

`emailStatus=queued` 只表示确认邮件已进入 Outbox，不代表 Resend 已发送或送达。
该事务中 Communication 与 Outbox 和 Case 聚合一起提交；任一写入失败时整个申请回滚。

### 9.1 幂等规则

- Key 长度 16–128，仅保存哈希。
- 相同 Key + 相同规范化请求：返回首次成功的状态码和响应体，不重复创建 Case 或邮件。
- 相同 Key + 不同请求：返回 `409`。
- 发生网络超时、连接中断或无法确定服务端是否已提交时，前端必须复用原 Key 和原请求体。只有用户主动开始新申请时才生成新 Key。

### 9.2 事故条件字段

所有申请必须传 `incidentAnswer=no|yes|unsure`。

- `no`：必须省略 `incidentDetails`，不创建 Incident。
- `yes`：必须传 `incidentDetails.eventTypes` 和至少 10 字符的事实叙述；必须传 `occurredDate`，或设置 `occurredDateUnknown=true`。
- `unsure`：只强制事实叙述；事件类型、日期和其他字段可省略，Case 自动走人工审查。服务端在持久化时将缺省事件类型规范化为 `unknown`。
- `eventTypes` 包含 `injury` 或 `illness`：`injurySeverity` 与 `medicalTreatment` 条件必填。
- 事故/伤害不会阻止提交普通补救申请；`yes|unsure` 会创建 Incident 和默认 `pending` 的报告性审查。

事故请求片段：

```json
{
  "incidentAnswer": "yes",
  "incidentDetails": {
    "eventTypes": ["injury"],
    "narrative": "A small component separated while the product was being used.",
    "occurredDateUnknown": true,
    "injurySeverity": "minor",
    "medicalTreatment": "first_aid",
    "usedAsIntended": "yes"
  }
}
```

可能错误：`400/404/409/410/422/429/500/503`；未配置 `DATABASE_URL` 或缺少任一 Crypto Secret 时另返回 `501`。

## 10. HTTP 错误码总表

| Status | Meaning                                                 |
| -----: | ------------------------------------------------------- |
|  `400` | JSON、路径、Query、Header 或运行时 Schema 无效。        |
|  `404` | 公开 Campaign、Draft 或 Document 不存在/不可访问。      |
|  `409` | Idempotency 冲突、Draft 已使用或并发状态冲突。          |
|  `410` | Draft 或上传授权已过期。                                |
|  `413` | 文件超过 Campaign 限制。                                |
|  `415` | MIME 不在允许列表。                                     |
|  `422` | 产品、附件、补救或事故条件规则未满足。                  |
|  `429` | 请求过多。                                              |
|  `500` | 未预期服务端错误。                                      |
|  `501` | 当前未启用的可选 Provider，或已注册但未实现的后续能力。 |
|  `503` | 数据库、Blob 等必需依赖暂不可用。                       |

## 11. 非 ToC 入口

以下路径不写入 ToC OpenAPI，也不能由浏览器业务页面直接调用：

- `GET /internal/jobs/outbox`
- `GET /internal/jobs/cleanup-drafts`
- `POST /webhooks/vercel-blob`
- `POST /webhooks/resend`

`/webhooks/vercel-blob` 的签名验证、上传 reconciliation 和去重已实现；只有完成 reconciliation 后才确认 Blob 回调。`/internal/jobs/outbox`、`/internal/jobs/cleanup-drafts` 和 `/webhooks/resend` 仍返回 `501`；后续实现必须验证 Cron Secret 与 Resend/Svix 签名，并使用 `webhook_events` 的 `processing/processed/failed` 状态实现可重试去重。

当前不提供 Admin API。Phase 1 预定的人工查看语义是：只有一种授权后台用户，由后端在授权边界内解密并允许查看/导出完整数据；本阶段不实现多级权限或脱敏展示。

## 12. Draft 附件状态列表（六态 UI）

`GET /v1/claim-drafts/{draftId}/documents`

Header 同删除附件：`X-Draft-Token`。成功 `200`：

```json
{
  "documents": [
    {
      "documentId": "a996d56a-da5e-49c3-bf76-665130bbb88a",
      "category": "proof_of_purchase",
      "fileName": "receipt.jpg",
      "status": "scan_pending",
      "statusReason": null,
      "uploadedAt": "2026-08-27T03:12:00.000Z",
      "lastStatusChangedAt": "2026-08-27T03:13:41.000Z"
    }
  ]
}
```

- 六态枚举：`uploading` / `verifying` / `verified` / `scan_pending` / `rejected` / `expired`。
- `statusReason` 仅在 `rejected` 时给出脱敏枚举（`mime_mismatch | malware_detected`），不含扫描引擎细节。
- 已删除（`deletion_pending/deleted`）或已随提交挂接 Case 的文档不再出现在列表中。
- 上传回调 reconciliation 分两步落库：先写回实际元数据并置中间态 `uploaded`（对应公开
  `verifying`），再判定 `verified/rejected`，因此前端能观察到真实的 verifying 窗口。
- 含未 `verified` 文档的 Claim 提交仍被 `422` 拒绝，ProblemDetails.detail 会指明未通过的 `documentId`。

可能错误：`400/404/410/429/500/501/503`。

## 13. 公开案件状态查询

`POST /v1/case-status-lookups`（公开端点，无需鉴权；按 IP 限流 **10 次/分钟**，超出返回带
Request ID 的 `429` ProblemDetails）。

```json
{ "caseReference": "KOI-B2C4-D6E8F0A1", "email": "consumer@example.com" }
```

校验方式：对 `caseReference + email` 做 peppered HMAC 比对（命中 `case_consumers.email_lookup_hash`），
全程不解密任何 PII。不存在的 reference 与 email 不匹配返回**字节级一致**的 `404` ProblemDetails，
reference 无法被枚举。`is_test_data = true` 的 Campaign 下的 Case 永不可查（合成数据治理）。

成功响应严格为白名单字段：

```json
{
  "caseReference": "KOI-B2C4-D6E8F0A1",
  "campaignTitle": "Music Lollipop Recall",
  "publicStatus": "in_review",
  "publicStatusLabel": "Under review",
  "consumerNextAction": "Your claim is under review. No action is needed right now.",
  "requestedResolution": "Replacement",
  "approvedResolution": null,
  "lastUpdatedAt": "2026-08-20T09:30:00.000Z"
}
```

- `publicStatus` 固定八值：`received / in_review / action_required / resolution_approved /
resolution_in_progress / completed / not_approved / closed`；标签与下一步文案由 API 产出，前端透传。
- 内部状态映射（确定性、穷举测试覆盖）：`submitted→received`；`triage|under_review→in_review`；
  `need_info→action_required`；`approved→resolution_approved`；`closure_review→resolution_in_progress`；
  `closed→completed`（此前有批准或外部完成）或 `closed`；`rejected|duplicate→not_approved`；
  `withdrawn→closed`。
- `approvedResolution` 仅当批准事实对消费者可见（进入 resolution 阶段之后）才返回，否则为 `null`；
- 响应中永不出现任何姓名、电话、地址、refundAmount 等原始 PII 或内部字段。

可能错误：`400/404/429/500/501/503`。

### 13.1 旧查询端点弃用

`GET /v1/consumer-auth/lookup/{claimNumber}?phone=` 返回含完整 PII 的 Claim 对象，现已在 OpenAPI 中
标注 `deprecated: true`，契约原样保留一个过渡窗口。新集成一律使用 `POST /v1/case-status-lookups`，
过渡窗口结束后旧端点将被移除。
