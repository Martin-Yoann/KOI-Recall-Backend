import { createRoute, z } from '@hono/zod-openapi';

import { commonProblemResponses, problemDetailsSchema, uuid } from './common.js';
import {
  disposalEvidenceBatchResponseSchema,
  disposalTaskViewSchema,
  recordDisposalDeclarationRequestSchema,
  submitDisposalEvidenceRequestSchema,
} from './disposal.js';

/**
 * Consumer-disposal routes.
 *
 * Only the consumer-facing endpoints live here. The admin surface deliberately
 * stays out of the published document, matching every other `/admin/*` route in
 * this service — those handlers are registered directly and enforce permissions
 * through the shared guard.
 *
 * The visitor credential travels in a header rather than a query string: a query
 * string is written to access logs and referrers, and this token is all that
 * stands between a stranger and another person's private evidence photos.
 */
export const disposalTokenHeaderSchema = z.object({
  'X-Disposal-Token': z
    .string()
    .min(32)
    .openapi({
      param: { name: 'X-Disposal-Token', in: 'header' },
    }),
});

const taskPathSchema = z.object({ taskId: uuid });

const unauthorizedResponse = {
  description: 'The disposal token is missing, wrong, or expired.',
  content: { 'application/problem+json': { schema: problemDetailsSchema } },
} as const;

const unprocessableResponse = {
  description: 'The request is refused by the disposal gates.',
  content: { 'application/problem+json': { schema: problemDetailsSchema } },
} as const;

export const getDisposalTaskRoute = createRoute({
  method: 'get',
  path: '/v1/disposal-tasks/{taskId}',
  tags: ['Disposal'],
  summary: 'Read a disposal task as its visitor',
  description:
    'Returns the task with the server-computed allowed actions and blocking reasons. Instruction content is withheld while it is unapproved, withdrawn, or not backed by an authorizing approval, so no improvised destruction method can be shown in its place.',
  request: { params: taskPathSchema, headers: disposalTokenHeaderSchema },
  responses: {
    200: {
      description: 'The disposal task as this visitor may see it.',
      content: { 'application/json': { schema: disposalTaskViewSchema } },
    },
    401: unauthorizedResponse,
    ...commonProblemResponses,
  },
});

export const submitDisposalEvidenceRoute = createRoute({
  method: 'post',
  path: '/v1/disposal-tasks/{taskId}/evidence',
  tags: ['Disposal'],
  summary: 'Submit a batch of disposal evidence photos for review',
  description:
    'Only technically verified documents of the disposal-evidence category, owned by this task, are accepted. Submitting evidence is not permission to dispose: a person still has to review it.',
  request: {
    params: taskPathSchema,
    headers: disposalTokenHeaderSchema.merge(
      z.object({ 'Idempotency-Key': z.string().min(16).max(128) }),
    ),
    body: {
      required: true,
      content: { 'application/json': { schema: submitDisposalEvidenceRequestSchema } },
    },
  },
  responses: {
    201: {
      description: 'The evidence batch was recorded and is awaiting review.',
      content: { 'application/json': { schema: disposalEvidenceBatchResponseSchema } },
    },
    401: unauthorizedResponse,
    422: unprocessableResponse,
    ...commonProblemResponses,
  },
});

export const recordDisposalDeclarationRoute = createRoute({
  method: 'post',
  path: '/v1/disposal-tasks/{taskId}/declaration',
  tags: ['Disposal'],
  summary: 'Record the consumer declaration for a disposal task',
  description:
    'A declaration cites either an active authorization or an exception. The exception path exists so a consumer who already disposed of the unit can report the truth rather than have a permission back-dated for them.',
  request: {
    params: taskPathSchema,
    headers: disposalTokenHeaderSchema,
    body: {
      required: true,
      content: { 'application/json': { schema: recordDisposalDeclarationRequestSchema } },
    },
  },
  responses: {
    204: { description: 'The declaration was recorded.' },
    401: unauthorizedResponse,
    422: unprocessableResponse,
    ...commonProblemResponses,
  },
});
