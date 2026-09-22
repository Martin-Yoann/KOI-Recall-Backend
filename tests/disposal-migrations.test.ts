// D22, the half that had nothing behind it: the disposal feature must be purely
// additive, so no row that already existed can have been reclassified by it.
// That is a property of the migrations, and the schema cannot express it — the
// only way a test can notice is to read them.
//
// Scope is a migration number, not a text search for "disposal": a migration
// that rewrote rows without ever naming the feature is exactly the failure this
// has to catch, and a `/disposal/` filter would skip straight past it. Two
// earlier migrations do rewrite rows — `0002` for `staff_users`, `0013` for
// `admin_audit_events` and `document_uploads` — which is why the check starts at
// the feature rather than at the beginning of the history.
//
// The retention half of D22 ("reviewed evidence is not reaped") is covered
// separately by tests/draft-cleanup-worker.integration.test.ts. What this file
// does not cover: it reads the migrations in the repository, not the history
// applied to any particular database, so a hand-run statement is invisible here.
import { readFile, readdir } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

/** `0017_curvy_nehzno.sql` is the first migration of the disposal feature. */
const FIRST_DISPOSAL_MIGRATION = 17;

interface Migration {
  file: string;
  sql: string;
  statements: string[];
}

function isDisposalTable(name: string): boolean {
  return name.startsWith('disposal_');
}

/** The feature's migrations, split into statements, in file-name order. */
async function featureMigrations(): Promise<Migration[]> {
  const files = (await readdir('drizzle')).filter((file) => file.endsWith('.sql'));
  const selected = files
    .map((file) => ({ file, number: Number.parseInt(file.slice(0, 4), 10) }))
    .filter(({ number }) => Number.isFinite(number) && number >= FIRST_DISPOSAL_MIGRATION)
    .sort((left, right) => left.file.localeCompare(right.file));

  const loaded = await Promise.all(
    selected.map(async ({ file }) => ({ file, sql: await readFile(`drizzle/${file}`, 'utf8') })),
  );
  return loaded.map(({ file, sql }) => ({
    file,
    sql,
    statements: sql
      .split('--> statement-breakpoint')
      .map((statement) => statement.trim())
      .filter(Boolean),
  }));
}

describe('disposal migrations are additive (D22)', () => {
  it('finds the migrations it is meant to check', async () => {
    // Guards the guard: assertions over an empty list pass by examining nothing.
    const migrations = await featureMigrations();
    expect(migrations.length).toBeGreaterThanOrEqual(4);
    expect(migrations.map((migration) => migration.file)).toEqual(
      expect.arrayContaining([expect.stringMatching(/^0017_/)]),
    );
  });

  it('never rewrites rows that already existed', async () => {
    for (const { file, statements } of await featureMigrations()) {
      const writes = statements.filter((statement) => /^UPDATE\s+"/i.test(statement));
      expect({ file, writes }).toEqual({ file, writes: [] });
    }
  });

  it('never alters a column that already existed', async () => {
    // A `SET DEFAULT` or a type change reinterprets the values already stored;
    // adding a table or a column does not.
    for (const { file, statements } of await featureMigrations()) {
      const altered = statements.filter((statement) =>
        /^ALTER TABLE[\s\S]*ALTER COLUMN/i.test(statement),
      );
      expect({ file, altered }).toEqual({ file, altered: [] });
    }
  });

  it('adds no defaulted column to a table that predates the feature', async () => {
    // A column added with a DEFAULT is written into every existing row, which is
    // silent classification however harmless the value looks.
    for (const { file, statements } of await featureMigrations()) {
      const offenders = statements.filter((statement) => {
        if (!/^ALTER TABLE\s+"/i.test(statement) || !/ADD COLUMN/i.test(statement)) return false;
        const target = /^ALTER TABLE\s+"([^"]+)"/i.exec(statement)?.[1] ?? '';
        if (isDisposalTable(target)) return false;
        return /DEFAULT/i.test(statement);
      });
      expect({ file, offenders }).toEqual({ file, offenders: [] });
    }
  });

  it('extends the evidence category enum by adding a value, never by renaming one', async () => {
    // A RENAME VALUE would reclassify every existing row still holding the old
    // name; ADD VALUE leaves them exactly as they were.
    const combined = (await featureMigrations()).map(({ sql }) => sql).join('\n');
    expect(combined).toContain(
      `ALTER TYPE "public"."evidence_category" ADD VALUE 'disposal_evidence'`,
    );
    expect(combined).not.toMatch(/ALTER TYPE[^;]*RENAME VALUE/i);
  });
});
