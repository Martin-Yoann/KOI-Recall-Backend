import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

const tableNames = [
  'recall_campaigns',
  'campaign_versions',
  'campaign_localizations',
  'campaign_products',
  'campaign_product_lots',
  'campaign_remedy_options',
  'campaign_evidence_requirements',
  'campaign_message_templates',
  'claim_drafts',
  'document_uploads',
  'recall_cases',
  'case_consumers',
  'claimed_products',
  'case_consents',
  'submission_snapshots',
  'incidents',
  'reportability_reviews',
  'case_events',
  'communications',
  'outbox_events',
  'idempotency_records',
  'webhook_events',
];

const publicPaths = [
  '/v1/recall-campaigns/{slug}',
  '/v1/recall-campaigns/{slug}/product-checks',
  '/v1/recall-campaigns/{slug}/claim-drafts',
  '/v1/claim-drafts/{draftId}/upload-tokens',
  '/v1/claim-drafts/{draftId}/documents/{documentId}',
  '/v1/recall-campaigns/{slug}/claims',
];

describe('documentation cross-check', () => {
  it('documents the enabled Claim submission path without overstating delivery', async () => {
    const [readme, architecture, apiDoc, frontendDoc] = await Promise.all([
      readFile('README.md', 'utf8'),
      readFile('docs/phase-1/01-server-architecture.md', 'utf8'),
      readFile('docs/phase-1/03-toc-api.md', 'utf8'),
      readFile('docs/phase-1/04-frontend-integration.md', 'utf8'),
    ]);

    expect(readme).toContain('Claim 提交');
    expect(readme).toContain('FIELD_ENCRYPTION_KEY');
    expect(apiDoc).toContain('emailStatus=queued');
    expect(apiDoc).toContain('不代表 Resend 已发送或送达');
    expect(architecture).toContain('Neon Serverless Pool');
    expect(architecture).toContain('Resend 投递与 Webhook');
    expect(architecture).toContain('Admin API 和 Vercel 部署仍未实现');
    expect(architecture).toContain('Phase 1 只定义一种授权后台用户');
    expect(architecture).toContain('允许查看/导出完整数据');
    expect(architecture).toContain('不实现多级权限或字段脱敏');
    expect(frontendDoc).toContain('重试必须复用原 Key 和完全相同的请求体');
    expect(frontendDoc).toContain('不要在前端持有 `FIELD_ENCRYPTION_KEY` 或 `HASH_PEPPER`');
    expect(frontendDoc).toContain('这两项只属于后端运行环境');
    expect(readme).not.toContain('Claim 提交固定返回 `501`');
    expect(readme).not.toContain('Claim 提交端点仍返回');
    expect(apiDoc).not.toContain('Claim 提交固定返回 `501`');
    expect(apiDoc).not.toContain('Claim 提交端点仍返回');
    expect(architecture).not.toContain('Claim 提交端点仍明确返回');
  });

  it('database document names every schema table', async () => {
    const design = await readFile('docs/phase-1/02-database-design.md', 'utf8');

    for (const tableName of tableNames) expect(design).toContain(tableName);
  });

  it('ToC document names every public path', async () => {
    const api = await readFile('docs/phase-1/03-toc-api.md', 'utf8');

    for (const path of publicPaths) expect(api).toContain(path);
  });

  it('all documents distinguish the 501 skeleton from live providers', async () => {
    const documents = await Promise.all([
      readFile('docs/phase-1/01-server-architecture.md', 'utf8'),
      readFile('docs/phase-1/02-database-design.md', 'utf8'),
      readFile('docs/phase-1/03-toc-api.md', 'utf8'),
    ]);

    expect(documents[0]).toContain('501');
    expect(documents[1]).toContain('Neon Serverless Pool 交互式事务');
    expect(documents[2]).toContain('501');
  });
});
