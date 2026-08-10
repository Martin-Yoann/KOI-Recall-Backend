/** Delivery outcome reported by the email provider webhook (T5.3/O5). */
export type ProviderDeliveryEvent =
  'email.delivered' | 'email.bounced' | 'email.complained' | 'email.failed';

export interface CommunicationService {
  queueClaimConfirmation(caseId: string): Promise<string>;

  /**
   * Applies a provider delivery event to the matching communication, keyed by
   * the provider message id (T5.3/O5). Records the event in webhook_events
   * (deduplicated by provider event id) and transitions the communication
   * status to delivered / bounced / failed accordingly.
   */
  recordDeliveryEvent(input: {
    providerEventId: string;
    providerMessageId: string;
    eventType: ProviderDeliveryEvent;
    payload: Record<string, unknown>;
  }): Promise<void>;
}
