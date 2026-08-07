import { z } from '@hono/zod-openapi';

export const uuid = z.string().uuid();
export const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD.');
export const isoDateTime = z.string().datetime({ offset: true });

export const problemDetailsSchema = z
  .object({
    type: z.string().url(),
    title: z.string(),
    status: z.number().int(),
    detail: z.string(),
    instance: z.string().optional(),
    requestId: z.string().optional(),
    errors: z.array(z.object({ path: z.string(), message: z.string() })).optional(),
  })
  .openapi('ProblemDetails');

export const notImplementedResponse = {
  description: 'The contract exists, but the Phase 1 skeleton has no provider implementation.',
  content: { 'application/problem+json': { schema: problemDetailsSchema } },
} as const;

export const commonProblemResponses = {
  400: {
    description: 'Invalid request.',
    content: { 'application/problem+json': { schema: problemDetailsSchema } },
  },
  404: {
    description: 'Campaign or resource not found.',
    content: { 'application/problem+json': { schema: problemDetailsSchema } },
  },
  429: {
    description: 'Rate limit exceeded.',
    content: { 'application/problem+json': { schema: problemDetailsSchema } },
  },
  500: {
    description: 'Unexpected server error.',
    content: { 'application/problem+json': { schema: problemDetailsSchema } },
  },
  501: notImplementedResponse,
  503: {
    description: 'A required dependency is unavailable.',
    content: { 'application/problem+json': { schema: problemDetailsSchema } },
  },
} as const;

export const localeQuerySchema = z.object({
  locale: z.enum(['en-US']).default('en-US').openapi({ example: 'en-US' }),
});

export const campaignPathSchema = z.object({
  slug: z
    .string()
    .min(3)
    .max(100)
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
});

export const addressSchema = z
  .object({
    line1: z.string().min(1).max(160),
    line2: z.string().max(160).optional(),
    city: z.string().min(1).max(100),
    state: z.string().min(2).max(80),
    postalCode: z.string().min(3).max(20),
    countryCode: z.string().length(2).default('US'),
  })
  .openapi('ConsumerAddress');
