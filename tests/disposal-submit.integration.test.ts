import { assertLocalIntegrationDatabase } from './helpers/db-guard.js';
// Opt-in integration test for disposal task creation on claim submission.
// Runs only when RUN_DB_INTEGRATION=true AND DATABASE_URL is set.
import 'dotenv/config';

import { and, desc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDatabase, type DatabaseHandle } from '../src/db/client.js';
import {
  claimDrafts,
  disposalInstructionApprovals,
  disposalInstructionVersions,
  disposalTasks,
  recallCampaigns,
  staffUsers,
} from '../src/db/schema/index.js';
import { DrizzleCaseService } from '../src/modules/cases/drizzle-case-service.js';
import { DrizzleCommunicationQueueService } from '../src/modules/communications/queue-service.js';
import { DrizzleDisposalService } from '../src/modules/disposal/drizzle-disposal-service.js';
import { DrizzleCaseResolutionService } from '../src/modules/resolutions/drizzle-case-resolution-service.js';
import { NodeSensitiveDataCrypto } from '../src/platform/crypto/node-sensitive-data-crypto.js';
import {
  cleanupClaimFixture,
  createClaimFixture,
  type ClaimFixture,
} from './helpers/case-fixture.js';

const enabled = process.env.RUN_DB_INTEGRATION === 'true' && Boolean(process.env.DATABASE_URL);

assertLocalIntegrationDatabase(process.env.DATABASE_URL);
const handle: DatabaseHandle | null = enabled
  ? createDatabase(process.env.DATABASE_URL as string)
  : null;

const crypto = new NodeSensitiveDataCrypto(
  Buffer.alloc(32, 1).toString('base64'),
  Buffer.alloc(32, 2).toString('base64'),
);
const queue = new DrizzleCommunicationQueueService();

/**
 * Each case drives a full claim submission plus a disposal task inside one
 * transaction, and this suite also runs against a remote database where a round
 * trip costs seconds. The default per-test budget assumes a local Postgres.
 */
