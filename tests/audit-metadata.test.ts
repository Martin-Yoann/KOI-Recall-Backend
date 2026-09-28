import { describe, expect, it } from 'vitest';

import {
  AUDIT_METADATA_KEYS,
  AUDIT_METADATA_VALUE_MAX_CHARS,
  AUDIT_METADATA_WITHHELD,
  sanitizeAuditMetadata,
} from '../src/modules/staff/audit-metadata.js';
import type { AuditEventInput } from '../src/modules/staff/audit-service.js';
import { DrizzleAuditService } from '../src/modules/staff/drizzle-audit-service.js';
import type { DatabaseExecutor } from '../src/db/client.js';

describe('sanitizeAuditMetadata', () => {
  it('passes identifiers, enums, counts and hashes through unchanged', () => {
    const metadata = {
      nextStatus: 'closed',
      forced: true,
      rowCount: 12,
      reason: 'consumer_request',
      fileSha256: 'a'.repeat(64),
      retentionDays: null,
      fields: ['firstName', 'email', 'incident.narrative'],
    };

    expect(sanitizeAuditMetadata(metadata)).toEqual(metadata);
  });

  // Note what this does *not* claim: the cap is not a prose filter. A short sentence —
  // "Refund issued after counsel confirmed it." — is well under the cap and passes.
  // Prose is kept out by not writing it (see the seven call sites that used to), and
  // the cap only stops a value that is plainly not a value — a paragraph, a dump.
  it('replaces an over-long value with a marker instead of storing it', () => {
    const sentence = `Refund issued after counsel confirmed the replacement had arrived. ${'Context: '.repeat(30)}`;
    expect(sentence.length).toBeGreaterThan(AUDIT_METADATA_VALUE_MAX_CHARS);

    const sanitized = sanitizeAuditMetadata({
      assertedReviewerId: sentence,
      nextStatus: 'closed',
    });

    // The marker, not the text: an auditor sees that something was withheld rather
    // than reading a row that looks complete.
    expect(sanitized.assertedReviewerId).toBe(AUDIT_METADATA_WITHHELD);
    expect(JSON.stringify(sanitized)).not.toContain('counsel');
    expect(sanitized.nextStatus).toBe('closed');
  });

  it('caps each entry of an array, not just the array', () => {
    const long = 'x'.repeat(AUDIT_METADATA_VALUE_MAX_CHARS + 1);
    expect(sanitizeAuditMetadata({ fields: ['email', long] })).toEqual({
      fields: ['email', AUDIT_METADATA_WITHHELD],
    });
  });

  it('drops explicit undefineds and tolerates no metadata at all', () => {
    expect(sanitizeAuditMetadata({ a: undefined, b: 1 })).toEqual({ b: 1 });
    expect(sanitizeAuditMetadata(undefined)).toEqual({});
  });
});

describe('the audit write path uses the sanitizer', () => {
  it('stores the capped form, not what the caller passed', async () => {
    const rows: Record<string, unknown>[] = [];
    const db = {
      insert: () => ({
        values: (row: Record<string, unknown>) => {
          rows.push(row);
          return Promise.resolve();
        },
      }),
    } as unknown as DatabaseExecutor;
    const service = new DrizzleAuditService(db);

    await service.record({
      actorUserId: null,
      actorRole: null,
      action: 'case.transition',
      outcome: 'success',
      metadata: {
        nextStatus: 'closed',
        assertedReviewerId: `Something nobody should be reading from a shared table. ${'More. '.repeat(40)}`,
      },
    });

    expect(rows).toHaveLength(1);
    const stored = rows[0]!.metadata as Record<string, unknown>;
    expect(stored.nextStatus).toBe('closed');
    expect(stored.assertedReviewerId).toBe(AUDIT_METADATA_WITHHELD);
  });
});

describe('the key whitelist is enforced by the type system', () => {
  it('refuses a key it does not name', () => {
    // The suppression *is* the assertion. If the whitelist is ever widened back to
    // `Record<string, unknown>` — or `note` is quietly added — this line stops being an
    // error and the compiler reports an unused suppression, so the test fails instead of
    // quietly passing.
    const input: AuditEventInput = {
      actorUserId: null,
      actorRole: null,
      action: 'case.status.transition',
      outcome: 'success',
      // @ts-expect-error `note` is not a key the audit trail may carry.
      metadata: { note: 'Operator prose belongs on the record it describes.' },
    };

    expect(input.metadata).toBeDefined();
  });

  it('names every key once, in a scannable order', () => {
    expect(new Set(AUDIT_METADATA_KEYS).size).toBe(AUDIT_METADATA_KEYS.length);
    expect([...AUDIT_METADATA_KEYS]).toEqual([...AUDIT_METADATA_KEYS].sort());
  });
});
