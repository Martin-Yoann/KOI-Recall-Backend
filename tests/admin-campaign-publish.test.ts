/* eslint-disable @typescript-eslint/require-await -- test fakes return resolved values synchronously */
import { describe, expect, it } from 'vitest';

import { createApp } from '../src/app.js';
import { createPlaceholderRegistry, type ApplicationRegistry } from '../src/composition.js';
import { loadConfig } from '../src/config/env.js';
import type { CampaignService, PublishVersionInput } from '../src/modules/campaigns/service.js';
import type { AuditEventInput, AuditService } from '../src/modules/staff/audit-service.js';
import type { StaffRole } from '../src/modules/staff/permissions.js';
import type { StaffService } from '../src/modules/staff/service.js';
import type { SensitiveDataCryptoPort } from '../src/platform/crypto/port.js';
import { parseCampaignApprovals } from '../src/routes/admin.js';
import { CampaignValidationError } from '../src/shared/errors.js';

/**
 * Covers the campaign publish route: permission gating, the shape validation on
 * the sign-off list, and the guarantee that the recorded actor comes from the
 * session rather than the request body.
 */

const ADMIN_KEY = 'admin-secret';
const TOKEN = 'session-token';
const ACTOR_ID = 'staff-user-1';

const cryptoFake: SensitiveDataCryptoPort = {
  encrypt: (plaintext) => Promise.resolve({ keyVersion: 'v1', value: `enc:${plaintext}` }),
  decrypt: (ciphertext) => Promise.resolve(ciphertext.value.replace(/^enc:/, '')),
  lookupHash: (value) => Promise.resolve(`h:${value}`),
};

function makeStaffFake(role: StaffRole = 'MANAGER'): StaffService {
  const unused = () => Promise.reject(new Error('not exercised by this suite'));
  return {
    login: async () => ({
      token: TOKEN,
      sessionId: 'sess-1',
      expiresAt: '2099-01-01T00:00:00.000Z',
    }),
    resolveSession: async (token) =>
      token === TOKEN
        ? {
            userId: ACTOR_ID,
            sessionId: 'sess-1',
            role,
            displayName: 'Operator',
            email: 'operator@example.com',
            expiresAt: '2099-01-01T00:00:00.000Z',
          }
        : null,
    touchSession: async () => {},
    revokeSession: async () => {},
    revokeAllSessions: async () => {},
    refreshSession: async () => null,
    listStaff: async () => [],
    createStaffUser: unused,
    updateStaffUser: unused,
    changePassword: async () => {},
    deleteStaffUser: async () => {},
    getStaffUserByEmail: async () => null,
  };
}

function makeAuditFake(): AuditService & { recorded: AuditEventInput[] } {
  const recorded: AuditEventInput[] = [];
  return {
    recorded,
    async record(input) {
      recorded.push(input);
    },
    async query() {
      return { events: [], total: 0, nextCursor: null };
    },
  };
}

function makeCampaignFake(
  behaviour: (input: PublishVersionInput) => Promise<{ versionNumber: number; publishedAt: string }> = async (
    input,
  ) => ({ versionNumber: input.versionNumber, publishedAt: '2026-09-17T00:00:00.000Z' }),
): CampaignService & { calls: PublishVersionInput[] } {
  const calls: PublishVersionInput[] = [];
  return {
    calls,
    getPublishedCampaign: async () => null,
    async publishVersion(input) {
      calls.push(input);
      return behaviour(input);
    },
  };
}

function appWith(opts: { campaigns: CampaignService; audit?: AuditService; role?: StaffRole }) {
  const base = createPlaceholderRegistry();
  const registry: ApplicationRegistry = {
    services: {
      ...base.services,
      campaigns: opts.campaigns,
      staff: makeStaffFake(opts.role),
      ...(opts.audit ? { audit: opts.audit } : {}),
    },
    platform: { ...base.platform, crypto: cryptoFake },
  };
  return createApp({
    config: loadConfig({
      CORS_ALLOWED_ORIGINS: 'https://consumer.example.com',
      ADMIN_API_KEY: ADMIN_KEY,
    }),
    registry,
  });
}

const VALID_BODY = {
  versionNumber: 2,
  approvals: [
    { role: 'business', approvedBy: 'Dana Business' },
    { role: 'legal_compliance', approvedBy: 'Lee Legal' },
  ],
};

function post(body: unknown, headers: Record<string, string> = {}) {
  return {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  };
}

const auth = { Authorization: `Bearer ${TOKEN}` };

