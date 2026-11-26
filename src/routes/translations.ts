import type { OpenAPIHono } from '@hono/zod-openapi';
import { z } from '@hono/zod-openapi';
import type { ApplicationRegistry } from '../composition.js';
import type { AppEnv } from '../middleware/request-context.js';
import { translationContentSchema } from '../modules/campaigns/translation-content.js';
import { CampaignValidationError, NotImplementedServiceError } from '../shared/errors.js';
import { requireAuditService, requirePermission } from './admin-guard.js';

const saveSchema = z.object({ sourceVersionId: z.string().uuid(), sourceHash: z.string().regex(/^[a-f0-9]{64}$/), revisionId: z.string().uuid().nullable(), editVersion: z.number().int().min(0), content: translationContentSchema }).strict();
const transitionSchema = z.object({ revisionId: z.string().uuid(), editVersion: z.number().int().positive(), action: z.enum(['submit', 'approve', 'request_changes', 'publish']), note: z.string().max(2000).default('') }).strict();

export function registerTranslationRoutes(app: OpenAPIHono<AppEnv>, registry: ApplicationRegistry) {
  app.get('/admin/campaigns/:slug/translations/es-US', async (context) => {
    const principal = await requirePermission(context, registry, 'case.queue.read');
    if (principal instanceof Response) return principal;
    if (!registry.services.translations) throw new NotImplementedServiceError('Translation management');
    return context.json(await registry.services.translations.workspace(context.req.param('slug')));
  });
  app.put('/admin/campaigns/:slug/translations/es-US', async (context) => {
    const principal = await requirePermission(context, registry, 'campaign.publish');
    if (principal instanceof Response) return principal;
    if (!registry.services.translations) throw new NotImplementedServiceError('Translation management');
    const body = saveSchema.safeParse(await context.req.json().catch(() => null));
    if (!body.success) throw new CampaignValidationError('A valid source version, draft edit version and translation content are required.');
    const result = await registry.services.translations.save(context.req.param('slug'), body.data, principal.userId);
    await requireAuditService(registry).record({ actorUserId: principal.userId, actorRole: principal.role, action: 'campaign.translation.save', resourceType: 'campaign_translation', resourceId: result.latest?.id, outcome: 'success' });
    return context.json(result);
  });
  app.post('/admin/campaigns/:slug/translations/es-US/actions', async (context) => {
    const principal = await requirePermission(context, registry, 'campaign.publish');
    if (principal instanceof Response) return principal;
    if (!registry.services.translations) throw new NotImplementedServiceError('Translation management');
    const body = transitionSchema.safeParse(await context.req.json().catch(() => null));
    if (!body.success) throw new CampaignValidationError('A valid translation action and edit version are required.');
    const result = await registry.services.translations.transition(context.req.param('slug'), body.data, principal.userId);
    await requireAuditService(registry).record({ actorUserId: principal.userId, actorRole: principal.role, action: `campaign.translation.${body.data.action}`, resourceType: 'campaign_translation', resourceId: body.data.revisionId, outcome: 'success' });
    return context.json(result);
  });
}
