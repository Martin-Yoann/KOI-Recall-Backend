import { z } from '@hono/zod-openapi';

import { isoDateTime } from './common.js';

/**
 * Public case status lookup (consumer-front contract §5.4). The response is a
 * strict whitelist: no PII, no internal status values, no refund amounts —
 * only the fields declared here may appear, so `grep`-level conformance is
 * enforced by the schema itself.
 */

/** The closed set of public statuses the API derives for consumers. */
export const PUBLIC_CASE_STATUSES = [
  'received',
  'in_review',
  'action_required',
  'resolution_approved',
  'resolution_in_progress',
  'completed',
  'not_approved',
  'closed',
] as const;

export type PublicCaseStatus = (typeof PUBLIC_CASE_STATUSES)[number];

/** API-produced English copy; the frontend renders these verbatim. */
export const PUBLIC_CASE_STATUS_LABELS: Record<PublicCaseStatus, string> = {
  received: 'Claim received',
  in_review: 'Under review',
  action_required: 'Additional information required',
  resolution_approved: 'Resolution approved',
  resolution_in_progress: 'Resolution in progress',
  completed: 'Completed',
  not_approved: 'Not approved',
  closed: 'Case closed',
};

/** Neutral, never-empty next-action copy per public status. */
export const CONSUMER_NEXT_ACTIONS: Record<PublicCaseStatus, string> = {
  received:
    'We have received your claim and will notify you by email once the initial review begins.',
  in_review: 'Your claim is under review. No action is needed right now.',
  action_required:
    'Additional information is required. Please follow the instructions in the email we sent you.',
  resolution_approved:
    'Your resolution has been approved. We will contact you about the next steps.',
  resolution_in_progress: 'Your resolution is being processed. No action is needed right now.',
  completed: 'This case is complete. Thank you for your patience.',
  not_approved: 'Your claim was not approved. Please check your email for the details.',
  closed: 'This case is closed. Contact support if you need further assistance.',
};

const caseReferenceSchema = z
  .string()
  .regex(/^KOI-[A-Z0-9]{4}-[A-Z0-9]{8}$/)
  .openapi({
    description: 'The public case reference shown to the consumer.',
    example: 'KOI-1234-5678',
  });

export const caseStatusLookupRequestSchema = z
  .object({
    caseReference: caseReferenceSchema,
    email: z.string().email().max(254),
  })
  .openapi('CaseStatusLookupRequest');

export const caseStatusLookupResponseSchema = z
  .object({
    caseReference: caseReferenceSchema,
    campaignTitle: z.string().min(1).openapi({
      description: 'Title of the campaign the case belongs to.',
      example: 'Music Lollipop Recall',
    }),
    publicStatus: z.enum(PUBLIC_CASE_STATUSES).openapi({
      description: 'Coarse public status derived server-side from the internal lifecycle.',
    }),
    publicStatusLabel: z.string().min(1).openapi({
      description: 'English display copy produced by the API; render verbatim.',
      example: 'Under review',
    }),
    consumerNextAction: z.string().min(1).openapi({
      description: 'Neutral next-action copy for the consumer; never empty.',
    }),
    requestedResolution: z.string().min(1).nullable().openapi({
      description: 'Display name of the resolution the consumer requested; null when unavailable.',
      example: 'Replacement',
    }),
    approvedResolution: z.string().min(1).nullable().openapi({
      description:
        'Display name of the operationally approved resolution; populated only once that fact is consumer-visible.',
      example: 'Refund',
    }),
    lastUpdatedAt: isoDateTime.openapi({
      description: 'When the case was last updated (ISO 8601 UTC).',
    }),
  })
  .openapi('CaseStatusLookupResponse');

export type CaseStatusLookupResponse = z.infer<typeof caseStatusLookupResponseSchema>;
