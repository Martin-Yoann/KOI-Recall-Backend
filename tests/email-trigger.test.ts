import { describe, expect, it } from 'vitest';

import { EmailTriggerService } from '../src/modules/communications/email-trigger-service.js';
import { DrizzleCommunicationQueueService } from '../src/modules/communications/queue-service.js';
import type { CommunicationQueueService } from '../src/modules/communications/queue-service.js';
import { EmailRenderer, EmailRenderError } from '../src/platform/email/renderer.js';
import { CaseConsumerMissingError, EmailTemplateMissingError } from '../src/shared/errors.js';
import type { DatabaseExecutor } from '../src/db/client.js';

describe('EmailRenderer', () => {
  it('substitutes every occurrence of a placeholder', () => {
    const rendered = EmailRenderer.render('{{caseReference}} paid {{caseReference}}', {
      caseReference: 'KOI-1234-ABCD',
    });
    expect(rendered).toBe('KOI-1234-ABCD paid KOI-1234-ABCD');
  });

  it('html-escapes variable values', () => {
    const rendered = EmailRenderer.render('Hi {{name}}', { name: '<b>Ann</b> & Co' });
    expect(rendered).toBe('Hi &lt;b&gt;Ann&lt;/b&gt; &amp; Co');
  });

  it('treats $-sequences in values literally', () => {
    // `&` is escaped first; the `$`-sequence must survive as literal text
    // rather than being read as a replacement pattern.
    const rendered = EmailRenderer.render('Ref: {{value}}', { value: '$&$1' });
    expect(rendered).toBe('Ref: $&amp;$1');
  });

  it('fails closed when a placeholder cannot be resolved', () => {
    expect(() => EmailRenderer.render('Hello {{name}}, {{other}}', { name: 'Ann' })).toThrow(
      EmailRenderError,
    );
  });

  it('renders status wording without a compliance block (regression)', () => {
    const rendered = EmailRenderer.render('Refund {{amount}} approved.', { amount: '19.99' });
    expect(rendered).toBe('Refund 19.99 approved.');
  });
});

/** Minimal DatabaseExecutor fake capturing inserts and serving canned select rows in order. */
function createFakeExecutor(selectResults: unknown[]) {
  const inserted: Array<{ table: unknown; values: Record<string, unknown> }> = [];
  const executor = {
    inserted,
    insert(table: unknown) {
      return {
        values: (values: Record<string, unknown>) => {
          const record = () => inserted.push({ table, values });
          return {
            returning: () => {
              record();
              return Promise.resolve([{ id: 'comm-1' }]);
            },
            onConflictDoNothing: () => {
              record();
              return Promise.resolve(undefined);
            },
          };
        },
      };
    },
    select() {
      const result = selectResults.shift();
      return {
        from: () => ({
          where: () => {
            const limit = () => Promise.resolve(result === undefined ? [] : [result]);
            return { limit, orderBy: () => ({ limit }) };
          },
        }),
      };
    },
  };
  return { executor: executor as unknown as DatabaseExecutor, inserted };
}

describe('DrizzleCommunicationQueueService', () => {
  it('writes a communication pinned to the template version plus its outbox event', async () => {
    const { executor, inserted } = createFakeExecutor([]);
    const queue = new DrizzleCommunicationQueueService();

    await queue.queue(executor, {
      caseId: 'case-1',
      templateVersionId: 'tv-1',
      recipientKeyVersion: 'v1',
      recipientEncrypted: 'enc',
      deduplicationKey: 'claim-confirmation:REF-1',
      eventType: 'claim.confirmation.requested',
      variables: { caseReference: 'REF-1' },
    });

    expect(inserted).toHaveLength(2);
    const communication = inserted[0]!;
    expect(communication.values).toMatchObject({
      caseId: 'case-1',
      templateVersionId: 'tv-1',
      messageKey: 'claim-confirmation:REF-1',
    });
    // The legacy campaign-template FK is no longer faked with a zero UUID.
    expect(communication.values).not.toHaveProperty('templateId');
    const outbox = inserted[1]!;
    expect(outbox.values).toMatchObject({
      eventType: 'claim.confirmation.requested',
      deduplicationKey: 'claim-confirmation:REF-1',
    });
  });
});

describe('EmailTriggerService', () => {
  const queueStub: CommunicationQueueService = {
    queue: () => Promise.resolve(),
  };

  it('resolves the consumer, latest template version, and enqueues', async () => {
    const { executor, inserted } = createFakeExecutor([
      { keyVersion: 'v1', emailEncrypted: 'enc-email' },
      { id: 'tv-7' },
    ]);
    let queued: unknown;
    const trigger = new EmailTriggerService({
      queue: (_tx, params) => {
        queued = params;
        return Promise.resolve();
      },
    });

    await trigger.trigger(executor, {
      caseId: 'case-1',
      templateKey: 'refund_approved',
      locale: 'en-US',
      variables: { caseReference: 'REF-1' },
      deduplicationKey: 'res-approve:case-1:refund',
      eventType: 'resolution.approval.requested',
    });

    expect(queued).toMatchObject({
      caseId: 'case-1',
      templateVersionId: 'tv-7',
      recipientKeyVersion: 'v1',
      recipientEncrypted: 'enc-email',
      eventType: 'resolution.approval.requested',
    });
    expect(inserted).toHaveLength(0);
  });

  it('throws CaseConsumerMissingError when the case has no consumer', async () => {
    const { executor } = createFakeExecutor([]);
    const trigger = new EmailTriggerService(queueStub);

    await expect(
      trigger.trigger(executor, {
        caseId: 'case-1',
        templateKey: 'refund_approved',
        locale: 'en-US',
        variables: {},
        deduplicationKey: 'k',
        eventType: 'resolution.approval.requested',
      }),
    ).rejects.toBeInstanceOf(CaseConsumerMissingError);
  });

  it('throws EmailTemplateMissingError when no version exists for the key + locale', async () => {
    const { executor } = createFakeExecutor([{ keyVersion: 'v1', emailEncrypted: 'enc-email' }]);
    const trigger = new EmailTriggerService(queueStub);

    await expect(
      trigger.trigger(executor, {
        caseId: 'case-1',
        templateKey: 'refund_approved',
        locale: 'fr-FR',
        variables: {},
        deduplicationKey: 'k',
        eventType: 'resolution.approval.requested',
      }),
    ).rejects.toBeInstanceOf(EmailTemplateMissingError);
  });
});
