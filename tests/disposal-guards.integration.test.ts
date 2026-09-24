import { assertLocalIntegrationDatabase } from './helpers/db-guard.js';
// Opt-in integration test for the disposal domain's database-level guards.
// Runs only when RUN_DB_INTEGRATION=true AND DATABASE_URL is set.
//
// These assertions exist because the two most important rules in the disposal
// domain are enforced by CHECK constraints rather than by application code. A
// unit test cannot prove a constraint fires — only a real Postgres can.
import 'dotenv/config';

import { randomUUID } from 'node:crypto';

import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDatabase, type DatabaseHandle } from '../src/db/client.js';
import {
  campaignVersions,
  claimDrafts,
  disposalDeclarations,
  disposalInstructionApprovals,
  disposalInstructionVersions,
  disposalTasks,
  recallCampaigns,
  staffUsers,
} from '../src/db/schema/index.js';

const enabled = process.env.RUN_DB_INTEGRATION === 'true' && Boolean(process.env.DATABASE_URL);

assertLocalIntegrationDatabase(process.env.DATABASE_URL);
const handle: DatabaseHandle | null = enabled
  ? createDatabase(process.env.DATABASE_URL as string)
  : null;

const VERSION_NUMBER = 987_654;

describe.skipIf(!enabled)('disposal domain guards (database integration)', () => {
  let instructionVersionId: string;
  let taskId: string;
  let staffUserId: string;
  let campaignVersionId: string;
  let draftId: string;

  beforeAll(async () => {
    const db = handle!.db;
    // Its own campaign version and draft, rather than whichever ones happen to be
    // in the database. Borrowing an existing draft made this suite depend on
    // residue: a fresh database has none, and a task with neither a draft nor a
    // case violates disposal_tasks_owner_chk.
    const [campaign] = await db.select({ id: recallCampaigns.id }).from(recallCampaigns).limit(1);
    const [staff] = await db.select({ id: staffUsers.id }).from(staffUsers).limit(1);
    if (!campaign || !staff) throw new Error('Seed data is required.');

    staffUserId = staff.id;

    const [campaignVersion] = await db
      .insert(campaignVersions)
      .values({
        campaignId: campaign.id,
        versionNumber: 400_000 + Math.floor(Math.random() * 90_000),
        status: 'draft',
      })
      .returning({ id: campaignVersions.id });
    campaignVersionId = campaignVersion!.id;

    draftId = randomUUID();
    await db.insert(claimDrafts).values({
      id: draftId,
      campaignId: campaign.id,
      campaignVersionId,
      tokenHash: randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, ''),
      expiresAt: new Date(Date.now() + 3_600_000),
    });
    const [version] = await db
      .insert(disposalInstructionVersions)
      .values({
        campaignVersionId,
        versionNumber: VERSION_NUMBER,
        locale: 'en-US',
        title: 'Integration test instructions (temporary)',
        steps: [{ order: 1, text: 'Temporary step.' }],
        referenceImages: [],
        safetyWarnings: ['Temporary warning.'],
        recognitionRequirements: ['Temporary requirement.'],
        declarationTextVersion: 'integration-test-v1',
      })
      .returning({ id: disposalInstructionVersions.id });
    instructionVersionId = version!.id;

    const [task] = await db
      .insert(disposalTasks)
      .values({
        instructionVersionId,
        draftId,
        caseId: null,
        tokenHash: 'a'.repeat(64),
        tokenExpiresAt: new Date(Date.now() + 86_400_000),
      })
      .returning({ id: disposalTasks.id });
    taskId = task!.id;
  });

  afterAll(async () => {
    if (!handle) return;
    const db = handle.db;
    await db.delete(disposalDeclarations).where(eq(disposalDeclarations.taskId, taskId));
    await db.delete(disposalTasks).where(eq(disposalTasks.id, taskId));
    await db
      .delete(disposalInstructionApprovals)
      .where(eq(disposalInstructionApprovals.instructionVersionId, instructionVersionId));
    await db
      .delete(disposalInstructionVersions)
      .where(eq(disposalInstructionVersions.id, instructionVersionId));
    await db.delete(claimDrafts).where(eq(claimDrafts.id, draftId));
    await db.delete(campaignVersions).where(eq(campaignVersions.id, campaignVersionId));
  });

  function recordApproval(
    input: Pick<
      typeof disposalInstructionApprovals.$inferInsert,
      'materialType' | 'scope' | 'measure' | 'authorizesConsumerDisposal'
    >,
  ) {
    return handle!.db.insert(disposalInstructionApprovals).values({
      instructionVersionId,
      recordedByStaffUserId: staffUserId,
      ...input,
    });
  }

  /**
   * The single most important rule in this domain: material that does not
   * authorize consumer disposal can be *recorded*, but can never be *stored as*
   * authorization. Each of these is a real document a recall file might contain.
   */
  it.each([
    ['a Notice of Violation', 'nov'],
    ['a laboratory report', 'laboratory_report'],
    ['a Form 332 inventory procedure', 'form_332_inventory_procedure'],
    ['a CBP seizure record', 'cbp_seizure_record'],
  ] as const)('refuses to store %s as a consumer-disposal permission', async (_label, material) => {
    await expect(
      recordApproval({
        materialType: material,
        scope: 'consumer_held_product',
        measure: 'consumer_disposal',
        authorizesConsumerDisposal: true,
      }),
    ).rejects.toThrow();
  });

  it('refuses authorization when the measure is not consumer disposal', async () => {
    await expect(
      recordApproval({
        materialType: 'cap_or_written_coordination',
        scope: 'consumer_held_product',
        measure: 'consumer_return',
        authorizesConsumerDisposal: true,
      }),
    ).rejects.toThrow();
  });

  // One scope per test: each assertion is a database round trip, and against a
  // remote database three in a row can exceed the default per-test budget.
  it.each(['enterprise_inventory', 'port_involved_goods', 'not_determined'] as const)(
    'refuses authorization when the scope is %s',
    async (scope) => {
      await expect(
        recordApproval({
          materialType: 'cap_or_written_coordination',
          scope,
          measure: 'consumer_disposal',
          authorizesConsumerDisposal: true,
        }),
      ).rejects.toThrow();
    },
  );

  // The history has to be storable, otherwise the file cannot show what was
  // considered and set aside.
  it('still stores non-authorizing material as history', async () => {
    await expect(
      recordApproval({
        materialType: 'nov',
        scope: 'enterprise_inventory',
        measure: 'not_determined',
        authorizesConsumerDisposal: false,
      }),
    ).resolves.toBeDefined();
  });

  it('stores a genuine authorizing letter', async () => {
    await expect(
      recordApproval({
        materialType: 'recall_expectation_letter',
        scope: 'consumer_held_product',
        measure: 'consumer_disposal',
        authorizesConsumerDisposal: true,
      }),
    ).resolves.toBeDefined();
  });

  it('refuses a declaration with neither an authorization nor an exception', async () => {
    await expect(
      handle!.db.insert(disposalDeclarations).values({
        taskId,
        authorizationId: null,
        exceptionType: null,
        declarationTextVersion: 'integration-test-v1',
      }),
    ).rejects.toThrow();
  });

  it('refuses an exception with no note', async () => {
    await expect(
      handle!.db.insert(disposalDeclarations).values({
        taskId,
        authorizationId: null,
        exceptionType: 'already_disposed_before_authorization',
        exceptionNote: null,
        declarationTextVersion: 'integration-test-v1',
      }),
    ).rejects.toThrow();
  });

  // A consumer who already disposed of the unit reports the truth; no
  // back-dated permission is invented for them.
  it('accepts a truthful pre-authorization disposal exception', async () => {
    await expect(
      handle!.db.insert(disposalDeclarations).values({
        taskId,
        authorizationId: null,
        exceptionType: 'already_disposed_before_authorization',
        exceptionNote: 'The consumer had already discarded the unit.',
        declarationTextVersion: 'integration-test-v1',
      }),
    ).resolves.toBeDefined();
  });
});
