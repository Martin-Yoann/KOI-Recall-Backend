import { OpenAPIHono } from '@hono/zod-openapi';
import { describe, expect, it } from 'vitest';

import type { AdminTransactionRunner, ApplicationRegistry } from '../src/composition.js';
import type { AppEnv } from '../src/middleware/request-context.js';
import type { DisposalService } from '../src/modules/disposal/service.js';
import type { AuditService } from '../src/modules/staff/audit-service.js';
import { registerDisposalRoutes } from '../src/routes/disposal.js';
import { makeDisposalFake } from './helpers/disposal-fake.js';

describe('disposal decision audit boundary', () => {
  it('uses one transaction runner for a review and its success audit', async () => {
    let directMutation = false;
    let stagedMutation = false;
    let enteredTransaction = false;
    const directDisposal: DisposalService = {
      ...makeDisposalFake(),
      reviewBatch() {
        directMutation = true;
        return Promise.resolve();
      },
    };
    const transactionalDisposal: DisposalService = {
      ...makeDisposalFake(),
      reviewBatch() {
        stagedMutation = true;
        return Promise.resolve();
      },
    };
    const directAudit: AuditService = {
      async record() {},
      query() {
        return Promise.resolve({ events: [], total: 0, nextCursor: null });
      },
    };
    const transactionalAudit: AuditService = {
      ...directAudit,
      record() {
        return Promise.reject(new Error('audit insert failed'));
      },
    };
    const transactions: AdminTransactionRunner = {
      async run(work) {
        enteredTransaction = true;
        try {
          return await work({
            admin: {} as never,
            staff: {} as never,
            audit: transactionalAudit,
            disposal: transactionalDisposal,
          });
        } catch (error) {
          stagedMutation = false;
          throw error;
        }
      },
    };
    const registry = {
      services: { disposal: directDisposal, audit: directAudit, adminTransactions: transactions },
      platform: {},
    } as unknown as ApplicationRegistry;
    const app = new OpenAPIHono<AppEnv>();
    app.use('/admin/*', async (context, next) => {
      context.set('requestId', 'test-request');
      context.set('principal', {
        userId: '21326c9a-5dc2-430f-98a6-546729a1065f',
        sessionId: 'test-session',
        role: 'COMPLIANCE',
        displayName: 'Reviewer',
        email: 'reviewer@example.test',
      });
      await next();
    });
    app.onError((_error, context) => context.json({ error: 'operation failed' }, 500));
    registerDisposalRoutes(app, registry);

    const response = await app.request(
      '/admin/disposal-batches/21326c9a-5dc2-430f-98a6-546729a1065f/review',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          decision: 'accepted',
          rationale: 'The evidence is legible and complete.',
        }),
      },
    );

    expect(enteredTransaction).toBe(true);
    expect(directMutation).toBe(false);
    expect(stagedMutation).toBe(false);
    expect(response.status).toBe(500);
  });

  it('uses one transaction runner for a revocation and its success audit', async () => {
    let enteredTransaction = false;
    let stagedMutation = false;
    let auditCalls = 0;
    let changed = true;
    const disposal: DisposalService = {
      ...makeDisposalFake(),
      revokeAuthorization() {
        stagedMutation = true;
        return Promise.resolve({
          authorizationId: '6f2a41d2-63b6-4b0e-8f6f-3f9a1c41d0e7',
          changed,
        });
      },
    };
    const audit: AuditService = {
      record() {
        auditCalls += 1;
        return Promise.resolve();
      },
      query() {
        return Promise.resolve({ events: [], total: 0, nextCursor: null });
      },
    };
    const transactions: AdminTransactionRunner = {
      async run(work) {
        enteredTransaction = true;
        try {
          return await work({ admin: {} as never, staff: {} as never, audit, disposal });
        } catch (error) {
          stagedMutation = false;
          throw error;
        }
      },
    };
    const registry = {
      services: { disposal, audit, adminTransactions: transactions },
      platform: {},
    } as unknown as ApplicationRegistry;
    const app = new OpenAPIHono<AppEnv>();
    app.use('/admin/*', async (context, next) => {
      context.set('requestId', 'test-request');
      context.set('principal', {
        userId: '21326c9a-5dc2-430f-98a6-546729a1065f',
        sessionId: 'test-session',
        role: 'COMPLIANCE',
        displayName: 'Reviewer',
        email: 'reviewer@example.test',
      });
      await next();
    });
    app.onError((_error, context) => context.json({ error: 'operation failed' }, 500));
    registerDisposalRoutes(app, registry);

    const revoke = () =>
      app.request('/admin/disposal-tasks/21326c9a-5dc2-430f-98a6-546729a1065f/authorization/revoke', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: 'Issued against the wrong instruction version.' }),
      });

    const first = await revoke();
    expect(first.status).toBe(204);
    expect(enteredTransaction).toBe(true);
    expect(stagedMutation).toBe(true);
    expect(auditCalls).toBe(1);

    // The idempotent retry reports the same business fact; the trail records a
    // revocation once, not once per click.
    stagedMutation = false;
    changed = false;
    const retry = await revoke();
    expect(retry.status).toBe(204);
    expect(stagedMutation).toBe(true);
    expect(auditCalls).toBe(1);
  });
});
