import { createRoute, z } from '@hono/zod-openapi';

import {
  campaignPathSchema,
  commonProblemResponses,
  localeQuerySchema,
  problemDetailsSchema,
  uuid,
} from './common.js';
import { campaignResponseSchema } from './campaigns.js';
import { productCheckRequestSchema, productCheckResponseSchema } from './product-checks.js';
import {
  claimDraftResponseSchema,
  draftTokenHeaderSchema,
  uploadTokenRequestSchema,
  uploadTokenResponseSchema,
} from './documents.js';
import {
  claimSubmissionRequestSchema,
  claimSubmissionResponseSchema,
  idempotencyHeaderSchema,
} from './claims.js';

export const getCampaignRoute = createRoute({
  method: 'get',
  path: '/v1/recall-campaigns/{slug}',
  tags: ['Campaigns'],
  summary: 'Get the currently published public campaign configuration',
  request: { params: campaignPathSchema, query: localeQuerySchema },
  responses: {
    200: {
      description: 'Published campaign content.',
      headers: {
        ETag: { schema: { type: 'string' }, description: 'Published version entity tag.' },
        'Content-Language': { schema: { type: 'string' } },
      },
      content: { 'application/json': { schema: campaignResponseSchema } },
    },
    ...commonProblemResponses,
  },
});

export const productCheckRoute = createRoute({
  method: 'post',
  path: '/v1/recall-campaigns/{slug}/product-checks',
  tags: ['Product checks'],
  summary: 'Run a preliminary affected-product check',
  request: {
    params: campaignPathSchema,
    body: {
      required: true,
      content: { 'application/json': { schema: productCheckRequestSchema } },
    },
  },
  responses: {
    200: {
      description: 'Preliminary result.',
      content: { 'application/json': { schema: productCheckResponseSchema } },
    },
    ...commonProblemResponses,
  },
});

export const createClaimDraftRoute = createRoute({
  method: 'post',
  path: '/v1/recall-campaigns/{slug}/claim-drafts',
  tags: ['Claim drafts'],
  summary: 'Create an expiring anonymous upload draft',
  request: { params: campaignPathSchema },
  responses: {
    201: {
      description: 'Draft created.',
      content: { 'application/json': { schema: claimDraftResponseSchema } },
    },
    ...commonProblemResponses,
  },
});

export const createUploadTokenRoute = createRoute({
  method: 'post',
  path: '/v1/claim-drafts/{draftId}/upload-tokens',
  tags: ['Documents'],
  summary: 'Authorize a direct upload to Vercel Private Blob',
  request: {
    params: z.object({ draftId: uuid }),
    headers: draftTokenHeaderSchema,
    body: { required: true, content: { 'application/json': { schema: uploadTokenRequestSchema } } },
  },
  responses: {
    201: {
      description: 'Upload authorization.',
      content: { 'application/json': { schema: uploadTokenResponseSchema } },
    },
    410: {
      description: 'Draft expired.',
      content: { 'application/problem+json': { schema: problemDetailsSchema } },
    },
    413: {
      description: 'File is too large.',
      content: { 'application/problem+json': { schema: problemDetailsSchema } },
    },
    415: {
      description: 'File media type is not allowed.',
      content: { 'application/problem+json': { schema: problemDetailsSchema } },
    },
    422: {
      description: 'Evidence rules are not satisfied.',
      content: { 'application/problem+json': { schema: problemDetailsSchema } },
    },
    ...commonProblemResponses,
  },
});

export const deleteDraftDocumentRoute = createRoute({
  method: 'delete',
  path: '/v1/claim-drafts/{draftId}/documents/{documentId}',
  tags: ['Documents'],
  summary: 'Remove an unsubmitted draft document',
  request: {
    params: z.object({ draftId: uuid, documentId: uuid }),
    headers: draftTokenHeaderSchema,
  },
  responses: {
    204: { description: 'Document scheduled for deletion.' },
    410: {
      description: 'Draft expired.',
      content: { 'application/problem+json': { schema: problemDetailsSchema } },
    },
    ...commonProblemResponses,
  },
});

export const submitClaimRoute = createRoute({
  method: 'post',
  path: '/v1/recall-campaigns/{slug}/claims',
  tags: ['Claims'],
  summary: 'Submit a consumer recall claim',
  request: {
    params: campaignPathSchema,
    headers: idempotencyHeaderSchema,
    body: {
      required: true,
      content: { 'application/json': { schema: claimSubmissionRequestSchema } },
    },
  },
  responses: {
    201: {
      description: 'Claim submitted.',
      content: { 'application/json': { schema: claimSubmissionResponseSchema } },
    },
    409: {
      description: 'Idempotency conflict or draft already used.',
      content: { 'application/problem+json': { schema: problemDetailsSchema } },
    },
    410: {
      description: 'Draft expired.',
      content: { 'application/problem+json': { schema: problemDetailsSchema } },
    },
    422: {
      description: 'Campaign, product, evidence, or conditional fields are invalid.',
      content: { 'application/problem+json': { schema: problemDetailsSchema } },
    },
    ...commonProblemResponses,
  },
});

/**
 * Builds the OpenAPI document config. The production server URL is
 * config-controlled (T6.5/O6) so the published contract advertises the stable
 * deployment domain instead of the placeholder.
 */
export function buildOpenApiConfig(problemBaseUrl: string) {
  return {
    openapi: '3.1.0' as const,
    info: {
      title: 'KOI Recall Consumer API',
      version: '1.0.0',
      description:
        'Phase 1 contract for public campaign content, product checks, evidence uploads, and recall claim submission.',
    },
    servers: [
      { url: 'http://localhost:3000', description: 'Local development' },
      { url: problemBaseUrl, description: 'Production API domain' },
    ],
  };
}

export const openApiConfig = buildOpenApiConfig('https://api.example.invalid');
