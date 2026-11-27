import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { OpenAPIHono } from '@hono/zod-openapi';
import type { DatabaseHandle, DatabaseExecutor } from '../src/db/client.js';
import type { TransactionalEmail } from '../src/platform/email/port.js';
import { NodeSensitiveDataCrypto } from '../src/platform/crypto/node-sensitive-data-crypto.js';
import type { AppEnv } from '../src/middleware/request-context.js';
import { RATE_LIMIT_QUOTAS, routeCategoryForPath } from '../src/middleware/rate-limit.js';

const injected = vi.hoisted(() => ({ handle: null as unknown as DatabaseHandle }));
vi.mock('../src/db/client.js', () => ({ createDatabase: () => injected.handle }));
import { registerConsumerAuthRoutes } from '../src/routes/consumer-auth.js';

const email = 'victim-owned-mailbox@example.invalid';
const password = 'chosen-audit-password';
const reference = 'KOI-TEST-12345678';

describe('mailbox proof before account-linked claim access', () => {
  const pg = new PGlite();
  const db = drizzle(pg);
  injected.handle = {
    db,
    transaction: (work: Parameters<DatabaseHandle['transaction']>[0]) => db.transaction(tx => work(tx as unknown as DatabaseExecutor)),
  } as unknown as DatabaseHandle;
  const messages: TransactionalEmail[] = [];
  let sendingFails = false;
  const app = new OpenAPIHono<AppEnv>();
  registerConsumerAuthRoutes(app, {
    email: { send(message) { messages.push(message); return sendingFails ? Promise.reject(new Error(`Provider secret ${message.text}`)) : Promise.resolve({ providerMessageId: 'local-test-only' }); } },
    consumerWebBaseUrl: 'https://recall.example.invalid',
  });
  beforeAll(async () => {
    vi.stubEnv('DATABASE_URL', 'postgresql://audit:audit@localhost/koi_audit_test');
    vi.stubEnv('FIELD_ENCRYPTION_KEY', Buffer.alloc(32, 25).toString('base64'));
    vi.stubEnv('HASH_PEPPER', Buffer.alloc(32, 26).toString('base64'));
    await pg.exec(readFileSync(new URL('../drizzle/0009_bumpy_alex_power.sql', import.meta.url), 'utf8'));
    await pg.exec(readFileSync(new URL('../drizzle/0032_consumer_session_email_verification.sql', import.meta.url), 'utf8'));
    await pg.exec(`CREATE TABLE recall_cases (id uuid,public_reference text,campaign_id uuid,campaign_version_id uuid,submitted_at timestamptz,updated_at timestamptz,status text,locale text);
      CREATE TABLE recall_campaigns (id uuid,slug text);
      CREATE TABLE case_consumers (case_id uuid,first_name_encrypted text,last_name_encrypted text,email_encrypted text,phone_encrypted text,key_version text,email_lookup_hash text);
      CREATE TABLE claimed_products (case_id uuid,campaign_product_id uuid,shape text,flavor text,lot_code text,date_code text);
      CREATE TABLE campaign_products (id uuid,name text);
      CREATE TABLE case_resolutions (case_id uuid,requested_type text,approved_type text,status text,refund_amount_minor integer,currency text,completed_at timestamptz);
      CREATE TABLE campaign_localizations (campaign_version_id uuid,locale text,title text);
      CREATE TABLE case_events (case_id uuid,event_type text,data jsonb,occurred_at timestamptz);
      INSERT INTO recall_campaigns VALUES ('00000000-0000-4000-8000-000000000001','audit-test');
      INSERT INTO recall_cases VALUES ('00000000-0000-4000-8000-000000000002','${reference}','00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000003',now(),now(),'submitted','en-US');`);
    const crypto = new NodeSensitiveDataCrypto(process.env.FIELD_ENCRYPTION_KEY!, process.env.HASH_PEPPER!);
    const first = await crypto.encrypt('Private Victim');
    const last = await crypto.encrypt('Name');
    const encryptedEmail = await crypto.encrypt(email);
    const phone = await crypto.encrypt('+15550000000');
    await pg.query('INSERT INTO case_consumers VALUES ($1,$2,$3,$4,$5,$6,$7)', ['00000000-0000-4000-8000-000000000002', first.value, last.value, encryptedEmail.value, phone.value, first.keyVersion, await crypto.lookupHash(email)]);
  });
  beforeEach(async () => { messages.length = 0; sendingFails = false; await pg.exec('TRUNCATE consumer_users CASCADE'); });
  afterAll(async () => { await pg.close(); vi.unstubAllEnvs(); });

  const request = (path: string, token?: string, body?: unknown) => app.request(`/v1/consumer-auth${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  async function signup(address = email) {
    const r = await request('/register', undefined, { email: address, password, displayName: 'Unverified registrant', claimsAccessVerified: true, emailVerifiedAt: new Date().toISOString() });
    expect(r.status).toBe(201);
    const body = await r.json() as { token: string; user: { claimsAccessVerified: boolean } };
    expect(body.user.claimsAccessVerified).toBe(false);
    return body.token;
  }
  async function login() {
    const r = await request('/login', undefined, { email, password });
    expect(r.status).toBe(200);
    return (await r.json() as { token: string }).token;
  }
  async function issue(token: string, locale = 'en-US') {
    const r = await request('/email-verification', token, { locale });
    expect(r.status).toBe(202);
    const link = new URL(messages.at(-1)!.text.match(/https:\/\/[^\s]+/)![0]);
    const proof = new URLSearchParams(link.hash.slice(1)).get('token')!;
    expect(proof).toHaveLength(43);
    expect(await r.text()).not.toContain(proof);
    expect(link.searchParams.has('token')).toBe(false);
    return { proof, link };
  }
  const confirm = (session: string, proof: string) => request('/email-verification/confirm', session, { token: proof });

  it('blocks the original registration-to-private-history reproduction on both endpoints', async () => {
    const token = await signup();
    for (const path of ['/claims', `/claims/${reference}`]) {
      const r = await request(path, token);
      expect(r.status).toBe(403);
      expect(r.headers.get('Cache-Control')).toBe('no-store');
      expect(await r.text()).toContain('email-verification-required');
    }
    expect((await pg.query('SELECT email_verified_at FROM consumer_sessions')).rows).toEqual([{ email_verified_at: null }]);
  });
  it('grants only the proven session access, with one-use hashed proof', async () => {
    const token = await signup(); const { proof } = await issue(token);
    expect(messages[0]!.to).toBe(email);
    const stored = await pg.query<{ token_hash: string }>('SELECT token_hash FROM consumer_email_verifications');
    expect(stored.rows[0]!.token_hash).toBe(createHash('sha256').update(proof).digest('hex'));
    expect((await request('/claims', token)).status).toBe(403);
    expect((await confirm(token, proof)).status).toBe(200);
    const me = await request('/me', token);
    expect(await me.json()).toMatchObject({ user: { claimsAccessVerified: true } });
    const claims = await request('/claims', token);
    expect(claims.status).toBe(200);
    expect(await claims.json()).toMatchObject({ claims: [{ consumerName: 'Private Victim Name', consumerPhone: '+15550000000' }] });
    expect((await request(`/claims/${reference}`, token)).status).toBe(200);
    expect((await confirm(token, proof)).status).toBe(400);
    expect((await request('/claims/KOI-TEST-00000000', token)).status).toBe(404);
    const already = await request('/email-verification', token, {});
    expect(await already.json()).toEqual({ status: 'verified' });
    expect(messages).toHaveLength(1);
  });
  it('does not upgrade other sessions or a subsequent login for the same account', async () => {
    const a = await signup(); const b = await login(); const { proof } = await issue(a);
    expect((await confirm(b, proof)).status).toBe(400);
    expect((await confirm(a, proof)).status).toBe(200);
    expect((await request('/claims', a)).status).toBe(200);
    expect((await request('/claims', b)).status).toBe(403);
    const c = await login(); expect((await request('/claims', c)).status).toBe(403);
  });
  it('refuses a different account without consuming the intended session proof', async () => {
    const a = await signup(); const other = await signup('different@example.invalid'); const { proof } = await issue(a);
    expect((await confirm(other, proof)).status).toBe(400);
    expect((await confirm(a, proof)).status).toBe(200);
    const { proof: otherProof } = await issue(other);
    expect((await confirm(other, otherProof)).status).toBe(200);
    expect(await (await request('/claims', other)).json()).toEqual({ claims: [] });
    expect((await request(`/claims/${reference}`, other)).status).toBe(404);
  });
  it('rejects expired and malformed links without granting access', async () => {
    const token = await signup(); const { proof } = await issue(token);
    await pg.exec("UPDATE consumer_email_verifications SET expires_at = now() - interval '1 second'");
    expect((await confirm(token, proof)).status).toBe(400);
    expect((await confirm(token, 'not-a-token')).status).toBe(400);
    expect((await request('/claims', token)).status).toBe(403);
  });
  it('limits resend across account sessions and invalidates an older link on resend', async () => {
    const a = await signup(); const b = await login(); const { proof: old } = await issue(a);
    expect((await request('/email-verification', b, {})).status).toBe(429);
    await pg.exec("UPDATE consumer_email_verifications SET created_at = now() - interval '2 minutes'");
    const { proof } = await issue(a);
    expect((await confirm(a, old)).status).toBe(400);
    expect((await confirm(a, proof)).status).toBe(200);
  });
  it('cannot verify a revoked session', async () => {
    const token = await signup(); const { proof } = await issue(token);
    expect((await request('/logout', token, {})).status).toBe(200);
    expect((await confirm(token, proof)).status).toBe(401);
    expect((await request('/claims', await login())).status).toBe(403);
  });
  it('fails closed on delivery failure and hides provider secrets', async () => {
    const token = await signup(); sendingFails = true;
    const r = await request('/email-verification', token, {});
    expect(r.status).toBe(503);
    const body = await r.text(); expect(body).not.toContain('Provider secret'); expect(body).not.toContain('#token=');
    expect((await request('/claims', token)).status).toBe(403);
  });
  it('accepts a proof at most once under concurrent confirmation', async () => {
    const token = await signup(); const { proof } = await issue(token);
    const responses = await Promise.all([confirm(token, proof), confirm(token, proof)]);
    expect(responses.map(r => r.status).sort()).toEqual([200, 400]);
  });
  it('does not allow profile data to forge mailbox proof', async () => {
    const token = await signup();
    const r = await app.request('/v1/consumer-auth/me', { method: 'PATCH', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ displayName: 'Updated', claimsAccessVerified: true, emailVerifiedAt: new Date().toISOString() }) });
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ user: { claimsAccessVerified: false } });
    expect((await request('/claims', token)).status).toBe(403);
  });
  it('uses Spanish code-authored email text and rejects unsupported locale values', async () => {
    const token = await signup();
    expect((await request('/email-verification', token, { locale: {} })).status).toBe(400);
    expect((await request('/email-verification', token, { locale: 'fr-FR' })).status).toBe(400);
    expect(messages).toHaveLength(0);
    const { link } = await issue(token, 'es-US');
    expect(link.searchParams.get('lang')).toBe('es');
    expect(messages[0]!.subject).toContain('Confirme su correo');
    expect(messages[0]!.html).not.toContain('<script');
  });
  it('requires login to request or confirm and keeps GET scanners from activating links', async () => {
    expect((await request('/email-verification', undefined, {})).status).toBe(401);
    expect((await confirm('', 'A'.repeat(43))).status).toBe(401);
    expect((await request('/email-verification/confirm')).status).toBe(404);
    expect(routeCategoryForPath('/v1/consumer-auth/email-verification')).toBe('consumer-email-verification');
    expect(routeCategoryForPath('/v1/consumer-auth/email-verification/confirm')).toBe('consumer-email-verification');
    expect(RATE_LIMIT_QUOTAS['consumer-email-verification']).toBe(10);
  });
});
