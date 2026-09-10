import 'dotenv/config';

import { sql } from 'drizzle-orm';

import { createDatabase } from '../db/client.js';
import { templateVersions } from '../db/schema/index.js';
import { loadConfig } from '../config/env.js';

/**
 * Seeds the template version library with the known trigger-point templates.
 * Idempotent: re-running upserts each version row instead of wiping the
 * table, so existing rows (and communications pinned to them) survive.
 */
async function setupTemplates() {
  console.log('--- Start: initialize template version library ---');
  const config = loadConfig();
  const { db } = createDatabase(config.DATABASE_URL!);

  const templates = [
    {
      templateKey: 'claim_confirmation',
      locale: 'en-US',
      version: 1,
      subject: 'Your Claim {{caseReference}} Submission',
      htmlBody:
        '<h1>Submission Received</h1><p>Your claim {{caseReference}} has been submitted.</p>',
      textBody: 'Your claim {{caseReference}} has been submitted.',
    },
    {
      templateKey: 'need_info',
      locale: 'en-US',
      version: 2,
      subject: 'Action needed for recall claim {{caseReference}}',
      htmlBody:
        '<p>We need additional information to continue reviewing your recall claim {{caseReference}}.</p>' +
        '<p>Requested information: {{requestedInformation}}</p>' +
        '<p>Please respond using the secure claim link: <a href="{{actionUrl}}">{{actionUrl}}</a></p>',
      textBody:
        'We need additional information to continue reviewing your recall claim {{caseReference}}.\n' +
        'Requested information: {{requestedInformation}}\n' +
        'Please respond using the secure claim link: {{actionUrl}}',
    },
    {
      templateKey: 'refund_approved',
      locale: 'en-US',
      version: 1,
      subject: 'Refund approved for {{caseReference}}',
      htmlBody: '<p>Refund of {{refundAmount}} {{refundCurrency}} approved.</p>',
      textBody: 'Refund of {{refundAmount}} {{refundCurrency}} approved.',
    },
    {
      templateKey: 'replacement_approved',
      locale: 'en-US',
      version: 1,
      subject: 'Replacement approved for {{caseReference}}',
      htmlBody: '<p>Replacement {{replacementItem}} approved.</p>',
      textBody: 'Replacement {{replacementItem}} approved.',
    },
    {
      templateKey: 'claim_rejected',
      locale: 'en-US',
      version: 2,
      subject: 'Update on recall claim {{caseReference}}',
      htmlBody:
        '<p>We completed our review of your recall claim {{caseReference}} and could not approve it.</p>' +
        '<p>Reason: {{reason}}</p>' +
        '<p>If you believe information was missed, contact support and include your case reference.</p>',
      textBody:
        'We completed our review of your recall claim {{caseReference}} and could not approve it.\n' +
        'Reason: {{reason}}\n' +
        'If you believe information was missed, contact support and include your case reference.',
    },
    {
      templateKey: 'refund_completed',
      locale: 'en-US',
      version: 2,
      subject: 'Refund completed for recall claim {{caseReference}}',
      htmlBody:
        '<p>Your approved refund for claim {{caseReference}} has been completed.</p>' +
        '<p>Refund amount: {{refundAmount}} {{refundCurrency}}</p>' +
        '<p>{{referenceLine}}</p>' +
        '<p>The time it takes to appear may depend on your bank or payment provider. ' +
        'Contact support if it is not visible soon.</p>',
      textBody:
        'Your approved refund for claim {{caseReference}} has been completed.\n' +
        'Refund amount: {{refundAmount}} {{refundCurrency}}\n' +
        '{{referenceLine}}\n' +
        'The time it takes to appear may depend on your bank or payment provider.',
    },
    {
      templateKey: 'shipment_shipped',
      locale: 'en-US',
      version: 2,
      subject: 'Your replacement has shipped - claim {{caseReference}}',
      htmlBody:
        '<p>Your replacement for claim {{caseReference}} has shipped.</p>' +
        '<p>Tracking number: {{trackingNumber}}</p>',
      textBody:
        'Your replacement for claim {{caseReference}} has shipped.\n' +
        'Tracking number: {{trackingNumber}}',
    },
    {
      templateKey: 'case_completed',
      locale: 'en-US',
      version: 1,
      subject: 'Recall case {{caseReference}} is complete',
      htmlBody:
        '<p>Your recall case {{caseReference}} is complete.</p>' +
        '<p>Completed resolution: {{completedResolutionLabel}}</p>',
      textBody:
        'Your recall case {{caseReference}} is complete.\n' +
        'Completed resolution: {{completedResolutionLabel}}',
    },
    {
      templateKey: 'case_closed',
      locale: 'en-US',
      version: 2,
      subject: 'Recall case {{caseReference}} has been closed',
      htmlBody:
        '<p>Your recall case {{caseReference}} has been closed.</p>' +
        '<p>Reason: {{closureReason}}</p>' +
        '<p>If you did not request this closure, contact support and include your case reference.</p>',
      textBody:
        'Your recall case {{caseReference}} has been closed.\n' +
        'Reason: {{closureReason}}\n' +
        'If you did not request this closure, contact support and include your case reference.',
    },
  ];

  console.log('Upserting templates...');
  await db
    .insert(templateVersions)
    .values(templates)
    .onConflictDoUpdate({
      target: [templateVersions.templateKey, templateVersions.locale, templateVersions.version],
      set: {
        subject: sql`excluded.subject`,
        htmlBody: sql`excluded.html_body`,
        textBody: sql`excluded.text_body`,
      },
    });
  console.log('--- Template library initialized ---');
}

setupTemplates().catch(console.error);
