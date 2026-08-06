# KOI Recall 第一阶段 ToC API

## 1. 范围与状态

本文是前端对接说明；字段名和示例保持英文，说明使用中文。机器契约见 `openapi/toc-v1.openapi.yaml`，其唯一来源为 `src/contracts/toc.ts`。

当前代码是接口骨架：路由和验证已生效；Campaign 查询、商品预筛和匿名 Draft 创建端点在配置 `DATABASE_URL` 时读写真实数据库，其余三个业务端点返回 `501 Not Implemented`。本阶段仍不访问 Blob 或邮件服务。实现业务后保持本文与 OpenAPI 的请求/响应不变。

不提供消费者账户、Case 查询、状态门户、修改或撤回接口。确认页使用提交响应，不通过公开 GET 暴露 Case。

## 2. 通用协议

- Base URL：本地 `http://localhost:3000`；生产域名待定。
- 版本前缀：`/v1`。
- 请求/成功响应：`application/json`；错误：`application/problem+json`。
- 首期 locale 只接受 `en-US`。数据库允许未来加入 `es-US`；启用前端语言后更新 API enum。
- `X-Request-Id`：可由客户端提供，也可由服务端生成；响应总会返回。
- CORS：只允许配置的消费者站点 Origin，不允许 `*`。
- 公开响应不会包含 Blob pathname、内部 Case UUID、密文、HMAC、Provider 错误正文或数据库顺序号。

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
5. 用户删除附件时调用 `DELETE /v1/claim-drafts/{draftId}/documents/{documentId}`。
6. `POST /v1/recall-campaigns/{slug}/claims` 完成提交。

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

`result` 为 `potential_match|not_matched|manual_review`。预筛结果不能阻止用户提交，提交事务会重新核查。可能错误：`400/404/429/500/503`；骨架另返回 `501`。

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
  "uploadUrl": "https://blob-upload.example.invalid/client-upload",
  "clientToken": "short-lived-private-blob-token",
  "expiresAt": "2026-08-04T13:15:00.000Z"
}
```

前端用短期参数直接上传 Blob。申请提交前需等待上传回调/状态验证；`documentId` 是后续提交使用的唯一文件引用。服务端按 Campaign 版本校验类别、数量、MIME 和 `sizeBytes`，回调还会检查实际元数据。

可能错误：`400/404/410/413/415/422/429/500/503`；骨架另返回 `501`。

## 8. 删除未提交附件

`DELETE /v1/claim-drafts/{draftId}/documents/{documentId}`

Header 同上。成功 `204 No Content`。此操作只适用于尚未提交的 Draft；服务端先撤销引用，再由清理任务删除 Private Blob。

可能错误：`400/404/410/429/500/503`；骨架另返回 `501`。

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

### 9.1 幂等规则

- Key 长度 16–128，仅保存哈希。
- 相同 Key + 相同规范化请求：返回首次成功的状态码和响应体，不重复创建 Case 或邮件。
- 相同 Key + 不同请求：返回 `409`。
- 前端重试网络超时时必须复用原 Key；用户主动开始新申请时生成新 Key。

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

可能错误：`400/404/409/410/422/429/500/503`；骨架另返回 `501`。

## 10. HTTP 错误码总表

| Status | Meaning                                            |
| -----: | -------------------------------------------------- |
|  `400` | JSON、路径、Query、Header 或运行时 Schema 无效。   |
|  `404` | 公开 Campaign、Draft 或 Document 不存在/不可访问。 |
|  `409` | Idempotency 冲突、Draft 已使用或并发状态冲突。     |
|  `410` | Draft 或上传授权已过期。                           |
|  `413` | 文件超过 Campaign 限制。                           |
|  `415` | MIME 不在允许列表。                                |
|  `422` | 产品、附件、补救或事故条件规则未满足。             |
|  `429` | 请求过多。                                         |
|  `500` | 未预期服务端错误。                                 |
|  `501` | 当前骨架已声明契约但尚未实现业务。                 |
|  `503` | 数据库、Blob 等必需依赖暂不可用。                  |

## 11. 非 ToC 入口

以下路径不写入 ToC OpenAPI，也不能由浏览器业务页面直接调用：

- `GET /internal/jobs/outbox`
- `GET /internal/jobs/cleanup-drafts`
- `POST /webhooks/vercel-blob`
- `POST /webhooks/resend`

生产实现必须验证 Cron Secret、Blob callback token 和 Resend/Svix 签名，并使用 `webhook_events` 去重。
