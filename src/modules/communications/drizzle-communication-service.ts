import { eq } from 'drizzle-orm';

import type { Database } from '../../db/client.js';
import { communications, webhookEvents } from '../../db/schema/index.js';
import type { CommunicationService, ProviderDeliveryEvent } from './service.js';

const DELIVERY_STATUS: Record<ProviderDeliveryEvent, 'delivered' | 'bounced' | 'failed'> = {
  'email.delivered': 'delivered',
  'email.bounced': 'bounced',
  'email.complained': 'failed',
  'email.failed': 'failed',
};

/**
 * Records provider delivery events against communications (T5.3/O5). The
 * webhook_events row is deduplicated by (provider, providerEventId) so provider
 * redeliveries are idempotent; the communication status transitions to
 * delivered/bounced/failed and the provider message id is captured.
 */
export class DrizzleCommunicationService implements CommunicationService {
  constructor(private readonly db: Database) {}

  async recordDeliveryEvent(input: {
    providerEventId: string;
    providerMessageId: string;
    eventType: ProviderDeliveryEvent;
    payload: Record<string, unknown>;
  }): Promise<void> {
    const db = this.db;

    // Dedup: a processed provider event is a no-op (unique index backstops
    // concurrent redeliveries).
    const [existing] = await db
      .select({ id: webhookEvents.id })
      .from(webhookEvents)
      .where(eq(webhookEvents.providerEventId, input.providerEventId))
      .limit(1);
    if (existing) return;

    await db.insert(webhookEvents).values({
      provider: 'resend',
      providerEventId: input.providerEventId,
      eventType: input.eventType,
      status: 'processing',
      payload: input.payload,
      receivedAt: new Date(),
    });

    const [communication] = await db
      .select({ id: communications.id, status: communications.status })
      .from(communications)
      .where(eq(communications.providerMessageId, input.providerMessageId))
      .limit(1);
    if (!communication) {
      // Provider reported an event for a message we do not track; record the
      // webhook as failed so it can be inspected, but do not error the request.
      await db
        .update(webhookEvents)
        .set({
          status: 'failed',
          lastErrorCode: 'communication_not_found',
          processedAt: new Date(),
        })
        .where(eq(webhookEvents.providerEventId, input.providerEventId));
      return;
    }

    const nextStatus = DELIVERY_STATUS[input.eventType];
    await db.transaction(async (tx) => {
      await tx
        .update(communications)
        .set({
          status: nextStatus,
          ...(nextStatus === 'delivered' ? { deliveredAt: new Date() } : {}),
        })
        .where(eq(communications.id, communication.id));
      await tx
        .update(webhookEvents)
        .set({ status: 'processed', processedAt: new Date() })
        .where(eq(webhookEvents.providerEventId, input.providerEventId));
    });
  }
}
