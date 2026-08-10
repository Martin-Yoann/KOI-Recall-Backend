import { describe, expect, it } from 'vitest';

import { createApp } from '../src/app.js';
import { createPlaceholderRegistry, type ApplicationRegistry } from '../src/composition.js';
import { loadConfig } from '../src/config/env.js';
import type { CommunicationService } from '../src/modules/communications/service.js';

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
      RESEND_WEBHOOK_SECRET: 'webhook-secret',
    }),
    registry,
  });
}

async function postEvent(app: ReturnType<typeof appWith>, body: unknown, secret?: string) {
  return app.request('/webhooks/resend', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(secret ? { 'X-Resend-Webhook-Secret': secret } : {}),
    },
    body: JSON.stringify(body),
  });
}

describe('POST /webhooks/resend (T5.3/O5)', () => {
  it('rejects a missing secret with 401', async () => {
    const app = appWith(() => Promise.resolve());
    const response = await postEvent(app, { type: 'email.delivered', data: { email_id: 'msg-1' } });
    expect(response.status).toBe(401);
  });

  it('rejects an invalid secret with 401', async () => {
    const app = appWith(() => Promise.resolve());
    const response = await postEvent(
      app,
      { type: 'email.delivered', data: { email_id: 'msg-1' } },
      'wrong-secret',
    );
    expect(response.status).toBe(401);
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
      'webhook-secret',
    );

    expect(response.status).toBe(200);
    expect(received).toMatchObject({
      providerMessageId: 'msg-1',
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
    const response = await postEvent(app, { type: 'email.sent' }, 'webhook-secret');
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
      'webhook-secret',
    );
    expect(response.status).toBe(503);
  });
});
