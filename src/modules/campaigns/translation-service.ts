import { and, desc, eq } from 'drizzle-orm';
import type { DatabaseHandle, DatabaseExecutor } from '../../db/client.js';
import { campaignTranslationRevisions as revisions, campaignVersions, recallCampaigns } from '../../db/schema/index.js';
import { DrizzleCampaignService } from './drizzle-campaign-service.js';
import { DrizzleAuditService } from '../staff/drizzle-audit-service.js';
import type { StaffRole } from '../staff/permissions.js';
import type { CampaignCacheInvalidator } from '../../platform/cache-invalidation/port.js';
import { CampaignValidationError, ClaimConflictError, ResourceNotFoundError } from '../../shared/errors.js';
import { assertTranslationShape, contentHash, emptyTranslation, missingTranslationFields, sourceContent, type TranslationContent } from './translation-content.js';

type Revision = typeof revisions.$inferSelect;
export interface TranslationWorkspace {
  sourceVersionId: string; sourceVersion: number; sourceLocale: string; sourceHash: string; locale: 'es-US';
  source: TranslationContent; empty: TranslationContent; latest: Revision | null; published: Revision | null;
  history: Array<Omit<Revision, 'content' | 'source'>>; needsUpdate: boolean; publishedNeedsUpdate: boolean; missing: string[];
}
export interface SaveTranslation { sourceVersionId: string; sourceHash: string; revisionId: string | null; editVersion: number; content: TranslationContent }
export interface TransitionTranslation { revisionId: string; editVersion: number; action: 'submit' | 'approve' | 'request_changes' | 'publish'; note: string }
export interface TranslationService {
  workspace(slug: string): Promise<TranslationWorkspace>;
  save(slug: string, input: SaveTranslation, actor: string, actorRole: StaffRole): Promise<TranslationWorkspace>;
  transition(slug: string, input: TransitionTranslation, actor: string, actorRole: StaffRole): Promise<TranslationWorkspace>;
}

