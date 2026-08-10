import type { EmailSendResult, TransactionalEmail, TransactionalEmailPort } from './port.js';

const RESEND_API_URL = 'https://api.resend.com/emails';

/**
 * Resend transactional email adapter (T5.1/O5). Sends a single transactional
 * email via the Resend REST API and returns the provider message id for
 * webhook-driven state transitions. Requires a `RESEND_API_KEY`.
 */
export class ResendEmailAdapter implements TransactionalEmailPort {
  constructor(
    private readonly apiKey: string,
    private readonly fromAddress: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async send(message: TransactionalEmail): Promise<EmailSendResult> {
    const response = await this.fetchImpl(RESEND_API_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: this.fromAddress,
        to: [message.to],
        subject: message.subject,
        html: message.html,
        text: message.text,
      }),
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(`Resend rejected the email (${response.status}): ${detail.slice(0, 200)}`);
    }

    const payload = (await response.json()) as { id?: string };
    if (!payload.id) throw new Error('Resend returned no message id.');
    return { providerMessageId: payload.id };
  }
}
