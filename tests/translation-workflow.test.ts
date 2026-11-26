import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import type { DatabaseHandle, DatabaseExecutor } from '../src/db/client.js';
import { DrizzleCampaignService } from '../src/modules/campaigns/drizzle-campaign-service.js';
import { DrizzleTranslationService } from '../src/modules/campaigns/translation-service.js';
import { applyTranslation, emptyTranslation, sourceContent } from '../src/modules/campaigns/translation-content.js';
import type { CampaignView } from '../src/contracts/campaigns.js';

const version = '00000000-0000-4000-8000-000000000001';
const product = '00000000-0000-4000-8000-000000000002';
const source = {
  slug: 'test', code: 'SKU-UNCHANGED', version: 1, locale: 'en-US', title: 'Recall', summary: 'Summary',
  hazard: 'Hazard', immediateAction: 'Stop use', remedySummary: 'Refund',
  support: { hours: 'Monday', email: 'support@koi-platform.com', phone: '+1234567890' },
  products: [{ productId: product, name: 'Product', description: '', sku: 'SKU-123', affectedLots: ['LOT-1'] }],
  remedies: [{ code: 'refund', displayName: 'Refund', description: '' }],
  evidenceRequirements: [{ category: 'product_photo', instructions: 'Upload photo', minimumFiles: 1, maximumFiles: 3 }], faq: [],
} as unknown as CampaignView;