export class DrizzleTranslationService implements TranslationService {
  constructor(private readonly handle: Pick<DatabaseHandle, 'db' | 'transaction'>, private readonly invalidator: CampaignCacheInvalidator) {}
  private async source(slug: string, db: DatabaseExecutor = this.handle.db) {
    const [row] = await db.select({ id: campaignVersions.id, number: campaignVersions.versionNumber, locale: recallCampaigns.defaultLocale })
      .from(recallCampaigns).innerJoin(campaignVersions, eq(campaignVersions.id, recallCampaigns.publishedVersionId))
      .where(and(eq(recallCampaigns.slug, slug), eq(recallCampaigns.status, 'active'), eq(campaignVersions.status, 'published'))).limit(1);
    if (!row) throw new ResourceNotFoundError('Published source campaign was not found.');
    if (row.locale !== 'en-US') throw new CampaignValidationError('This translation workspace requires an English source campaign.');
    const view = await new DrizzleCampaignService({ db, transaction: (work) => work(db) }).getPublishedCampaign({ slug, locale: 'en-US' });
    if (!view || view.version !== row.number) throw new ClaimConflictError('The source version changed. Reload the translation workspace.');
    const content = sourceContent(view);
    return { id: row.id, number: row.number, locale: row.locale, content, hash: contentHash(content) };
  }
  async workspace(slug: string): Promise<TranslationWorkspace> {
    const source = await this.source(slug);
    const rows = await this.handle.db.select().from(revisions).where(and(eq(revisions.campaignVersionId, source.id), eq(revisions.locale, 'es-US'))).orderBy(desc(revisions.revision)).limit(30);
    const latest = rows[0] ?? null;
    const [published] = await this.handle.db.select().from(revisions).where(and(eq(revisions.campaignVersionId, source.id), eq(revisions.locale, 'es-US'), eq(revisions.status, 'published'))).limit(1);
    return { sourceVersionId: source.id, sourceVersion: source.number, sourceLocale: source.locale, sourceHash: source.hash, locale: 'es-US', source: source.content, empty: emptyTranslation(source.content), latest, published: published ?? null, publishedNeedsUpdate: Boolean(published && published.sourceHash !== source.hash),
      history: rows.map(({ content: _content, source: _source, ...row }) => { void _content; void _source; return row; }),
      needsUpdate: Boolean(latest && latest.sourceHash !== source.hash), missing: missingTranslationFields(source.content, latest?.content ?? emptyTranslation(source.content)) };
  }
  async save(slug: string, input: SaveTranslation, actor: string, actorRole: StaffRole): Promise<TranslationWorkspace> {
    await this.handle.transaction(async (tx) => {
      const [locked] = await tx.select({ versionId: recallCampaigns.publishedVersionId }).from(recallCampaigns).where(eq(recallCampaigns.slug, slug)).for('update');
      if (!locked?.versionId || locked.versionId !== input.sourceVersionId) throw new ClaimConflictError('The source campaign version changed. Reload before saving.');
      const source = await this.source(slug, tx);
      if (source.hash !== input.sourceHash) throw new ClaimConflictError('The source text changed. Reload before saving. Your draft was not overwritten.');
      assertTranslationShape(source.content, input.content);
      const now = new Date();
      let resourceId = input.revisionId;
      if (input.revisionId) {
        const [row] = await tx.select().from(revisions).where(and(eq(revisions.id, input.revisionId), eq(revisions.campaignVersionId, source.id), eq(revisions.locale, 'es-US'))).for('update');
        if (!row || row.status !== 'draft' || row.editVersion !== input.editVersion || row.sourceHash !== source.hash) throw new ClaimConflictError('This translation changed or is no longer an editable draft. Reload before saving.');
        await tx.update(revisions).set({ content: input.content, editVersion: row.editVersion + 1, updatedBy: actor, updatedAt: now }).where(eq(revisions.id, row.id));
      } else {
        if (input.editVersion !== 0) throw new ClaimConflictError('A new draft must start with editVersion 0.');
        const [latest] = await tx.select().from(revisions).where(and(eq(revisions.campaignVersionId, source.id), eq(revisions.locale, 'es-US'))).orderBy(desc(revisions.revision)).limit(1);
        if (latest && ['draft', 'submitted', 'approved'].includes(latest.status)) {
          if (latest.sourceHash === source.hash) throw new ClaimConflictError('A working translation already exists. Reload it before editing.');
          await tx.update(revisions).set({ status: 'changes_requested', editVersion: latest.editVersion + 1, updatedAt: now, updatedBy: actor, history: [...latest.history, { action: 'source_changed', actor, at: now.toISOString() }] }).where(eq(revisions.id, latest.id));
        }
        const [created] = await tx.insert(revisions).values({ campaignVersionId: source.id, locale: 'es-US', revision: (latest?.revision ?? 0) + 1, sourceHash: source.hash, source: source.content, content: input.content, createdBy: actor, updatedBy: actor, history: [{ action: 'created', actor, at: now.toISOString() }] }).returning({ id: revisions.id });
        resourceId = created!.id;
      }
      // The same executor is essential: audit failure rolls back the draft too.
      await new DrizzleAuditService(tx).record({ actorUserId: actor, actorRole, action: 'campaign.translation.save', resourceType: 'campaign_translation', resourceId: resourceId!, outcome: 'success' });
    });
    return this.workspace(slug);
  }
  async transition(slug: string, input: TransitionTranslation, actor: string, actorRole: StaffRole): Promise<TranslationWorkspace> {
    await this.handle.transaction(async (tx) => {
      const [campaign] = await tx.select({ versionId: recallCampaigns.publishedVersionId }).from(recallCampaigns).where(eq(recallCampaigns.slug, slug)).for('update');
      if (!campaign?.versionId) throw new ResourceNotFoundError('Source campaign was not found.');
      const [row] = await tx.select().from(revisions).where(and(eq(revisions.id, input.revisionId), eq(revisions.campaignVersionId, campaign.versionId), eq(revisions.locale, 'es-US'))).for('update');
      if (!row || row.editVersion !== input.editVersion) throw new ClaimConflictError('The translation changed. Reload before taking action.');
      const source = await this.source(slug, tx);
      if (row.sourceHash !== source.hash && input.action !== 'request_changes') throw new ClaimConflictError('The source changed. Start a new draft against the current source.');
      const allowed = { submit: ['draft'], approve: ['submitted'], request_changes: ['submitted', 'approved'], publish: ['approved'] };
      if (!allowed[input.action].includes(row.status)) throw new CampaignValidationError(`Cannot ${input.action} a ${row.status} translation.`);
      if (input.action !== 'request_changes') {
        assertTranslationShape(source.content, row.content);
        const missing = missingTranslationFields(source.content, row.content);
        if (missing.length) throw new CampaignValidationError(`Complete these translations before proceeding: ${missing.join(', ')}.`);
      }
      if (['approve', 'request_changes'].includes(input.action) && input.note.trim().length < 3) throw new CampaignValidationError('An approval reference or change-request explanation is required.');
      const now = new Date();
      if (input.action === 'publish') await tx.update(revisions).set({ status: 'superseded', updatedAt: now }).where(and(eq(revisions.campaignVersionId, source.id), eq(revisions.locale, 'es-US'), eq(revisions.status, 'published')));
      const status = { submit: 'submitted', approve: 'approved', request_changes: 'changes_requested', publish: 'published' } as const;
      await tx.update(revisions).set({ status: status[input.action], editVersion: row.editVersion + 1, updatedAt: now, updatedBy: actor,
        ...(input.action === 'approve' ? { reviewedBy: actor, reviewedAt: now, reviewReference: input.note.trim() } : {}),
        ...(input.action === 'publish' ? { publishedBy: actor, publishedAt: now } : {}),
        history: [...row.history, { action: input.action, actor, at: now.toISOString(), ...(input.note ? { note: input.note } : {}) }] }).where(eq(revisions.id, row.id));
      await new DrizzleAuditService(tx).record({ actorUserId: actor, actorRole, action: `campaign.translation.${input.action}`, resourceType: 'campaign_translation', resourceId: row.id, outcome: 'success' });
    });
    if (input.action === 'publish') await this.invalidator.invalidateCampaign(slug).catch(() => ({ invalidated: false }));
    return this.workspace(slug);
  }
}
