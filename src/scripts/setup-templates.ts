import 'dotenv/config';

import { sql } from 'drizzle-orm';

import { createDatabase } from '../db/client.js';
import { templateVersions } from '../db/schema/index.js';
import { loadConfig } from '../config/env.js';

/**
 * Seeds the template version library with the known trigger-point templates.
 * Idempotent: re-running upserts each version row instead of wiping the
 * table, so existing rows (and communications pinned to them) survive.
 *
 * Bump a template's `version` to publish a change: the loader picks the highest
 * version for a (key, locale), and older rows stay in place so communications
 * already pinned to them keep rendering.
 *
 * ── Variable contract ────────────────────────────────────────────────────────
 * The renderer is fail-closed, so a template may only reference variables its
 * trigger actually supplies. The sets below are what the call sites pass today:
 *
 *   claim_confirmation   caseReference, submittedAt
 *   need_info            caseReference, requestedInformation, actionUrl
 *   refund_approved      caseReference, refundAmount, refundCurrency
 *   replacement_approved caseReference, replacementItem
 *   claim_rejected       caseReference, reason
 *   refund_completed     caseReference, refundAmount, refundCurrency, referenceLine
 *   shipment_shipped     caseReference, trackingNumber
 *   case_completed       caseReference, completedResolutionLabel
 *   case_closed          caseReference, closureReason
 *
 * `referenceLine` may be an empty string when there is no external reference, so
 * it is rendered as a bare line rather than a labelled row that would look
 * broken when blank.
 */

// ── Brand tokens, mirrored from the consumer web app's globals.css ────────────
const BRAND = '#dc2626';
const ALERT = '#ea580c';
const SUCCESS = '#16a34a';
const INFO = '#2563eb';
const INK = '#1a1a1a';
const INK_SOFT = '#4a4a4a';
const INK_MUTED = '#a3a3a3';
const SURFACE_DIM = '#f5f5f5';
const BORDER = '#e5e5e5';

const BASE_URL = 'https://www.koiimprtinc.com';
const SUPPORT_EMAIL = 'support@koiimprtinc.com';

const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

/** A labelled fact, rendered as a row in the details card. */
interface Fact {
  label: string;
  value: string;
}

/** Lays content out in a 600px card. Inline styles + tables only: email clients
 *  strip `<style>` blocks and mangle flex/grid, so layout is presentational. */