describe('campaign publish route', () => {
  it('rejects an unauthenticated request with 401', async () => {
    const response = await appWith({ campaigns: makeCampaignFake() }).request(
      '/admin/campaigns/music-lollipop-demo-2026/publish',
      post(VALID_BODY),
    );

    expect(response.status).toBe(401);
  });

  it('does not accept the legacy admin key on this route', async () => {
    // Publishing is a net-new endpoint, so it has no backward-compatibility
    // obligation to the deprecated shared-secret path.
    const response = await appWith({ campaigns: makeCampaignFake() }).request(
      '/admin/campaigns/music-lollipop-demo-2026/publish',
      post(VALID_BODY, { Authorization: `Bearer ${ADMIN_KEY}` }),
    );

    expect(response.status).toBe(401);
  });

  it('publishes and records the actor from the session, not the body', async () => {
    const campaigns = makeCampaignFake();
    const audit = makeAuditFake();
    const response = await appWith({ campaigns, audit }).request(
      '/admin/campaigns/music-lollipop-demo-2026/publish',
      post({ ...VALID_BODY, publishedBy: 'someone-else' }, auth),
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as { campaign: Record<string, unknown> };
    expect(body.campaign).toMatchObject({
      slug: 'music-lollipop-demo-2026',
      versionNumber: 2,
    });

    expect(campaigns.calls).toHaveLength(1);
    expect(campaigns.calls[0]?.publishedBy).toBe(ACTOR_ID);
    expect(campaigns.calls[0]?.publishedBy).not.toBe('someone-else');
    expect(campaigns.calls[0]?.campaignSlug).toBe('music-lollipop-demo-2026');

    expect(audit.recorded[0]).toMatchObject({
      actorUserId: ACTOR_ID,
      action: 'campaign.publish',
      resourceType: 'campaign',
      resourceId: 'music-lollipop-demo-2026',
      outcome: 'success',
    });
  });

  it('stamps approvedAt when the caller omits it', async () => {
    const campaigns = makeCampaignFake();
    await appWith({ campaigns }).request(
      '/admin/campaigns/music-lollipop-demo-2026/publish',
      post(VALID_BODY, auth),
    );

    for (const approval of campaigns.calls[0]?.approvals ?? []) {
      expect(Number.isNaN(Date.parse(approval.approvedAt))).toBe(false);
    }
  });

  it('rejects a non-integer versionNumber with 422', async () => {
    const response = await appWith({ campaigns: makeCampaignFake() }).request(
      '/admin/campaigns/music-lollipop-demo-2026/publish',
      post({ ...VALID_BODY, versionNumber: 'two' }, auth),
    );

    expect(response.status).toBe(422);
  });

  it('rejects a malformed approvals list with 422', async () => {
    const response = await appWith({ campaigns: makeCampaignFake() }).request(
      '/admin/campaigns/music-lollipop-demo-2026/publish',
      post({ versionNumber: 2, approvals: 'legal said yes' }, auth),
    );

    expect(response.status).toBe(422);
  });

  it('surfaces a failed publish gate as 422 rather than 500', async () => {
    const campaigns = makeCampaignFake(async () => {
      throw new CampaignValidationError('Approval by legal_compliance is required before publishing.');
    });
    const response = await appWith({ campaigns }).request(
      '/admin/campaigns/music-lollipop-demo-2026/publish',
      post(VALID_BODY, auth),
    );

    expect(response.status).toBe(422);
  });
});

describe('parseCampaignApprovals', () => {
  it('accepts the two mandatory roles and the optional CPSC one', () => {
    const parsed = parseCampaignApprovals([
      { role: 'business', approvedBy: 'Dana' },
      { role: 'legal_compliance', approvedBy: 'Lee' },
      { role: 'cpsc_if_applicable', approvedBy: 'Sam' },
    ]);

    expect(parsed).not.toBeNull();
    expect(parsed?.map((entry) => entry.role)).toEqual([
      'business',
      'legal_compliance',
      'cpsc_if_applicable',
    ]);
  });

  it('trims the approver name and preserves a supplied timestamp', () => {
    const parsed = parseCampaignApprovals([
      { role: 'business', approvedBy: '  Dana  ', approvedAt: '2026-01-02T03:04:05.000Z' },
    ]);

    expect(parsed?.[0]?.approvedBy).toBe('Dana');
    expect(parsed?.[0]?.approvedAt).toBe('2026-01-02T03:04:05.000Z');
  });

  it('rejects an unknown role', () => {
    expect(parseCampaignApprovals([{ role: 'ceo', approvedBy: 'Dana' }])).toBeNull();
  });

  it('rejects a repeated role', () => {
    // The gate's role check is set-based, so a duplicate would pass there while
    // looking like two independent sign-offs in the stored record.
    expect(
      parseCampaignApprovals([
        { role: 'business', approvedBy: 'Dana' },
        { role: 'business', approvedBy: 'Lee' },
      ]),
    ).toBeNull();
  });

  it('rejects an empty or missing approver name', () => {
    expect(parseCampaignApprovals([{ role: 'business', approvedBy: '   ' }])).toBeNull();
    expect(parseCampaignApprovals([{ role: 'business' }])).toBeNull();
  });

  it('rejects an unparseable approvedAt', () => {
    expect(
      parseCampaignApprovals([
        { role: 'business', approvedBy: 'Dana', approvedAt: 'last tuesday' },
      ]),
    ).toBeNull();
  });

  it('rejects non-array and empty input', () => {
    expect(parseCampaignApprovals(undefined)).toBeNull();
    expect(parseCampaignApprovals([])).toBeNull();
    expect(parseCampaignApprovals({ role: 'business', approvedBy: 'Dana' })).toBeNull();
  });

  it('rejects a non-object entry', () => {
    expect(parseCampaignApprovals(['business'])).toBeNull();
    expect(parseCampaignApprovals([null])).toBeNull();
  });
});
