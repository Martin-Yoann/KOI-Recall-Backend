import type { OpenAPIHono } from '@hono/zod-openapi';
import type { Context } from 'hono';

import type { ApplicationRegistry } from '../composition.js';
import {
  getDisposalTaskRoute,
  listDisposalDocumentsRoute,
  recordDisposalDeclarationRoute,
  submitDisposalEvidenceRoute,
} from '../contracts/toc.js';
import type { AppEnv } from '../middleware/request-context.js';
import type { DisposalService } from '../modules/disposal/service.js';
import { NotImplementedServiceError, problemType } from '../shared/errors.js';
import { requireAuditService, requirePermission } from './admin-guard.js';
import { dependencyUnavailable, notFound } from './shared.js';

/**
 * Consumer-disposal routes.
 *
 * Two conventions meet here, matching the rest of the service:
 *
 *  - The consumer endpoints are documented (`app.openapi`) because they are part
 *    of the public contract. They authenticate with `X-Disposal-Token` — the only
 *    thing between a stranger and another person's private evidence photos — so
 *    an unknown task and a wrong token are an undifferentiated 404.
 *  - The admin endpoints are registered directly and guarded by permission, like
 *    every other `/admin/*` route; the admin surface is not published.
 *
 * The service is the sole authority on what is permitted. Nothing here decides
 * whether an authorization may be issued, and no route offers a way to force one.
 */

function requireDisposalService(registry: ApplicationRegistry): DisposalService {
  const service = registry.services.disposal;
  if (!service) throw new NotImplementedServiceError('Disposal');
  return service;
}

function disposalToken(context: Context<AppEnv>): string | null {
  const value = context.req.header('X-Disposal-Token');
  return value && value.length >= 32 ? value : null;
}

function validationError(context: Context<AppEnv>, detail: string) {
  return context.json(
    {
      type: problemType('validation-error'),
      title: 'Invalid Request',
      status: 422,
      detail,
      requestId: context.get('requestId'),
    },
    422,
    { 'Content-Type': 'application/problem+json' },
  );
}