function shell(parts: {
  preheader: string;
  kicker: string;
  kickerColor?: string;
  title: string;
  body: string;
}): string {
  const kickerColor = parts.kickerColor ?? BRAND;
  return [
    '<!doctype html><html><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    `<title>${parts.title}</title></head>`,
    `<body style="margin:0;padding:0;background:${SURFACE_DIM};">`,
    // Inbox preview text — invisible in the body but shown next to the subject.
    `<div style="display:none;font-size:1px;color:${SURFACE_DIM};line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;">${parts.preheader}</div>`,
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${SURFACE_DIM};">`,
    '<tr><td align="center" style="padding:24px 12px;">',
    `<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:600px;max-width:100%;background:#ffffff;border-radius:8px;overflow:hidden;border:1px solid ${BORDER};">`,

    // Header
    '<tr><td style="padding:18px 28px;border-bottom:1px solid ' + BORDER + ';">',
    `<span style="font-family:${FONT};font-size:17px;font-weight:700;color:${INK};letter-spacing:-0.02em;">KOI</span>`,
    `<span style="font-family:${FONT};font-size:17px;font-weight:400;color:${INK_SOFT};"> Recall</span>`,
    `<span style="float:right;font-family:${FONT};font-size:10px;font-weight:600;letter-spacing:0.09em;text-transform:uppercase;color:${INK_MUTED};padding-top:4px;">Official notice</span>`,
    '</td></tr>',

    // Body
    '<tr><td style="padding:28px 28px 8px;">',
    `<p style="margin:0 0 10px;font-family:${FONT};font-size:11px;font-weight:700;letter-spacing:0.09em;text-transform:uppercase;color:${kickerColor};">${parts.kicker}</p>`,
    `<h1 style="margin:0 0 16px;font-family:${FONT};font-size:24px;line-height:1.28;font-weight:700;color:${INK};letter-spacing:-0.01em;">${parts.title}</h1>`,
    parts.body,
    '</td></tr>',

    // Support / help
    '<tr><td style="padding:8px 28px 28px;">',
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${SURFACE_DIM};border-radius:8px;">`,
    '<tr><td style="padding:18px 20px;">',
    `<p style="margin:0 0 6px;font-family:${FONT};font-size:13px;font-weight:700;color:${INK};">Need help with this claim?</p>`,
    `<p style="margin:0 0 10px;font-family:${FONT};font-size:13px;line-height:1.55;color:${INK_SOFT};">Email <a href="mailto:${SUPPORT_EMAIL}" style="color:${BRAND};text-decoration:underline;">${SUPPORT_EMAIL}</a> and include your case reference <strong style="color:${INK};">{{caseReference}}</strong>.</p>`,
    `<p style="margin:0;font-family:${FONT};font-size:12px;line-height:1.6;color:${INK_SOFT};">`,
    `<a href="${BASE_URL}/faq" style="color:${INK_SOFT};text-decoration:underline;">FAQ</a> &nbsp;·&nbsp; `,
    `<a href="${BASE_URL}/how-it-works" style="color:${INK_SOFT};text-decoration:underline;">How claims work</a> &nbsp;·&nbsp; `,
    `<a href="${BASE_URL}/lookup" style="color:${INK_SOFT};text-decoration:underline;">Track your claim</a>`,
    '</p>',
    '</td></tr></table>',
    '</td></tr>',

    // Footer
    `<tr><td style="background:${INK};padding:18px 28px;">`,
    `<p style="margin:0 0 8px;font-family:${FONT};font-size:11px;line-height:1.6;color:${INK_MUTED};">You are receiving this because you submitted a recall claim. This is a service message about your case, not marketing.</p>`,
    `<p style="margin:0;font-family:${FONT};font-size:11px;line-height:1.6;color:${INK_MUTED};">KOI Importer Inc &nbsp;·&nbsp; <a href="${BASE_URL}/privacy" style="color:${INK_MUTED};text-decoration:underline;">Privacy notice</a></p>`,
    '</td></tr>',

    '</table></td></tr></table></body></html>',
  ].join('');
}

/** The details card. Rows are label/value pairs — the scan-first part of the email. */
function facts(rows: Fact[]): string {
  const body = rows
    .map(
      (row, index) =>
        '<tr>' +
        `<td style="padding:${index === 0 ? '0' : '10px'} 0 0;font-family:${FONT};font-size:10px;font-weight:700;letter-spacing:0.07em;text-transform:uppercase;color:${INK_MUTED};white-space:nowrap;vertical-align:top;width:150px;">${row.label}</td>` +
        `<td style="padding:${index === 0 ? '0' : '10px'} 0 0;font-family:${FONT};font-size:14px;font-weight:600;color:${INK};word-break:break-word;">${row.value}</td>` +
        '</tr>',
    )
    .join('');
  return (
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${SURFACE_DIM};border-radius:8px;margin:0 0 20px;">` +
    `<tr><td style="padding:16px 18px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${body}</table></td></tr></table>`
  );
}

/** Body paragraph. */
function para(text: string, last = false): string {
  return `<p style="margin:0 0 ${last ? '20px' : '14px'};font-family:${FONT};font-size:14px;line-height:1.6;color:${INK_SOFT};">${text}</p>`;
}

/** Bulletproof-ish CTA: a padded table cell rather than a styled `<a>`, which
 *  Outlook renders inconsistently. */
function cta(href: string, label: string): string {
  return (
    '<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 20px;">' +
    `<tr><td align="center" bgcolor="${BRAND}" style="border-radius:6px;">` +
    `<a href="${href}" style="display:inline-block;padding:13px 26px;font-family:${FONT};font-size:14px;font-weight:700;color:#ffffff;text-decoration:none;">${label}</a>` +
    '</td></tr></table>'
  );
}