describe.skipIf(!enabled)('disposal task creation on submission', { timeout: 120_000 }, () => {
  let service: DrizzleCaseService;
  let disposal: DrizzleDisposalService;
  let campaignSlug: string;
  let campaignVersionId: string;
  let staffUserId: string;
  /** Instruction versions created by this suite, torn down afterwards. */
  const createdVersionIds: string[] = [];

  beforeAll(async () => {
    const db = handle!.db;
    const [staff] = await db.select({ id: staffUsers.id }).from(staffUsers).limit(1);
    if (!staff) throw new Error('Seed data is required.');
    staffUserId = staff.id;

    // Read the campaign version a real submission will pin, from a probe
    // draft. Selecting an active campaign by hand picked one that is not
    // submittable (it carries no privacy-notice version) — that is the
    // fixture's business, not this test's.
    const probe = await createClaimFixture(handle!);
    const [draft] = await db
      .select({
        campaignVersionId: claimDrafts.campaignVersionId,
        campaignId: claimDrafts.campaignId,
      })
      .from(claimDrafts)
      .where(eq(claimDrafts.id, probe.draftId));
    const [campaign] = await db
      .select({ slug: recallCampaigns.slug })
      .from(recallCampaigns)
      .where(eq(recallCampaigns.id, draft!.campaignId));
    campaignVersionId = draft!.campaignVersionId;
    campaignSlug = campaign!.slug;
    await cleanupClaimFixture(handle!, probe);

    disposal = new DrizzleDisposalService({ handle: handle! });
    service = new DrizzleCaseService(
      handle!,
      crypto,
      new DrizzleCaseResolutionService(handle!, crypto),
      undefined,
      undefined,
      false,
      queue,
      false,
      false, // INCIDENT_ESCALATED_STATUS: phase 2 is off in this suite.
      disposal,
    );
  });

  afterAll(async () => {
    if (!handle) return;
    const db = handle.db;
    for (const versionId of createdVersionIds) {
      await db
        .delete(disposalInstructionApprovals)
        .where(eq(disposalInstructionApprovals.instructionVersionId, versionId));
      await db
        .delete(disposalInstructionVersions)
        .where(eq(disposalInstructionVersions.id, versionId));
    }
    await handle.close();
  });

  /**
   * Leaves no approved version on the pinned campaign version, so an assertion
   * about absence is about absence of content rather than about ordering.
   */
  async function demoteApprovedVersions(): Promise<void> {
    await handle!.db
      .update(disposalInstructionVersions)
      .set({ status: 'draft' })
      .where(
        and(
          eq(disposalInstructionVersions.campaignVersionId, campaignVersionId),
          eq(disposalInstructionVersions.status, 'approved'),
        ),
      );
  }

  async function instructionVersion(options: {
    approved: boolean;
    authorizes: boolean;
  }): Promise<string> {
    const db = handle!.db;
    // max + 1. Ordering ascending and adding one reuses an existing number as
    // soon as any version beyond the first is present.
    const [highest] = await db
      .select({ versionNumber: disposalInstructionVersions.versionNumber })
      .from(disposalInstructionVersions)
      .where(eq(disposalInstructionVersions.campaignVersionId, campaignVersionId))
      .orderBy(desc(disposalInstructionVersions.versionNumber))
      .limit(1);
    const versionNumber = (highest?.versionNumber ?? 0) + 1;

    const [version] = await db
      .insert(disposalInstructionVersions)
      .values({
        campaignVersionId,
        versionNumber,
        locale: 'en-US',
        status: options.approved ? 'approved' : 'draft',
        title: 'Submit-path integration instructions',
        steps: [{ order: 1, text: 'Follow the recall instructions.' }],
        referenceImages: [],
        safetyWarnings: ['Do not open or damage the battery.'],
        recognitionRequirements: ['The product label must be readable.'],
        declarationTextVersion: 'submit-integration-v1',
        ...(options.approved ? { approvedAt: new Date(), approvedByStaffUserId: staffUserId } : {}),
      })
      .returning({ id: disposalInstructionVersions.id });

    await db.insert(disposalInstructionApprovals).values({
      instructionVersionId: version!.id,
      materialType: 'recall_expectation_letter',
      scope: 'consumer_held_product',
      measure: options.authorizes ? 'consumer_disposal' : 'consumer_return',
      authorizesConsumerDisposal: options.authorizes,
      recordedByStaffUserId: staffUserId,
    });
    createdVersionIds.push(version!.id);
    return version!.id;
  }

  async function fixture(): Promise<ClaimFixture> {
    return createClaimFixture(handle!, { campaignSlug });
  }

  /**
   * D03: an inapplicable recall must not ask the consumer for a disposal declaration.
   *
   * The consumer surface decides that from one value: whether the submission came back
   * with a disposal task. What this asserts is that the value is *absent* rather than
   * present-and-null. A null would still be falsy in the client, but absence is what
   * makes "no task" and "a task we failed to serialise" both fail towards not asking.
   *
   * The other half of D03 lives in the web app — that the fall-through branch never
   * renders a declaration — and is not covered by this test.
   */
  it('D03: a submission with no disposal task carries no disposal field at all', async () => {
    await demoteApprovedVersions();

    const claim = await fixture();
    const result = await service.submit(claim.command());

    expect(result.caseReference).toBeTruthy();
    expect(Object.prototype.hasOwnProperty.call(result, 'disposal')).toBe(false);
    expect(result.disposal).toBeUndefined();

    await cleanupClaimFixture(handle!, claim);
  });

  it('opens no disposal task when no approved instruction version exists', async () => {
    await demoteApprovedVersions();

    const claim = await fixture();
    const result = await service.submit(claim.command());
    expect(result.disposal).toBeUndefined();
    await cleanupClaimFixture(handle!, claim);
  });

  it('opens a task and returns a resume path when the instruction is approved and authorizing', async () => {
    await demoteApprovedVersions();
    await instructionVersion({ approved: true, authorizes: true });

    const claim = await fixture();
    const result = await service.submit(claim.command());

    expect(result.disposal).toBeDefined();
    // 32 random bytes, base64url encoded.
    expect(result.disposal!.token).toHaveLength(43);
    expect(result.disposal!.resumePath).toBe(
      `/recalls/${campaignSlug}/disposal/${result.disposal!.taskId}`,
    );

    const [task] = await handle!.db
      .select()
      .from(disposalTasks)
      .where(eq(disposalTasks.id, result.disposal!.taskId));
    // Bound to the draft, and nothing is confirmed yet.
    expect(task?.draftId).toBe(claim.draftId);
    expect(task?.eligibilityStatus).toBe('pending_confirmation');

    const detail = await disposal.getTaskForVisitor(
      result.disposal!.taskId,
      result.disposal!.token,
    );
    expect(detail).not.toBeNull();
    expect(detail!.products.length).toBeGreaterThan(0);

    await handle!.db.delete(disposalTasks).where(eq(disposalTasks.id, result.disposal!.taskId));
    await cleanupClaimFixture(handle!, claim);
  });

  // D25 at the submission boundary: content exists and is even approved, but
  // the only material behind it selects a measure that is not consumer disposal.
  it('opens no task when the approval does not authorize consumer disposal', async () => {
    await demoteApprovedVersions();
    await instructionVersion({ approved: true, authorizes: false });

    const claim = await fixture();
    const result = await service.submit(claim.command());
    expect(result.disposal).toBeUndefined();
    await cleanupClaimFixture(handle!, claim);
  });

  it('never opens two tasks for the same draft and instruction version', async () => {
    await demoteApprovedVersions();
    await instructionVersion({ approved: true, authorizes: true });

    const claim = await fixture();
    const first = await service.submit(claim.command());
    expect(first.disposal).toBeDefined();

    // A second submission of the same draft is refused before the disposal
    // step, which is what keeps the partial unique index a backstop rather
    // than a routine failure.
    await expect(service.submit(claim.command())).rejects.toThrow();

    const tasks = await handle!.db
      .select({ id: disposalTasks.id })
      .from(disposalTasks)
      .where(eq(disposalTasks.draftId, claim.draftId));
    expect(tasks).toHaveLength(1);

    await handle!.db.delete(disposalTasks).where(eq(disposalTasks.id, first.disposal!.taskId));
    await cleanupClaimFixture(handle!, claim);
  });
});
