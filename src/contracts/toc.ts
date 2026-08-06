import { createRoute, z } from '@hono/zod-openapi';

const uuid = z.string().uuid();
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD.');
const isoDateTime = z.string().datetime({ offset: true });

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

const notImplementedResponse = {
  description: 'The contract exists, but the Phase 1 skeleton has no provider implementation.',
  content: { 'application/problem+json': { schema: problemDetailsSchema } },
} as const;

const commonProblemResponses = {
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

const evidenceRequirementSchema = z
  .object({
    category: z.enum(['product_photo', 'proof_of_purchase', 'incident_evidence']),
    required: z.boolean(),
    minimumFiles: z.number().int().min(0),
    maximumFiles: z.number().int().min(1),
    allowedMimeTypes: z.array(z.string()),
    maximumFileSizeBytes: z.number().int().positive(),
    instructions: z.string(),
  })
  .openapi('EvidenceRequirement');

const publicProductSchema = z
  .object({
    productId: uuid,
    sku: z.string(),
    brand: z.string(),
    name: z.string(),
    flavors: z.array(z.string()),
    shapes: z.array(z.string()),
    affectedLots: z.array(
      z.object({
        lotCode: z.string(),
        dateCode: z.string(),
        attributes: z.record(z.string(), z.unknown()),
      }),
    ),
  })
  .openapi('PublicCampaignProduct');

export const campaignResponseSchema = z
  .object({
    campaign: z.object({
      slug: z.string(),
      code: z.string(),
      version: z.number().int().positive(),
      locale: z.string(),
      defaultLocale: z.string(),
      title: z.string(),
      summary: z.string(),
      hazard: z.string(),
      immediateAction: z.string(),
      remedySummary: z.string(),
      support: z.object({ email: z.string().email(), phone: z.string(), hours: z.string() }),
      products: z.array(publicProductSchema),
      remedies: z.array(z.object({ code: z.string(), displayName: z.string() })),
      evidenceRequirements: z.array(evidenceRequirementSchema),
    }),
  })
  .openapi('CampaignResponse');

/**
 * The public campaign object carried by CampaignResponse. Derived from the Zod
 * contract so the service, mapper, and route handler all share one shape.
 */
export type CampaignView = z.infer<typeof campaignResponseSchema>['campaign'];

export const productCheckRequestSchema = z
  .object({
    shape: z.string().min(1).max(80),
    flavor: z.string().min(1).max(80),
    lotCode: z.string().min(1).max(80),
    dateCode: z.string().min(1).max(40),
  })
  .openapi('ProductCheckRequest');

export const productCheckResponseSchema = z
  .object({
    result: z.enum(['potential_match', 'not_matched', 'manual_review']),
    message: z.string(),
    checkedCampaignVersion: z.number().int().positive(),
    disclaimer: z.literal('This check is preliminary and is not a final eligibility decision.'),
  })
  .openapi('ProductCheckResponse');

/**
 * The preliminary product-check result returned to consumers. Derived from the
 * Zod contract so the service and route handler share one shape.
 */
export type ProductCheckResponse = z.infer<typeof productCheckResponseSchema>;

export const claimDraftResponseSchema = z
  .object({
    draftId: uuid,
    draftToken: z.string().min(32),
    expiresAt: isoDateTime,
  })
  .openapi('ClaimDraftResponse');

/**
 * The created draft returned to consumers. Derived from the Zod contract so the
 * service and route handler share one shape.
 */
export type ClaimDraftResponse = z.infer<typeof claimDraftResponseSchema>;

const draftTokenHeaderSchema = z.object({
  'X-Draft-Token': z
    .string()
    .min(32)
    .openapi({
      param: { name: 'X-Draft-Token', in: 'header' },
    }),
});

export const uploadTokenRequestSchema = z
  .object({
    category: z.enum(['product_photo', 'proof_of_purchase', 'incident_evidence']),
    fileName: z.string().min(1).max(255),
    mimeType: z.string().min(3).max(120),
    sizeBytes: z.number().int().positive(),
  })
  .openapi('UploadTokenRequest');

export const uploadTokenResponseSchema = z
  .object({
    documentId: uuid,
    pathname: z
      .string()
      .min(1)
      .max(1024)
      .regex(/^drafts\/[^/]+\/[^/]+\//),
    clientToken: z.string(),
    expiresAt: isoDateTime,
  })
  .openapi('UploadTokenResponse');

const addressSchema = z
  .object({
    line1: z.string().min(1).max(160),
    line2: z.string().max(160).optional(),
    city: z.string().min(1).max(100),
    state: z.string().min(2).max(80),
    postalCode: z.string().min(3).max(20),
    countryCode: z.string().length(2).default('US'),
  })
  .openapi('ConsumerAddress');

const claimedProductSchema = z
  .object({
    campaignProductId: uuid,
    quantity: z.number().int().min(1).max(100),
    shape: z.string().min(1).max(80),
    flavor: z.string().min(1).max(80),
    lotCode: z.string().min(1).max(80),
    dateCode: z.string().min(1).max(40),
    purchaseChannel: z.enum(['amazon', 'tiktok', 'koi', 'retailer', 'gift', 'other']),
    purchaseDate: isoDate.optional(),
    orderNumber: z.string().max(120).optional(),
  })
  .openapi('ClaimedProductInput');

const incidentEventTypeSchema = z.enum([
  'injury',
  'illness',
  'choking',
  'ingestion',
  'fire',
  'overheating',
  'property_damage',
  'near_miss',
  'other',
  'unknown',
]);

const incidentDetailsSchema = z
  .object({
    eventTypes: z.array(incidentEventTypeSchema).min(1).optional(),
    narrative: z.string().trim().min(10).max(4000),
    occurredDate: isoDate.optional(),
    occurredDateUnknown: z.boolean().default(false),
    injurySeverity: z
      .enum(['none', 'minor', 'medical_attention', 'hospitalized', 'death', 'unknown'])
      .optional(),
    medicalTreatment: z
      .enum(['none', 'first_aid', 'outpatient', 'emergency', 'hospitalized', 'unknown'])
      .optional(),
    usedAsIntended: z.enum(['yes', 'no', 'unknown']).optional(),
  })
  .openapi('IncidentDetailsInput');

export const claimSubmissionRequestSchema = z
  .object({
    draftId: uuid,
    draftToken: z.string().min(32),
    locale: z.literal('en-US'),
    consumer: z.object({
      firstName: z.string().trim().min(1).max(100),
      lastName: z.string().trim().min(1).max(100),
      email: z.string().email().max(254),
      phone: z.string().max(40).optional(),
      mailingAddress: addressSchema,
    }),
    products: z.array(claimedProductSchema).min(1).max(20),
    remedyCode: z.string().min(1).max(60),
    documentIds: z.array(uuid).min(2).max(20),
    consents: z
      .array(
        z.object({
          type: z.enum(['privacy_notice', 'information_accuracy']),
          textVersion: z.string().min(1).max(80),
          accepted: z.literal(true),
        }),
      )
      .min(2),
    incidentAnswer: z.enum(['no', 'yes', 'unsure']),
    incidentDetails: incidentDetailsSchema.optional(),
  })
  .superRefine((value, context) => {
    if (value.incidentAnswer === 'no' && value.incidentDetails) {
      context.addIssue({
        code: 'custom',
        path: ['incidentDetails'],
        message: 'incidentDetails must be omitted when incidentAnswer is no.',
      });
    }

    if (value.incidentAnswer !== 'no' && !value.incidentDetails) {
      context.addIssue({
        code: 'custom',
        path: ['incidentDetails'],
        message: 'incidentDetails is required when incidentAnswer is yes or unsure.',
      });
      return;
    }

    const details = value.incidentDetails;
    if (!details) return;

    if (value.incidentAnswer === 'yes' && !details.eventTypes?.length) {
      context.addIssue({
        code: 'custom',
        path: ['incidentDetails', 'eventTypes'],
        message: 'eventTypes is required when incidentAnswer is yes.',
      });
    }

    if (value.incidentAnswer === 'yes' && !details.occurredDate && !details.occurredDateUnknown) {
      context.addIssue({
        code: 'custom',
        path: ['incidentDetails', 'occurredDate'],
        message: 'Provide occurredDate or set occurredDateUnknown to true.',
      });
    }

    const hasInjury =
      details.eventTypes?.some((type) => type === 'injury' || type === 'illness') ?? false;
    if (hasInjury && !details.injurySeverity) {
      context.addIssue({
        code: 'custom',
        path: ['incidentDetails', 'injurySeverity'],
        message: 'injurySeverity is required for injury or illness events.',
      });
    }
    if (hasInjury && !details.medicalTreatment) {
      context.addIssue({
        code: 'custom',
        path: ['incidentDetails', 'medicalTreatment'],
        message: 'medicalTreatment is required for injury or illness events.',
      });
    }
  })
  .openapi('ClaimSubmissionRequest');

export const claimSubmissionResponseSchema = z
  .object({
    caseReference: z.string().regex(/^KOI-[A-Z0-9]{4}-[A-Z0-9]{8}$/),
    submittedAt: isoDateTime,
    emailStatus: z.literal('queued'),
    nextStep: z.string(),
  })
  .openapi('ClaimSubmissionResponse');

const idempotencyHeaderSchema = z.object({
  'Idempotency-Key': z
    .string()
    .min(16)
    .max(128)
    .openapi({
      param: { name: 'Idempotency-Key', in: 'header' },
    }),
});

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

export const openApiConfig = {
  openapi: '3.1.0' as const,
  info: {
    title: 'KOI Recall Consumer API',
    version: '1.0.0',
    description:
      'Phase 1 contract for public campaign content, product checks, evidence uploads, and recall claim submission.',
  },
  servers: [
    { url: 'http://localhost:3000', description: 'Local development' },
    { url: 'https://api.example.invalid', description: 'Placeholder production API domain' },
  ],
};
