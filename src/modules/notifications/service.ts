import { type DatabaseExecutor } from '../../db/client.js';
import { communications, outboxEvents } from '../../db/schema/index.js';

export interface NotificationService {
  queueNotification(
    tx: DatabaseExecutor,
    params: {
      caseId: string;
      templateVersionId: string;
      recipientKeyVersion: string;
      recipientEncrypted: string;
      deduplicationKey: string;
      variables: Record<string, any>;
    }
  ): Promise<void>;
}

export class DrizzleNotificationService implements NotificationService {
  async queueNotification(
    tx: DatabaseExecutor,
    { caseId, templateVersionId, recipientKeyVersion, recipientEncrypted, deduplicationKey, variables }: Parameters<NotificationService['queueNotification']>[1]
  ): Promise<void> {
    const [comm] = await tx.insert(communications).values({
      caseId,
      // Legacy NOT NULL column; template versioning is the real source of truth.
      templateId: '00000000-0000-0000-0000-000000000000',
      templateVersionId,
      messageKey: deduplicationKey,
      recipientKeyVersion,
      recipientEncrypted,
    }).returning();

    if (!comm) throw new Error('[Notification] Failed to create communication record.');

    await tx.insert(outboxEvents).values({
      aggregateType: 'recall_case',
      aggregateId: caseId,
      eventType: 'email.requested',
      deduplicationKey,
      payload: { communicationId: comm.id, variables },
    }).onConflictDoNothing();
  }
}
