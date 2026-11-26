import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import type { DatabaseExecutor, DatabaseHandle } from '../src/db/client.js';
import { DrizzleDisposalService } from '../src/modules/disposal/drizzle-disposal-service.js';

describe('disposal instruction locale at task creation', () => {
  const pg = new PGlite();
  const db = drizzle(pg);
  const service = new DrizzleDisposalService({ handle: { db } as unknown as DatabaseHandle });
  const version = randomUUID();
  beforeAll(async () => {
    await pg.exec(`CREATE TABLE disposal_instruction_versions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),campaign_version_id uuid,version_number integer,locale text,status text);
      CREATE TABLE disposal_instruction_approvals (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),instruction_version_id uuid REFERENCES disposal_instruction_versions(id),authorizes_consumer_disposal boolean,withdrawn_at timestamptz,effective_from timestamptz,effective_until timestamptz);
      CREATE TABLE disposal_tasks (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),instruction_version_id uuid REFERENCES disposal_instruction_versions(id),draft_id uuid,case_id uuid,token_hash varchar(64),token_expires_at timestamptz,eligibility_status text DEFAULT 'pending_confirmation',eligibility_confirmed_by_staff_user_id uuid,eligibility_confirmed_at timestamptz,eligibility_note text,status text DEFAULT 'open',version integer DEFAULT 1,created_at timestamptz DEFAULT now(),updated_at timestamptz DEFAULT now());`);
  });
  beforeEach(async () => { await pg.exec('TRUNCATE disposal_tasks,disposal_instruction_approvals,disposal_instruction_versions'); });
  afterAll(async () => { await pg.close(); });

  async function instruction(locale: string, number: number, options: { status?: string; authorizes?: boolean; withdrawn?: boolean; from?: Date; until?: Date; campaign?: string } = {}) {
    const id = randomUUID();
    await pg.query('INSERT INTO disposal_instruction_versions VALUES ($1,$2,$3,$4,$5)', [id, options.campaign ?? version, number, locale, options.status ?? 'approved']);
    await pg.query('INSERT INTO disposal_instruction_approvals (instruction_version_id,authorizes_consumer_disposal,withdrawn_at,effective_from,effective_until) VALUES ($1,$2,$3,$4,$5)', [id, options.authorizes ?? true, options.withdrawn ? new Date() : null, options.from ?? null, options.until ?? null]);
    return id;
  }
  async function selected(locale?: string) {
    const result = await service.createTaskForSubmission(db as unknown as DatabaseExecutor, { draftId: randomUUID(), caseId: null, campaignVersionId: version, productIds: [], hasIncident: false, ...(locale ? { locale } : {}) });
    if (!result) return null;
    return (await pg.query<{ instruction_version_id: string }>('SELECT instruction_version_id FROM disposal_tasks WHERE id=$1', [result.taskId])).rows[0]!.instruction_version_id;
  }
  it('English v1 wins over Spanish v2 for an English claim', async () => {
    const en = await instruction('en-US', 1); const es = await instruction('es-US', 2);
    expect(await selected('en-US')).toBe(en);
    expect(await selected('es-US')).toBe(es);
    expect(await selected()).toBe(en);
  });
  it('language priority wins over a newer fallback version', async () => {
    const es = await instruction('es-US', 1); await instruction('en-US', 20);
    expect(await selected('es-US')).toBe(es);
  });
  it('uses the newest valid version within the requested language', async () => {
    await instruction('es-US', 1); const latest = await instruction('es-US', 2);
    await instruction('es-US', 3, { from: new Date(Date.now() + 86400000) });
    expect(await selected('es-US')).toBe(latest);
  });
  it('falls back only to approved effective English instructions', async () => {
    const en = await instruction('en-US', 1);
    await instruction('es-US', 2, { status: 'draft' });
    await instruction('es-US', 3, { until: new Date(Date.now() - 86400000) });
    await instruction('es-US', 4, { withdrawn: true });
    await instruction('es-US', 5, { authorizes: false });
    await instruction('es-US', 6, { campaign: randomUUID() });
    await instruction('fr-FR', 99);
    expect(await selected('es-US')).toBe(en);
  });
  it('does not give English claimants unrelated-language instructions', async () => {
    await instruction('es-US', 2);
    expect(await selected('en-US')).toBeNull();
  });
  it('keeps disposal unavailable when neither language has a valid approval', async () => {
    await instruction('en-US', 1, { authorizes: false });
    await instruction('es-US', 2, { withdrawn: true });
    expect(await selected('es-US')).toBeNull();
  });
});