describe('reviewed database translations', () => {
  const pg = new PGlite();
  const db = drizzle(pg);
  const invalidate = vi.fn(() => Promise.resolve({ invalidated: true }));
  const service = new DrizzleTranslationService({ db, transaction: (work: Parameters<DatabaseHandle['transaction']>[0]) => db.transaction((tx) => work(tx as unknown as DatabaseExecutor)) } as unknown as DatabaseHandle, { invalidateCampaign: invalidate });
  beforeAll(async () => {
    await pg.exec(`CREATE TABLE campaign_versions (id uuid PRIMARY KEY, version_number integer, status text);
      CREATE TABLE recall_campaigns (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), slug text, status text, default_locale text, published_version_id uuid);
      CREATE TABLE recall_cases (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), campaign_version_id uuid);
      CREATE TABLE staff_users (id uuid PRIMARY KEY);
      INSERT INTO staff_users VALUES ('00000000-0000-4000-8000-000000000010'),('00000000-0000-4000-8000-000000000011'),('00000000-0000-4000-8000-000000000012'),('00000000-0000-4000-8000-000000000013');
      CREATE TABLE admin_audit_events (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),actor_user_id uuid REFERENCES staff_users(id),actor_role varchar(24),action varchar(80) NOT NULL,resource_type varchar(40),resource_id varchar(160),outcome text NOT NULL,reason_code varchar(80),metadata jsonb DEFAULT '{}'::jsonb,occurred_at timestamptz DEFAULT now(),ip_address_hash varchar(128),user_agent_hash varchar(128));
      CREATE FUNCTION reject_translation_audit() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'Audit storage unavailable'; END; $$ LANGUAGE plpgsql;
      INSERT INTO campaign_versions VALUES ('${version}',1,'published');
      INSERT INTO recall_campaigns (slug,status,default_locale,published_version_id) VALUES ('test','active','en-US','${version}');`);
    for (const file of ['0030_campaign_translation_revisions.sql', '0031_translation_case_provenance.sql']) {
      await pg.exec(readFileSync(new URL(`../drizzle/${file}`, import.meta.url), 'utf8'));
    }
    vi.spyOn(DrizzleCampaignService.prototype, 'getPublishedCampaign').mockImplementation(() => Promise.resolve(structuredClone(source)));
  }, 30000);
  afterAll(async () => { vi.restoreAllMocks(); await pg.close(); });

  async function rejectedAudit(work: () => Promise<unknown>) {
    await pg.exec('CREATE TRIGGER reject_audit BEFORE INSERT ON admin_audit_events FOR EACH ROW EXECUTE FUNCTION reject_translation_audit()');
    try { await expect(work()).rejects.toThrow(); }
    finally { await pg.exec('DROP TRIGGER reject_audit ON admin_audit_events'); }
  }

  it('keeps drafts private, rejects stale saves, requires review and preserves published history', async () => {
    let ws = await service.workspace('test');
    expect(ws.latest).toBeNull();
    expect(emptyTranslation(ws.source).title).toBe('');
    const translated = structuredClone(ws.source);
    translated.title = 'Retirada';
    await rejectedAudit(() => service.save('test', { sourceVersionId: version, sourceHash: ws.sourceHash, revisionId: null, editVersion: 0, content: translated }, '00000000-0000-4000-8000-000000000010', 'ADMIN'));
    expect((await service.workspace('test')).latest).toBeNull();
    expect((await pg.query('SELECT count(*)::int AS n FROM admin_audit_events')).rows).toEqual([{n:0}]);
    ws = await service.save('test', { sourceVersionId: version, sourceHash: ws.sourceHash, revisionId: null, editVersion: 0, content: translated }, '00000000-0000-4000-8000-000000000010', 'ADMIN');
    const first = ws.latest!;
    await rejectedAudit(() => service.save('test', { sourceVersionId: version, sourceHash: ws.sourceHash, revisionId: first.id, editVersion: first.editVersion, content: {...translated,title:'MUST ROLLBACK'} }, '00000000-0000-4000-8000-000000000010', 'ADMIN'));
    expect((await service.workspace('test')).latest).toEqual(first);
    await rejectedAudit(() => service.transition('test', {revisionId:first.id,editVersion:first.editVersion,action:'submit',note:''}, '00000000-0000-4000-8000-000000000010', 'ADMIN'));
    expect((await service.workspace('test')).latest).toEqual(first);
    expect(ws.published).toBeNull();
    await expect(service.save('test', { sourceVersionId: version, sourceHash: ws.sourceHash, revisionId: first.id, editVersion: 0, content: translated }, '00000000-0000-4000-8000-000000000013', 'ADMIN')).rejects.toThrow(/changed/);
    await expect(service.transition('test', { revisionId: first.id, editVersion: first.editVersion, action: 'publish', note: '' }, '00000000-0000-4000-8000-000000000010', 'ADMIN')).rejects.toThrow(/Cannot publish/);
    ws = await service.transition('test', { revisionId: first.id, editVersion: first.editVersion, action: 'submit', note: '' }, '00000000-0000-4000-8000-000000000010', 'ADMIN');
    expect(ws.published).toBeNull();
    await expect(pg.query(`UPDATE campaign_translation_revisions SET content = '{}' WHERE id = $1`, [first.id])).rejects.toThrow(/immutable/);
    await expect(service.transition('test', { revisionId: first.id, editVersion: ws.latest!.editVersion, action: 'approve', note: '' }, '00000000-0000-4000-8000-000000000011', 'ADMIN')).rejects.toThrow(/reference/);
    ws = await service.transition('test', { revisionId: first.id, editVersion: ws.latest!.editVersion, action: 'approve', note: 'REVIEW-123' }, '00000000-0000-4000-8000-000000000011', 'ADMIN');
    const approved = ws.latest!;
    await rejectedAudit(() => service.transition('test', {revisionId:first.id,editVersion:approved.editVersion,action:'publish',note:''}, '00000000-0000-4000-8000-000000000012', 'ADMIN'));
    expect((await service.workspace('test')).latest).toEqual(approved);
    expect((await service.workspace('test')).published).toBeNull();
    expect(invalidate).not.toHaveBeenCalled();
    ws = await service.transition('test', { revisionId: first.id, editVersion: ws.latest!.editVersion, action: 'publish', note: '' }, '00000000-0000-4000-8000-000000000012', 'ADMIN');
    expect(ws.published!.content.title).toBe('Retirada');
    expect(ws.published!.reviewReference).toBe('REVIEW-123');
    const audit = await pg.query<{ action: string; resource_id: string; actor_user_id: string; actor_role: string }>('SELECT action,resource_id,actor_user_id,actor_role FROM admin_audit_events ORDER BY occurred_at,id');
    expect(audit.rows).toHaveLength(4);
    expect(audit.rows.filter(r=>r.action==='campaign.translation.publish')).toEqual([{action:'campaign.translation.publish',resource_id:first.id,actor_user_id:'00000000-0000-4000-8000-000000000012',actor_role:'ADMIN'}]);
    expect(invalidate).toHaveBeenCalledWith('test');
    await expect(pg.query(`INSERT INTO recall_cases (campaign_version_id,content_locale,content_translation_id) VALUES ($1,'en-US',$2)`, [version, first.id])).rejects.toThrow(/foreign key/);
    await expect(pg.query(`INSERT INTO recall_cases (campaign_version_id,content_locale,content_translation_id) VALUES ($1,'es-US',$2)`, [version, first.id])).resolves.toBeDefined();
    await expect(pg.query(`DELETE FROM campaign_translation_revisions WHERE id = $1`, [first.id])).rejects.toThrow(/cannot be deleted/);
    const localized = applyTranslation(source, translated, { id: first.id, revision: 1, sourceVersion: 1 });
    expect(localized.products[0]!.sku).toBe('SKU-123');
    expect(localized.evidenceRequirements[0]!.maximumFiles).toBe(3);
    expect(localized.support.email).toBe(source.support.email);
    const invalid = structuredClone(translated); invalid.products[0]!.productId = version;
    await expect(service.save('test', { sourceVersionId: version, sourceHash: ws.sourceHash, revisionId: null, editVersion: 0, content: invalid }, '00000000-0000-4000-8000-000000000010', 'ADMIN')).rejects.toThrow(/identifiers/);
    source.summary = 'Updated source';
    ws = await service.workspace('test');
    expect(ws.publishedNeedsUpdate).toBe(true);
    expect(sourceContent(source).summary).toBe('Updated source');
    await expect(service.save('test', { sourceVersionId: version, sourceHash: first.sourceHash, revisionId: null, editVersion: 0, content: translated }, '00000000-0000-4000-8000-000000000010', 'ADMIN')).rejects.toThrow(/source text changed/);
    ws = await service.save('test', { sourceVersionId: version, sourceHash: ws.sourceHash, revisionId: null, editVersion: 0, content: emptyTranslation(ws.source) }, '00000000-0000-4000-8000-000000000010', 'ADMIN');
    expect(ws.latest!.revision).toBe(2);
    expect(ws.published!.id).toBe(first.id);
    await expect(service.transition('test', { revisionId: ws.latest!.id, editVersion: ws.latest!.editVersion, action: 'submit', note: '' }, '00000000-0000-4000-8000-000000000010', 'ADMIN')).rejects.toThrow(/Complete these translations/);
    ws = await service.save('test', { sourceVersionId: version, sourceHash: ws.sourceHash, revisionId: ws.latest!.id, editVersion: ws.latest!.editVersion, content: structuredClone(ws.source) }, '00000000-0000-4000-8000-000000000010', 'ADMIN');
    ws = await service.transition('test', { revisionId: ws.latest!.id, editVersion: ws.latest!.editVersion, action: 'submit', note: '' }, '00000000-0000-4000-8000-000000000010', 'ADMIN');
    const submitted = ws.latest!;
    await rejectedAudit(() => service.transition('test', { revisionId: submitted.id, editVersion: submitted.editVersion, action: 'approve', note: 'REVIEW-456' }, '00000000-0000-4000-8000-000000000011', 'ADMIN'));
    expect((await service.workspace('test')).latest).toEqual(submitted);
    await rejectedAudit(() => service.transition('test', { revisionId: submitted.id, editVersion: submitted.editVersion, action: 'request_changes', note: 'Please revise' }, '00000000-0000-4000-8000-000000000011', 'ADMIN'));
    expect((await service.workspace('test')).latest).toEqual(submitted);
    ws = await service.transition('test', { revisionId: submitted.id, editVersion: submitted.editVersion, action: 'approve', note: 'REVIEW-456' }, '00000000-0000-4000-8000-000000000011', 'ADMIN');
    const secondApproved = ws.latest!;
    await rejectedAudit(() => service.transition('test', { revisionId: secondApproved.id, editVersion: secondApproved.editVersion, action: 'publish', note: '' }, '00000000-0000-4000-8000-000000000012', 'ADMIN'));
    ws = await service.workspace('test');
    expect(ws.latest).toEqual(secondApproved);
    expect(ws.published!.id).toBe(first.id);
    expect(invalidate).toHaveBeenCalledTimes(1);
    ws = await service.transition('test', { revisionId: secondApproved.id, editVersion: secondApproved.editVersion, action: 'publish', note: '' }, '00000000-0000-4000-8000-000000000012', 'ADMIN');
    expect(ws.published!.id).toBe(secondApproved.id);
    expect(ws.history.find(r => r.id === first.id)!.status).toBe('superseded');
  });
});
