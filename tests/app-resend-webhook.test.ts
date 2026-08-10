import { describe, expect, it } from 'vitest';
import { Webhook } from 'svix';

import { createApp } from '../src/app.js';
import { createPlaceholderRegistry, type ApplicationRegistry } from '../src/composition.js';
import { loadConfig } from '../src/config/env.js';
import type { CommunicationService } from '../src/modules/communications/service.js';

const WEBHOOK_SECRET = `whsec_${Buffer.alloc(32, 9).toString('base64')}`;

function appWith(recordDeliveryEvent: CommunicationService['recordDeliveryEvent']) {
  const base = createPlaceholderRegistry();
  const registry: ApplicationRegistry = {
    services: {
      ...base.services,
      communications: {
        queueClaimConfirmation: () => Promise.resolve('case-1'),
        recordDeliveryEvent,
      },
    },
    platform: base.platform,
  };
  return createApp({
    config: loadConfig({
      CORS_ALLOWED_ORIGINS: 'https://consumer.example.com',
      RESEND_WEBHOOK_SECRET: WEBHOOK_SECRET,
    }),
    registry,
  });
}

async function postEvent(
  app: ReturnType<typeof appWith>,
  body: unknown,
  options: { secret?: string; messageId?: string } = {},
) {
  const rawBody = JSON.stringify(body);
  const messageId = options.messageId ?? 'msg_webhook_1';
  const timestamp = new Date();
  const signature = new Webhook(options.secret ?? WEBHOOK_SECRET).sign(
    messageId,
    timestamp,
    rawBody,
  );
  return app.request('/webhooks/resend', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'svix-id': messageId,
      'svix-timestamp': String(Math.floor(timestamp.getTime() / 1000)),
      'svix-signature': signature,
    },
    body: rawBody,
  });
}

describe('POST /webhooks/resend (T5.3/O5)', () => {
  it('rejects a missing secret with 401', async () => {
    const app = appWith(() => Promise.resolve());
    const response = await app.request('/webhooks/resend', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'email.delivered', data: { email_id: 'msg-1' } }),
    });
    expect(response.status).toBe(401);
  });

  it('rejects an invalid signature with 400', async () => {
    const app = appWith(() => Promise.resolve());
    const response = await postEvent(
      app,
      { type: 'email.delivered', data: { email_id: 'msg-1' } },
      { secret: `whsec_${Buffer.alloc(32, 3).toString('base64')}` },
    );
    expect(response.status).toBe(400);
  });

  it('forwards a delivery event to the communication service', async () => {
    let received: unknown;
    const app = appWith((input) => {
      received = input;
      return Promise.resolve();
    });
    const response = await postEvent(
      app,
      { type: 'email.delivered', data: { email_id: 'msg-1' } },
      { messageId: 'evt-delivered-1' },
    );

    expect(response.status).toBe(200);
    expect(received).toMatchObject({
      providerMessageId: 'msg-1',
      providerEventId: 'evt-delivered-1',
      eventType: 'email.delivered',
      payload: { type: 'email.delivered', data: { email_id: 'msg-1' } },
    });
  });

  it('acks events without a message id without mutating state', async () => {
    let called = false;
    const app = appWith(() => {
      called = true;
      return Promise.resolve();
    });
    const response = await postEvent(app, { type: 'email.sent' });
    expect(response.status).toBe(200);
    expect(called).toBe(false);
  });

  it('maps a database failure to 503', async () => {
    const app = appWith(() =>
      Promise.reject(Object.assign(new Error('connect failed'), { code: 'ECONNREFUSED' })),
    );
    const response = await postEvent(
      app,
      { type: 'email.bounced', data: { email_id: 'msg-1' } },
      {},
    );
    expect(response.status).toBe(503);
  });
});
