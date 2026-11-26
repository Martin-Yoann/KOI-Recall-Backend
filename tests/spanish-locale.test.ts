import { describe, expect, it } from 'vitest';
import { localeQuerySchema } from '../src/contracts/common.js';
import { claimSubmissionRequestSchema } from '../src/contracts/claims.js';
import { claimConfirmationVariables } from '../src/modules/cases/submission-notification.js';
import { spanishEmailTemplates } from '../src/modules/communications/spanish-templates.js';
import { EmailRenderer } from '../src/platform/email/renderer.js';
import { drizzle } from 'drizzle-orm/node-postgres';
import { buildTemplateVersionQuery } from '../src/modules/communications/template-loader.js';

describe('Spanish consumer locale', () => {
  it('prefers the requested email language before version, with English only as a missing-translation fallback', () => {
    const db = drizzle.mock();
    const spanish = buildTemplateVersionQuery(db, 'claim_confirmation', 'es-US').toSQL();
    expect(spanish.params).toEqual(['claim_confirmation', 'es-US', 'en-US', 'es-US', 1]);
    expect(spanish.sql).toContain('order by case when');
    const unsupported = buildTemplateVersionQuery(db, 'claim_confirmation', 'fr-FR').toSQL();
    expect(unsupported.params).not.toContain('en-US');
  });
  it('accepts Spanish for public campaign reads and claim submissions', () => {
    expect(localeQuerySchema.parse({ locale: 'es-US' }).locale).toBe('es-US');
    expect(localeQuerySchema.safeParse({ locale: 'fr-FR' }).success).toBe(false);
    const body = {
      draftId: '21326c9a-5dc2-430f-98a6-546729a1065f',
      draftToken: 'x'.repeat(32),
      locale: 'es-US',
      consumer: { firstName: 'Ana', lastName: 'García', email: 'ana@example.com' },
      products: [
        {
          campaignProductId: '5e41d8b9-03c4-46d4-9b87-80c40cdfbde5',
          quantity: 1,
          purchaseChannel: 'gift',
          identificationMode: 'unknown',
        },
      ],
      remedyCode: 'replacement',
      documentIds: [],
      incidentAnswer: 'no',
      consents: [
        { type: 'privacy_notice', textVersion: 'v1', accepted: true },
        { type: 'information_accuracy', textVersion: 'v1', accepted: true },
      ],
    };
    expect(claimSubmissionRequestSchema.parse(body).locale).toBe('es-US');
  });

  it('retains the disposal capability fragment and selects Spanish when resuming from email', () => {
    const variables = claimConfirmationVariables({
      caseReference: 'KOI-ABCD-12345678',
      submittedAt: new Date(),
      campaignSlug: 'recall',
      consumerWebBaseUrl: 'https://recall.example.com',
      locale: 'es-US',
      disposal: { taskId: 'task', token: 'secret' },
    });
    const url = new URL(variables.disposalResumeUrl);
    expect(url.searchParams.get('lang')).toBe('es');
    expect(url.hash).toBe('#token=secret');
    expect(variables.disposalSection).toContain('Puede volver');
  });

  it('provides renderable Spanish templates for all existing transactional triggers', () => {
    const templates = spanishEmailTemplates();
    expect(new Set(templates.map((t) => t.templateKey)).size).toBe(10);
    const variables = {
      caseReference: 'KOI-ABCD-12345678',
      submittedAt: '2026-11-26',
      disposalSection: 'No se requiere eliminación.',
      updateSection: 'Original operator update',
      requestedInformation: 'Original instructions',
      actionUrl: 'https://recall.example.com/?lang=es',
      refundAmount: '6.00',
      refundCurrency: 'USD',
      replacementItem: 'Producto de reemplazo',
      reason: 'Original reason',
      trackingNumber: 'TRACK123',
      completedResolutionLabel: 'Reemplazo',
      closureReason: 'Original closure reason',
    };
    for (const template of templates) {
      expect(template.locale).toBe('es-US');
      expect(EmailRenderer.render(template.htmlBody, variables)).not.toContain('{{');
      expect(EmailRenderer.render(template.textBody, variables)).toContain(variables.caseReference);
      expect(EmailRenderer.render(template.subject, variables)).toContain(variables.caseReference);
    }
  });
});
