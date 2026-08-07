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
    const [readme, architecture, apiDoc] = await Promise.all([
      readFile('README.md', 'utf8'),
      readFile('docs/phase-1/01-server-architecture.md', 'utf8'),
      readFile('docs/phase-1/03-toc-api.md', 'utf8'),
    ]);

    expect(readme).toContain('Claim 提交');
    expect(readme).toContain('FIELD_ENCRYPTION_KEY');
    expect(apiDoc).toContain('emailStatus=queued');
    expect(apiDoc).toContain('Resend');
    expect(architecture).toContain('Neon Serverless Pool');
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
    expect(documents[1]).toContain('非交互式事务');
    expect(documents[2]).toContain('501');
  });
});
