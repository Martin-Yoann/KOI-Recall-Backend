import type { OpenAPIHono } from '@hono/zod-openapi';

import type { ApplicationRegistry } from '../composition.js';
import {
  claimDraftResponseSchema,
  createClaimDraftRoute,
  createUploadTokenRoute,
  deleteDraftDocumentRoute,
  uploadTokenResponseSchema,
} from '../contracts/toc.js';
import type { AppEnv } from '../middleware/request-context.js';
import { isConnectionError } from '../shared/errors.js';
import { dependencyUnavailable, notFound } from './shared.js';

/**
 * Registers the claim-draft creation and direct-upload document routes
 * (draft creation, upload-token minting, and draft document deletion).
 */
export function registerDocumentRoutes(app: OpenAPIHono<AppEnv>, registry: ApplicationRegistry) {
  app.openapi(createClaimDraftRoute, async (context) => {
    let draft;
    try {
      draft = await registry.services.claimDrafts.create(context.req.valid('param').slug);
    } catch (error) {
      if (isConnectionError(error)) return dependencyUnavailable(context, 'Claim draft creation');
      throw error;
    }

    if (!draft) return notFound(context, 'Campaign');

    const response = claimDraftResponseSchema.parse(draft);
    return context.json(response, 201);
  });

  app.openapi(createUploadTokenRoute, async (context) => {
    const { draftId } = context.req.valid('param');
    await registry.services.claimDrafts.assertActive(
      draftId,
      context.req.valid('header')['X-Draft-Token'],
    );
    let authorization;
    try {
      authorization = await registry.services.documents.authorizeUpload({
        draftId,
        ...context.req.valid('json'),
      });
    } catch (error) {
      if (isConnectionError(error))
        return dependencyUnavailable(context, 'Private Blob upload authorization');
      throw error;
    }

    const response = uploadTokenResponseSchema.parse(authorization);
    return context.json(response, 201);
  });

  app.openapi(deleteDraftDocumentRoute, async (context) => {
    const { draftId, documentId } = context.req.valid('param');
    try {
      await registry.services.documents.scheduleDraftDocumentDeletion(
        draftId,
        documentId,
        context.req.valid('header')['X-Draft-Token'],
      );
    } catch (error) {
      if (isConnectionError(error))
        return dependencyUnavailable(context, 'Draft document deletion');
      throw error;
    }

    return context.body(null, 204);
  });
}
