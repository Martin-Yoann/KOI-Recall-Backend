import type { OpenAPIHono } from '@hono/zod-openapi';

import type { ApplicationRegistry } from '../composition.js';
import {
  claimDraftResponseSchema,
  createClaimDraftRoute,
  createDisposalUploadTokenRoute,
  createUploadTokenRoute,
  deleteDraftDocumentRoute,
  draftDocumentListResponseSchema,
  listDraftDocumentsRoute,
  uploadTokenResponseSchema,
} from '../contracts/toc.js';
import type { AppEnv } from '../middleware/request-context.js';
import { isConnectionError, NotImplementedServiceError } from '../shared/errors.js';
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

  /**
   * Task-scoped evidence upload. The disposal token authorises it, and the
   * document is owned by the task's draft — the same consumer, the same claim.
   * The draft-scoped route below cannot serve this case because it requires an
   * active draft, and submitting the claim is what made this one inactive.
   */
  app.openapi(createDisposalUploadTokenRoute, async (context) => {
    const { taskId } = context.req.valid('param');
    const taskToken = context.req.header('X-Disposal-Token');
    if (!taskToken) return notFound(context, 'Disposal task');

    const disposal = registry.services.disposal;
    if (!disposal) throw new NotImplementedServiceError('Disposal');
    // Throws when the task is unknown, the credential is wrong, or the policy
    // does not currently allow evidence.
    const { draftId } = await disposal.assertCanUploadEvidence(taskId, taskToken);

    const body = context.req.valid('json');
    const authorization = await registry.services.documents.authorizeUpload({
      draftId,
      category: 'disposal_evidence',
      fileName: body.fileName,
      mimeType: body.mimeType,
      sizeBytes: body.sizeBytes,
    });
    const response = uploadTokenResponseSchema.parse(authorization);
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

  app.openapi(listDraftDocumentsRoute, async (context) => {
    const { draftId } = context.req.valid('param');
    let documents;
    try {
      documents = await registry.services.documents.listDraftDocuments(
        draftId,
        context.req.valid('header')['X-Draft-Token'],
      );
    } catch (error) {
      if (isConnectionError(error)) return dependencyUnavailable(context, 'Draft document listing');
      throw error;
    }

    return context.json(draftDocumentListResponseSchema.parse({ documents }), 200);
  });
}