/** A quiet note for operational caveats (bank timing, what happens next). */
function note(text: string, tone: 'info' | 'muted' = 'muted'): string {
  const color = tone === 'info' ? INFO : INK_MUTED;
  return `<p style="margin:0 0 8px;font-family:${FONT};font-size:12px;line-height:1.6;color:${color};">${text}</p>`;
}

/** Plain-text counterpart. Kept structurally parallel to the HTML so the two
 *  never tell different stories. */
function text(parts: { title: string; lines: string[]; ctaUrl?: string }): string {
  return [
    'KOI Recall — Official notice',
    '',
    parts.title,
    '',
    ...parts.lines,
    '',
    '---',
    `Need help with this claim? Email ${SUPPORT_EMAIL} and include your case reference.`,
    `FAQ: ${BASE_URL}/faq`,
    `How claims work: ${BASE_URL}/how-it-works`,
    `Track your claim: ${BASE_URL}/lookup`,
    '',
    'You are receiving this because you submitted a recall claim.',
    'KOI Importer Inc',
    `Privacy notice: ${BASE_URL}/privacy`,
  ]
    .filter((line) => line !== undefined)
    .join('\n');
}

async function setupTemplates() {
  console.log('--- Start: initialize template version library ---');
  const config = loadConfig();
  const { db } = createDatabase(config.DATABASE_URL!);

  const templates = [
    {
      templateKey: 'claim_confirmation',
      locale: 'en-US',
      version: 4,
      subject: 'We received your recall claim {{caseReference}}',
      htmlBody: shell({
        preheader: 'Your claim is in the queue and needs no action right now.',
        kicker: 'Claim received',
        kickerColor: INFO,
        title: 'We received your recall claim',
        body:
          para(
            'Thank you. Your claim has been submitted and is now in our review queue. You do not need to do anything else right now.',
          ) +
          facts([
            { label: 'Case reference', value: '{{caseReference}}' },
            { label: 'Submitted', value: '{{submittedAt}}' },
          ]) +
          para(
            'A reviewer will check your submission and the evidence you provided. If anything is missing we will email you with exactly what we need.',
          ) +
          para(
            'Keep your case reference handy — it identifies your claim in every message and on the tracking page.',
            true,
          ) +
          para('{{disposalSection}}', true),
      }),
      textBody: text({
        title: 'We received your recall claim',
        lines: [
          'Thank you. Your claim has been submitted and is now in our review queue.',
          'You do not need to do anything else right now.',
          '',
          'Case reference: {{caseReference}}',
          'Submitted: {{submittedAt}}',
          '',
          'A reviewer will check your submission and the evidence you provided.',
          'If anything is missing we will email you with exactly what we need.',
          '',
          '{{disposalSection}}',
        ],
      }),
    },
    {
      templateKey: 'need_info',
      locale: 'en-US',
      version: 4,
      subject: 'Action needed for recall claim {{caseReference}}',
      htmlBody: shell({
        preheader: 'We need one more thing before we can continue your claim.',
        kicker: 'Action needed',
        kickerColor: ALERT,
        title: 'We need more information to continue',
        body:
          para(
            'Your claim is on hold until we receive the following. Reply using the secure link below — do not send personal details by email.',
          ) +
          facts([
            { label: 'Case reference', value: '{{caseReference}}' },
            { label: 'What we need', value: '{{requestedInformation}}' },
          ]) +
          cta('{{actionUrl}}', 'Provide the information') +
          note(
            'The button links to your secure claim page. If it does not open, copy this address into your browser:',
            'info',
          ) +
          `<p style="margin:0 0 16px;font-family:${FONT};font-size:12px;line-height:1.6;color:${INK_SOFT};word-break:break-all;">{{actionUrl}}</p>` +
          note('Your claim stays open while we wait, so there is no need to resubmit it.', 'muted'),
      }),
      textBody: text({
        title: 'We need more information to continue',
        lines: [
          'Your claim is on hold until we receive the following.',
          'Reply using the secure link below — do not send personal details by email.',
          '',
          'Case reference: {{caseReference}}',
          'What we need: {{requestedInformation}}',
          '',
          'Provide the information here:',
          '{{actionUrl}}',
          '',
          'Your claim stays open while we wait, so there is no need to resubmit it.',
        ],
      }),
    },
    {
      templateKey: 'refund_approved',
      locale: 'en-US',
      version: 3,
      subject: 'Refund approved for {{caseReference}}',
      htmlBody: shell({
        preheader: 'Your refund has been approved and is being processed.',
        kicker: 'Approved',
        kickerColor: SUCCESS,
        title: 'Your refund has been approved',
        body:
          para(
            'We reviewed your recall claim and approved a refund. No further action is needed from you.',
          ) +
          facts([
            { label: 'Case reference', value: '{{caseReference}}' },
            { label: 'Refund amount', value: '{{refundAmount}} {{refundCurrency}}' },
            { label: 'Status', value: 'Approved — payment being arranged' },
          ]) +
          para(
            'We will email you again as soon as the payment has been sent. The time it takes to appear after that depends on your bank or payment provider.',
            true,
          ),
      }),
      textBody: text({
        title: 'Your refund has been approved',
        lines: [
          'We reviewed your recall claim and approved a refund.',
          'No further action is needed from you.',
          '',
          'Case reference: {{caseReference}}',
          'Refund amount: {{refundAmount}} {{refundCurrency}}',
          'Status: Approved — payment being arranged',
          '',
          'We will email you again as soon as the payment has been sent.',
        ],
      }),
    },
    {
      templateKey: 'replacement_approved',
      locale: 'en-US',
      version: 3,
      subject: 'Replacement approved for {{caseReference}}',
      htmlBody: shell({
        preheader: 'Your replacement has been approved and is being prepared.',
        kicker: 'Approved',
        kickerColor: SUCCESS,
        title: 'Your replacement has been approved',
        body:
          para(
            'We reviewed your recall claim and approved a replacement. No further action is needed from you.',
          ) +
          facts([
            { label: 'Case reference', value: '{{caseReference}}' },
            { label: 'Replacement', value: '{{replacementItem}}' },
            { label: 'Status', value: 'Approved — preparing shipment' },
          ]) +
          para(
            'We will email you with tracking details as soon as it ships. Please make sure the delivery address on your claim is still correct.',
            true,
          ),
      }),
      textBody: text({
        title: 'Your replacement has been approved',
        lines: [
          'We reviewed your recall claim and approved a replacement.',
          'No further action is needed from you.',
          '',
          'Case reference: {{caseReference}}',
          'Replacement: {{replacementItem}}',
          'Status: Approved — preparing shipment',
          '',
          'We will email you with tracking details as soon as it ships.',
        ],
      }),
    },
    {
      templateKey: 'claim_rejected',
      locale: 'en-US',
      version: 4,
      subject: 'Decision on your recall claim {{caseReference}}',
      htmlBody: shell({
        preheader: 'We have completed the review of your claim.',
        kicker: 'Decision',
        kickerColor: BRAND,
        title: 'We could not approve this claim',
        body:
          para(
            'We completed our review of your recall claim and it does not qualify for a remedy under this recall.',
          ) +
          facts([
            { label: 'Case reference', value: '{{caseReference}}' },
            { label: 'Reason', value: '{{reason}}' },
          ]) +
          para(
            'If you believe something was missed — for example evidence that did not upload, or a lot code we read incorrectly — reply to this message or contact support with your case reference and we will take another look.',
          ) +
          note('Please contact us within 30 days if you want the decision reviewed.', 'info'),
      }),
      textBody: text({
        title: 'We could not approve this claim',
        lines: [
          'We completed our review of your recall claim and it does not qualify',
          'for a remedy under this recall.',
          '',
          'Case reference: {{caseReference}}',
          'Reason: {{reason}}',
          '',
          'If you believe something was missed, reply to this message or contact support',
          'with your case reference and we will take another look.',
          'Please contact us within 30 days if you want the decision reviewed.',
        ],
      }),
    },
    {
      templateKey: 'refund_completed',
      locale: 'en-US',
      version: 4,
      subject: 'Refund sent for recall claim {{caseReference}}',
      htmlBody: shell({
        preheader: 'Your refund has been sent.',
        kicker: 'Refund sent',
        kickerColor: SUCCESS,
        title: 'Your refund has been sent',
        body:
          para('The refund for your recall claim has been completed and sent.') +
          facts([
            { label: 'Case reference', value: '{{caseReference}}' },
            { label: 'Refund amount', value: '{{refundAmount}} {{refundCurrency}}' },
          ]) +
          para('{{referenceLine}}') +
          para(
            'How long it takes to appear depends on your bank or payment provider — usually a few business days. If it has not arrived after that, contact support with your case reference.',
            true,
          ),
      }),
      textBody: text({
        title: 'Your refund has been sent',
        lines: [
          'The refund for your recall claim has been completed and sent.',
          '',
          'Case reference: {{caseReference}}',
          'Refund amount: {{refundAmount}} {{refundCurrency}}',
          '{{referenceLine}}',
          '',
          'How long it takes to appear depends on your bank or payment provider.',
          'If it has not arrived after a few business days, contact support.',
        ],
      }),
    },
    {
      templateKey: 'shipment_shipped',
      locale: 'en-US',
      version: 4,
      subject: 'Your replacement is on its way — {{caseReference}}',
      htmlBody: shell({
        preheader: 'Your replacement has shipped.',
        kicker: 'On its way',
        kickerColor: SUCCESS,
        title: 'Your replacement has shipped',
        body:
          para('Your replacement for this recall claim is on its way to you.') +
          facts([
            { label: 'Case reference', value: '{{caseReference}}' },
            { label: 'Tracking number', value: '{{trackingNumber}}' },
          ]) +
          para(
            'Use the tracking number with the carrier to follow the delivery. If it has not arrived within the carrier’s usual window, contact support and include your case reference.',
            true,
          ),
      }),
      textBody: text({
        title: 'Your replacement has shipped',
        lines: [
          'Your replacement for this recall claim is on its way to you.',
          '',
          'Case reference: {{caseReference}}',
          'Tracking number: {{trackingNumber}}',
          '',
          'Use the tracking number with the carrier to follow the delivery.',
        ],
      }),
    },
    {
      templateKey: 'case_completed',
      locale: 'en-US',
      version: 3,
      subject: 'Recall case {{caseReference}} is complete',
      htmlBody: shell({
        preheader: 'Your recall case is closed as complete.',
        kicker: 'Complete',
        kickerColor: SUCCESS,
        title: 'Your recall case is complete',
        body:
          para('The remedy for your recall claim has been completed and this case is now closed.') +
          facts([
            { label: 'Case reference', value: '{{caseReference}}' },
            { label: 'Resolution', value: '{{completedResolutionLabel}}' },
          ]) +
          para(
            'Thank you for taking part in this recall — returning or reporting an affected product is what makes recalls work.',
            true,
          ),
      }),
      textBody: text({
        title: 'Your recall case is complete',
        lines: [
          'The remedy for your recall claim has been completed and this case is now closed.',
          '',
          'Case reference: {{caseReference}}',
          'Resolution: {{completedResolutionLabel}}',
          '',
          'Thank you for taking part in this recall.',
        ],
      }),
    },
    {
      templateKey: 'case_closed',
      locale: 'en-US',
      version: 4,
      subject: 'Recall case {{caseReference}} has been closed',
      htmlBody: shell({
        preheader: 'Your recall case has been closed.',
        kicker: 'Closed',
        kickerColor: INK_SOFT,
        title: 'Your recall case has been closed',
        body:
          para('This recall case is now closed.') +
          facts([
            { label: 'Case reference', value: '{{caseReference}}' },
            { label: 'Reason', value: '{{closureReason}}' },
          ]) +
          para(
            'If you did not ask for this closure, contact support with your case reference and we will reopen it.',
          ) +
          note(
            'If you still have an affected product, stop using it and follow the instructions in the recall notice.',
            'info',
          ),
      }),
      textBody: text({
        title: 'Your recall case has been closed',
        lines: [
          'This recall case is now closed.',
          '',
          'Case reference: {{caseReference}}',
          'Reason: {{closureReason}}',
          '',
          'If you did not ask for this closure, contact support with your case reference',
          'and we will reopen it.',
          '',
          'If you still have an affected product, stop using it and follow the',
          'instructions in the recall notice.',
        ],
      }),
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
