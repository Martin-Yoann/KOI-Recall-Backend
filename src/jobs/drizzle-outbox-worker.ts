import { and, eq, inArray, lte, sql } from 'drizzle-orm';

import type { Database } from '../db/client.js';
import { campaignMessageTemplates, communications, outboxEvents } from '../db/schema/index.js';
import type { SensitiveDataCryptoPort } from '../platform/crypto/port.js';
import type { TransactionalEmailPort } from '../platform/email/port.js';
import type { OutboxJobResult, OutboxWorker } from './outbox.js';

const MAX_ATTEMPTS = 5;
const BATCH_LIMIT = 50;

/**
 * Drains the transactional outbox (T5.1/O5): claims a batch of pending events
 * with FOR UPDATE SKIP LOCKED so concurrent workers never double-send, renders
 * the email from the communication + message template, sends via the injected
 * email port, and transitions outbox + communication states. The
 * `deduplicationKey` unique index keeps redeliveries idempotent; failures are
 * retried with backoff up to {@link MAX_ATTEMPTS} then dead-lettered.
 */
export class DrizzleOutboxWorker implements OutboxWorker {
  constructor(
    private readonly db: Database,
    private readonly email: TransactionalEmailPort,
    private readonly crypto: SensitiveDataCryptoPort,
  ) {}

  async runBatch(limit: number = BATCH_LIMIT): Promise<OutboxJobResult> {
    // Claim: atomically select a batch of pending, due events and mark them
    // processing. SKIP LOCKED lets concurrent workers drain disjoint batches.
    const claimedIds = await this.db.transaction(async (tx) => {
      const events = await tx
        .select({ id: outboxEvents.id })
        .from(outboxEvents)
        .where(and(eq(outboxEvents.status, 'pending'), lte(outboxEvents.availableAt, new Date())))
        .limit(limit)
        .for('update', { skipLocked: true });

      if (events.length === 0) return [];

      const ids = events.map((event) => event.id);
      await tx
        .update(outboxEvents)
        .set({
          status: 'processing',
          lockedAt: new Date(),
          attempts: sql`${outboxEvents.attempts} + 1`,
        })
        .where(inArray(outboxEvents.id, ids));

      return ids;
    });

    if (claimedIds.length === 0) return { claimed: 0, succeeded: 0, failed: 0 };

    let succeeded = 0;
    let failed = 0;
    for (const id of claimedIds) {
      try {
        await this.processEvent(id);
        succeeded += 1;
      } catch {
        failed += 1;
      }
    }
    return { claimed: claimedIds.length, succeeded, failed };
  }

  private async processEvent(id: string): Promise<void> {
    const db = this.db;

    const [event] = await db.select().from(outboxEvents).where(eq(outboxEvents.id, id)).limit(1);
    if (!event) return;

    const payload = event.payload as { communicationId?: string };
    if (!payload.communicationId) {
      await this.fail(id, event.attempts, 'communication_id_missing');
      return;
    }

    const [communication] = await db
      .select()
      .from(communications)
      .where(eq(communications.id, payload.communicationId))
      .limit(1);
    if (!communication) {
      await this.fail(id, event.attempts, 'communication_not_found');
      return;
    }

    const [template] = await db
      .select({
        subject: campaignMessageTemplates.subject,
        htmlBody: campaignMessageTemplates.htmlBody,
        textBody: campaignMessageTemplates.textBody,
      })
      .from(campaignMessageTemplates)
      .where(eq(campaignMessageTemplates.id, communication.templateId))
      .limit(1);
    if (!template) {
      await this.fail(id, event.attempts, 'template_not_found');
      return;
    }

    const recipient = await this.crypto.decrypt({
      keyVersion: communication.recipientKeyVersion,
      value: communication.recipientEncrypted,
    });

    const result = await this.email.send({
      messageKey: communication.messageKey,
      to: recipient,
      subject: template.subject,
      html: template.htmlBody,
      text: template.textBody,
    });

    await db.transaction(async (tx) => {
      await tx
        .update(outboxEvents)
        .set({ status: 'succeeded', processedAt: new Date() })
        .where(eq(outboxEvents.id, id));
      await tx
        .update(communications)
        .set({
          status: 'sent',
          providerMessageId: result.providerMessageId,
          sentAt: new Date(),
        })
        .where(eq(communications.id, communication.id));
    });
  }

  private async fail(id: string, currentAttempts: number, errorCode: string): Promise<void> {
    const nextAttempts = currentAttempts + 1;
    await this.db
      .update(outboxEvents)
      .set({
        status: nextAttempts >= MAX_ATTEMPTS ? 'dead_letter' : 'failed',
        attempts: nextAttempts,
        lastErrorCode: errorCode,
        availableAt: new Date(Date.now() + Math.min(1000 * 2 ** nextAttempts, 60_000)),
      })
      .where(eq(outboxEvents.id, id));
  }
}
