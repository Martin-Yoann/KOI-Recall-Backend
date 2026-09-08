import { type DatabaseExecutor } from '../../db/client.js';
import { communications, outboxEvents } from '../../db/schema/index.js';

/**
 * Transactional enqueue of one communication + its outbox event, in the
 * caller's transaction. The outbox worker drains `email.requested`-family
 * events and sends via the email port; the `deduplicationKey` unique index
 * keeps redeliveries idempotent.
 */
export interface CommunicationQueueService {
  queue(
    tx: DatabaseExecutor,
    params: {
      caseId: string;
      /** Optional for legacy rows only; new sends always pin a version. */
      templateVersionId: string;
      recipientKeyVersion: string;
      recipientEncrypted: string;
      /** Also the communication messageKey; must be unique per logical email. */
      deduplicationKey: string;
      /** Outbox event type naming the trigger, e.g. `claim.confirmation.requested`. */
      eventType: string;
      variables: Record<string, string>;
    },
  ): Promise<void>;
}

export class DrizzleCommunicationQueueService implements CommunicationQueueService {
  async queue(
    tx: DatabaseExecutor,
    {
      caseId,
      templateVersionId,
      recipientKeyVersion,
      recipientEncrypted,
      deduplicationKey,
      eventType,
      variables,
    }: Parameters<CommunicationQueueService['queue']>[1],
  ): Promise<void> {
    const [comm] = await tx
      .insert(communications)
      .values({
        caseId,
        templateVersionId,
        messageKey: deduplicationKey,
        recipientKeyVersion,
        recipientEncrypted,
      })
      .returning();

    if (!comm) throw new Error('[CommunicationQueue] Failed to create communication record.');

    await tx
      .insert(outboxEvents)
      .values({
        aggregateType: 'recall_case',
        aggregateId: caseId,
        eventType,
        deduplicationKey,
        payload: { communicationId: comm.id, variables },
      })
      .onConflictDoNothing();
  }
}
