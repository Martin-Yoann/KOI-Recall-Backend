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
  caseStatusLookupRequestSchema,
  caseStatusLookupResponseSchema,
} from './case-status-lookups.js';
import { legacyConsumerClaimLookupResponseSchema } from './consumer-auth.js';
import { draftDocumentListResponseSchema } from './documents.js';
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
        'Cache-Control': {
          schema: { type: 'string' },
          description:
            'Public, immutable-per-version content: short browser max-age, longer edge s-maxage, stale-while-revalidate.',
        },
      },
      content: { 'application/json': { schema: campaignResponseSchema } },
    },
    304: {
      description:
        'Not Modified — the request If-None-Match matched the current published-version ETag. ' +
        'No body; validators and cache directives are repeated so caches can keep serving.',
      headers: {
        ETag: { schema: { type: 'string' }, description: 'Published version entity tag.' },
        'Cache-Control': { schema: { type: 'string' } },
      },
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

export const listDraftDocumentsRoute = createRoute({
  method: 'get',
  path: '/v1/claim-drafts/{draftId}/documents',
  tags: ['Documents'],
  summary: 'List draft documents with their upload lifecycle status',
  description:
    'Powers the six-state upload UI: uploading, verifying, verified, scan_pending, rejected, expired. ' +
    'Deleted documents no longer appear; the same X-Draft-Token authentication as every other Draft sub-resource applies.',
  request: {
    params: z.object({ draftId: uuid }),
    headers: draftTokenHeaderSchema,
  },
  responses: {
    200: {
      description: 'Current draft documents in stable order.',
      content: { 'application/json': { schema: draftDocumentListResponseSchema } },
    },
    410: {
      description: 'Draft expired or already submitted.',
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

export const createCaseStatusLookupRoute = createRoute({
  method: 'post',
  path: '/v1/case-status-lookups',
  tags: ['Case status'],
  summary: 'Look up the public status of a case by case reference and email',
  description:
    'Public, PII-free status lookup for the consumer-front `/lookup` page. The (caseReference, email) ' +
    'pair is verified with a peppered HMAC; unknown references and mismatched emails return an identical ' +
    '404 ProblemDetails so references cannot be enumerated. Rate limited per client IP at 10 requests/minute; ' +
    'exceeding it returns 429 ProblemDetails with a Request ID.',
  request: {
    body: {
      required: true,
      content: { 'application/json': { schema: caseStatusLookupRequestSchema } },
    },
  },
  responses: {
    200: {
      description:
        'Whitelisted public view. No PII, internal statuses, or refund data may appear — the schema is exhaustive.',
      content: { 'application/json': { schema: caseStatusLookupResponseSchema } },
    },
    ...commonProblemResponses,
  },
});

/** Superseded legacy endpoint — kept for one transition window, formally deprecated. */
export const legacyConsumerAuthLookupRoute = createRoute({
  method: 'get',
  path: '/v1/consumer-auth/lookup/{claimNumber}',
  deprecated: true,
  tags: ['Case status'],
  summary: '[Deprecated] Legacy claim lookup returning the whitelisted public status view',
  description:
    'The response carries the §9.9 whitelist only — identical in shape to POST /v1/case-status-lookups. ' +
    'The phone query factor is a transition-period compatibility match and is never echoed back; ' +
    'the endpoint is scheduled for removal once Consumer Front migrates. ' +
    'New integrations must use POST /v1/case-status-lookups instead.',
  request: {
    params: z.object({ claimNumber: z.string().min(3).max(32) }),
    query: z.object({ phone: z.string().min(1).openapi({ example: '+15551234567' }) }),
  },
  responses: {
    200: {
      description: 'Whitelisted public view, same schema as POST /v1/case-status-lookups. No PII.',
      content: { 'application/json': { schema: legacyConsumerClaimLookupResponseSchema } },
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