async function bodyRecord(context: Context<AppEnv>): Promise<Record<string, unknown>> {
  try {
    const parsed = (await context.req.json()) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

const asString = (value: unknown): string | undefined =>
  typeof value === 'string' ? value : undefined;
const asNumber = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;

export function registerDisposalRoutes(app: OpenAPIHono<AppEnv>, registry: ApplicationRegistry) {
  // ---- consumer (published) ------------------------------------------------

  app.openapi(getDisposalTaskRoute, async (context) => {
    const { taskId } = context.req.valid('param');
    const token = disposalToken(context);
    if (!token) return notFound(context, 'Disposal task');

    let detail;
    try {
      detail = await requireDisposalService(registry).getTaskForVisitor(taskId, token);
    } catch {
      return dependencyUnavailable(context, 'Disposal task read');
    }
    // A missing task and a wrong token are indistinguishable on purpose.
    if (!detail) return notFound(context, 'Disposal task');

    const record = detail.task;
    return context.json(
      {
        taskId: record.id,
        status: record.status,
        eligibilityStatus: record.eligibilityStatus,
        // Computed by the policy, not here. `instruction` is null unless the
        // version is approved, in force, and backed by an approval that
        // authorizes consumer disposal — withholding is the feature.
        allowedActions: detail.snapshot.allowedActions,
        blockingReasons: detail.snapshot.blockingReasons,
        evidenceReviewStatus: record.latestBatchReviewStatus,
        authorizationStatus: record.authorizationStatus,
        holdActive: record.holdActive,
        version: record.version,
        products: detail.products.map((product) => ({
          campaignProductId: product.campaignProductId,
          quantity: product.quantity,
          confirmedAffected: product.confirmedAffected,
        })),
        instruction: detail.instruction,
        declarationTextVersion: record.declarationTextVersion,
        expiresAt: detail.expiresAt,
      },
      200,
    );
  });

  app.openapi(submitDisposalEvidenceRoute, async (context) => {
    const { taskId } = context.req.valid('param');
    const token = disposalToken(context);
    if (!token) return notFound(context, 'Disposal task');
    const idempotencyKey = context.req.header('Idempotency-Key');
    if (!idempotencyKey) {
      return validationError(context, 'An Idempotency-Key header is required.');
    }
    const { documents } = context.req.valid('json');

    const batch = await requireDisposalService(registry).submitEvidenceBatch({
      taskId,
      taskToken: token,
      idempotencyKey,
      documents: documents.map((document) => ({
        documentId: document.documentId,
        ...(document.campaignProductId ? { campaignProductId: document.campaignProductId } : {}),
        ...(document.quantityCovered ? { quantityCovered: document.quantityCovered } : {}),
      })),
      retentionUntil: null,
    });
    return context.json(batch, 201);
  });

  app.openapi(recordDisposalDeclarationRoute, async (context) => {
    const { taskId } = context.req.valid('param');
    const token = disposalToken(context);
    if (!token) return notFound(context, 'Disposal task');
    const body = context.req.valid('json');

    await requireDisposalService(registry).recordDeclaration({
      taskId,
      taskToken: token,
      declarationTextVersion: body.declarationTextVersion,
      ...(body.authorizationId ? { authorizationId: body.authorizationId } : {}),
      ...(body.exceptionType ? { exceptionType: body.exceptionType } : {}),
      ...(body.exceptionNote ? { exceptionNote: body.exceptionNote } : {}),
    });
    return context.body(null, 204);
  });

  app.openapi(listDisposalDocumentsRoute, async (context) => {
    const { taskId } = context.req.valid('param');
    const token = disposalToken(context);
    if (!token) return notFound(context, 'Disposal task');

    const documents = await requireDisposalService(registry).listEvidenceDocuments(taskId, token);
    return context.json({ documents }, 200);
  });

  // ---- admin: queue and review --------------------------------------------

  app.get('/admin/disposal-tasks', async (context) => {
    const guard = await requirePermission(context, registry, 'disposal.review');
    if (guard instanceof Response) return guard;
    const limitRaw = context.req.query('limit');
    const limit = limitRaw ? Number(limitRaw) : undefined;
    const tasks = await requireDisposalService(registry).listQueue(
      limit && Number.isFinite(limit) ? { limit } : {},
    );
    return context.json({ tasks, total: tasks.length }, 200);
  });

  app.get('/admin/disposal-tasks/:taskId', async (context) => {
    const guard = await requirePermission(context, registry, 'disposal.review');
    if (guard instanceof Response) return guard;
    const taskId = context.req.param('taskId');
    // Admin read: the visitor token is not held by staff, so eligibility, the
    // policy snapshot and the products are assembled from the same policy the
    // consumer surface uses.
    const detail = await requireDisposalService(registry).getTaskForAdmin(taskId);
    if (!detail) return notFound(context, 'Disposal task');
    return context.json(
      {
        task: {
          ...detail.task,
          policyState: undefined,
        },
        products: detail.products,
        allowedActions: detail.snapshot.allowedActions,
        blockingReasons: detail.snapshot.blockingReasons,
      },
      200,
    );
  });

  app.post('/admin/disposal-tasks/:taskId/products/:campaignProductId/confirm', async (context) => {
    const guard = await requirePermission(context, registry, 'disposal.review');
    if (guard instanceof Response) return guard;
    const taskId = context.req.param('taskId');
    const campaignProductId = context.req.param('campaignProductId');
    const body = await bodyRecord(context);
    const quantity = asNumber(body.quantity);
    if (!quantity || !Number.isInteger(quantity) || quantity < 1) {
      return validationError(context, 'quantity must be a positive integer.');
    }
    const audit = requireAuditService(registry);

    await requireDisposalService(registry).confirmProductAffected({
      taskId,
      campaignProductId,
      quantity,
    });
    await audit.record({
      actorUserId: guard.userId,
      actorRole: guard.role,
      action: 'disposal.product.confirm',
      resourceType: 'disposal',
      resourceId: taskId,
      outcome: 'success',
      metadata: { campaignProductId, quantity },
    });
    return context.body(null, 204);
  });

  app.post('/admin/disposal-tasks/:taskId/eligibility', async (context) => {
    const guard = await requirePermission(context, registry, 'disposal.review');
    if (guard instanceof Response) return guard;
    const taskId = context.req.param('taskId');
    const body = await bodyRecord(context);
    const eligibilityStatus = asString(body.eligibilityStatus);
    const note = asString(body.note)?.trim();
    const expectedVersion = asNumber(body.expectedVersion);

    const allowed = ['confirmed_eligible', 'not_applicable', 'ineligible'] as const;
    if (!eligibilityStatus || !allowed.includes(eligibilityStatus as (typeof allowed)[number])) {
      return validationError(context, `eligibilityStatus must be one of ${allowed.join(', ')}.`);
    }
    if (!note || note.length < 10) {
      return validationError(context, 'A note of at least 10 characters is required.');
    }
    if (!expectedVersion || !Number.isInteger(expectedVersion)) {
      return validationError(context, 'expectedVersion is required.');
    }
    const audit = requireAuditService(registry);

    await requireDisposalService(registry).confirmEligibility({
      taskId,
      eligibilityStatus: eligibilityStatus as (typeof allowed)[number],
      note,
      actorStaffUserId: guard.userId,
      expectedVersion,
    });
    await audit.record({
      actorUserId: guard.userId,
      actorRole: guard.role,
      action: 'disposal.eligibility.confirm',
      resourceType: 'disposal',
      resourceId: taskId,
      outcome: 'success',
      metadata: { eligibilityStatus, note },
    });
    return context.body(null, 204);
  });

  app.post('/admin/disposal-batches/:batchId/review', async (context) => {
    const guard = await requirePermission(context, registry, 'disposal.review');
    if (guard instanceof Response) return guard;
    const batchId = context.req.param('batchId');
    const body = await bodyRecord(context);
    const decision = asString(body.decision);
    const rationale = asString(body.rationale)?.trim();
    const reasonCode = asString(body.reasonCode);

    if (decision !== 'accepted' && decision !== 'needs_resubmission') {
      return validationError(context, 'decision must be accepted or needs_resubmission.');
    }
    if (!rationale || rationale.length < 10) {
      return validationError(context, 'A rationale of at least 10 characters is required.');
    }
    if (decision === 'needs_resubmission' && !reasonCode) {
      return validationError(
        context,
        'A resubmission request must give the consumer a reason code.',
      );
    }
    const audit = requireAuditService(registry);

    await requireDisposalService(registry).reviewBatch({
      batchId,
      decision,
      rationale,
      ...(reasonCode ? { reasonCode } : {}),
      actorStaffUserId: guard.userId,
      actorRole: guard.role,
    });
    await audit.record({
      actorUserId: guard.userId,
      actorRole: guard.role,
      action: 'disposal.batch.review',
      resourceType: 'disposal',
      resourceId: batchId,
      outcome: 'success',
      metadata: { decision, ...(reasonCode ? { reasonCode } : {}), rationale },
    });
    return context.body(null, 204);
  });

  app.post('/admin/disposal-tasks/:taskId/authorization', async (context) => {
    const guard = await requirePermission(context, registry, 'disposal.review');
    if (guard instanceof Response) return guard;
    const taskId = context.req.param('taskId');
    const audit = requireAuditService(registry);

    // No force option exists: the service re-reads state and refuses unless
    // every precondition holds at this moment.
    const issued = await requireDisposalService(registry).issueAuthorization({
      taskId,
      actorStaffUserId: guard.userId,
    });
    await audit.record({
      actorUserId: guard.userId,
      actorRole: guard.role,
      action: 'disposal.authorization.issue',
      resourceType: 'disposal',
      resourceId: taskId,
      outcome: 'success',
      metadata: { authorizationId: issued.authorizationId },
    });
    return context.json({ authorizationId: issued.authorizationId, status: 'active' }, 201);
  });

  // ---- admin: holds --------------------------------------------------------

  app.post('/admin/disposal-tasks/:taskId/hold', async (context) => {
    const guard = await requirePermission(context, registry, 'disposal.hold.manage');
    if (guard instanceof Response) return guard;
    const taskId = context.req.param('taskId');
    const body = await bodyRecord(context);
    const reason = asString(body.reason);
    const note = asString(body.note)?.trim();
    const allowed = ['incident_evidence_retention', 'compliance_investigation', 'other'] as const;
    if (!reason || !allowed.includes(reason as (typeof allowed)[number])) {
      return validationError(context, `reason must be one of ${allowed.join(', ')}.`);
    }
    if (!note || note.length < 10) {
      return validationError(context, 'A note of at least 10 characters is required.');
    }
    const audit = requireAuditService(registry);

    await requireDisposalService(registry).placeHold({
      taskId,
      reason: reason as (typeof allowed)[number],
      note,
      actorStaffUserId: guard.userId,
    });
    await audit.record({
      actorUserId: guard.userId,
      actorRole: guard.role,
      action: 'disposal.hold.place',
      resourceType: 'disposal',
      resourceId: taskId,
      outcome: 'success',
      metadata: { reason, note },
    });
    return context.body(null, 204);
  });

  app.post('/admin/disposal-tasks/:taskId/hold/release', async (context) => {
    const guard = await requirePermission(context, registry, 'disposal.hold.manage');
    if (guard instanceof Response) return guard;
    const taskId = context.req.param('taskId');
    const body = await bodyRecord(context);
    const note = asString(body.note)?.trim();
    if (!note || note.length < 10) {
      return validationError(context, 'A note of at least 10 characters is required.');
    }
    const audit = requireAuditService(registry);

    await requireDisposalService(registry).releaseHold({
      taskId,
      note,
      actorStaffUserId: guard.userId,
    });
    await audit.record({
      actorUserId: guard.userId,
      actorRole: guard.role,
      action: 'disposal.hold.release',
      resourceType: 'disposal',
      resourceId: taskId,
      outcome: 'success',
      metadata: { note },
    });
    return context.body(null, 204);
  });

  // ---- admin: content authoring -------------------------------------------

  app.get('/admin/disposal-instructions', async (context) => {
    const guard = await requirePermission(context, registry, 'disposal.instructions.publish');
    if (guard instanceof Response) return guard;
    const campaignVersionId = context.req.query('campaignVersionId');
    const versions =
      await requireDisposalService(registry).listInstructionVersions(campaignVersionId);
    return context.json({ versions }, 200);
  });

  app.post('/admin/disposal-instructions', async (context) => {
    const guard = await requirePermission(context, registry, 'disposal.instructions.publish');
    if (guard instanceof Response) return guard;
    const body = await bodyRecord(context);
    const audit = requireAuditService(registry);

    // Read each field with the typed reader: coercing an unknown with String()
    // would turn a malformed body into '[object Object]' and store it.
    const campaignVersionId = asString(body.campaignVersionId);
    const locale = asString(body.locale);
    const title = asString(body.title);
    const declarationTextVersion = asString(body.declarationTextVersion);
    if (!campaignVersionId || !title || !declarationTextVersion) {
      return validationError(
        context,
        'campaignVersionId, title and declarationTextVersion are required.',
      );
    }
    const steps = Array.isArray(body.steps) ? body.steps : [];
    const safetyWarnings = Array.isArray(body.safetyWarnings) ? body.safetyWarnings : [];
    if (steps.length === 0 || safetyWarnings.length === 0) {
      return validationError(
        context,
        'At least one instruction step and one safety warning are required.',
      );
    }
    const videoUrl = asString(body.videoUrl);

    const created = await requireDisposalService(registry).createInstructionVersion({
      campaignVersionId,
      locale: locale ?? 'en-US',
      title,
      steps: steps as never,
      referenceImages: (Array.isArray(body.referenceImages) ? body.referenceImages : []) as never,
      ...(videoUrl ? { videoUrl } : {}),
      safetyWarnings: safetyWarnings as never,
      recognitionRequirements: (Array.isArray(body.recognitionRequirements)
        ? body.recognitionRequirements
        : []) as never,
      declarationTextVersion,
    });
    await audit.record({
      actorUserId: guard.userId,
      actorRole: guard.role,
      action: 'disposal.instructions.create',
      resourceType: 'disposal_instruction',
      resourceId: created.instructionVersionId,
      outcome: 'success',
      metadata: { versionNumber: created.versionNumber, campaignVersionId: body.campaignVersionId },
    });
    return context.json(created, 201);
  });

  app.post('/admin/disposal-instructions/:versionId/approvals', async (context) => {
    const guard = await requirePermission(context, registry, 'disposal.instructions.publish');
    if (guard instanceof Response) return guard;
    const versionId = context.req.param('versionId');
    const body = await bodyRecord(context);
    const audit = requireAuditService(registry);

    const recorded = await requireDisposalService(registry).recordInstructionApproval({
      instructionVersionId: versionId,
      materialType: body.materialType as never,
      scope: body.scope as never,
      measure: body.measure as never,
      ...(asString(body.referenceText) ? { referenceText: asString(body.referenceText) } : {}),
      ...(asString(body.effectiveFrom)
        ? { effectiveFrom: new Date(asString(body.effectiveFrom) as string) }
        : {}),
      ...(asString(body.effectiveUntil)
        ? { effectiveUntil: new Date(asString(body.effectiveUntil) as string) }
        : {}),
      actorStaffUserId: guard.userId,
    });
    await audit.record({
      actorUserId: guard.userId,
      actorRole: guard.role,
      action: 'disposal.instructions.approval.record',
      resourceType: 'disposal_instruction',
      resourceId: versionId,
      outcome: 'success',
      // The computed result belongs in the trail: it is what shows that a
      // non-authorizing material was recorded as exactly that.
      metadata: {
        materialType: body.materialType,
        scope: body.scope,
        measure: body.measure,
        authorizesConsumerDisposal: recorded.authorizesConsumerDisposal,
      },
    });
    return context.json(
      {
        approvalId: recorded.approvalId,
        authorizesConsumerDisposal: recorded.authorizesConsumerDisposal,
      },
      201,
    );
  });

  app.post('/admin/disposal-instructions/:versionId/publish', async (context) => {
    const guard = await requirePermission(context, registry, 'disposal.instructions.publish');
    if (guard instanceof Response) return guard;
    const versionId = context.req.param('versionId');
    const audit = requireAuditService(registry);

    await requireDisposalService(registry).publishInstructionVersion({
      instructionVersionId: versionId,
      actorStaffUserId: guard.userId,
    });
    await audit.record({
      actorUserId: guard.userId,
      actorRole: guard.role,
      action: 'disposal.instructions.publish',
      resourceType: 'disposal_instruction',
      resourceId: versionId,
      outcome: 'success',
    });
    return context.body(null, 204);
  });

  app.post('/admin/disposal-instructions/:versionId/withdraw', async (context) => {
    const guard = await requirePermission(context, registry, 'disposal.instructions.publish');
    if (guard instanceof Response) return guard;
    const versionId = context.req.param('versionId');
    const body = await bodyRecord(context);
    const reason = asString(body.reason)?.trim();
    if (!reason || reason.length < 10) {
      return validationError(context, 'A withdrawal reason of at least 10 characters is required.');
    }
    const audit = requireAuditService(registry);

    const suspended = await requireDisposalService(registry).withdrawInstruction({
      instructionVersionId: versionId,
      reason,
      actorStaffUserId: guard.userId,
    });
    await audit.record({
      actorUserId: guard.userId,
      actorRole: guard.role,
      action: 'disposal.instructions.withdraw',
      resourceType: 'disposal_instruction',
      resourceId: versionId,
      outcome: 'success',
      metadata: { reason, suspendedAuthorizations: suspended },
    });
    return context.json({ suspendedAuthorizations: suspended }, 200);
  });
}
