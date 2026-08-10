/**
 * Capacity benchmark for the Phase 1 order-index read path (T7b/O9).
 *
 * Generates ~1.3M synthetic order-index rows, measures import time, then
 * measures P95/P99 lookup latency against the identifier index and reports
 * index size. Run manually against a scratch database:
 *
 *   DATABASE_URL=postgresql://... pnpm tsx scripts/capacity-benchmark.ts
 *
 * It writes to a dedicated `order_index_benchmark` table and cleans up after
 * itself. Not part of CI; the results are recorded for the capacity gate.
 */
import 'dotenv/config';

import { sql } from 'drizzle-orm';

import { createDatabase } from '../src/db/client.js';

const TARGET_ROWS = 1_300_000;
const BATCH = 10_000;

function normalizeOrderNumber(value: string): string {
  return value.trim().toUpperCase();
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[index]!;
}

async function benchmark(): Promise<void> {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required.');
  const handle = createDatabase(process.env.DATABASE_URL);
  const { db } = handle;

  try {
    console.log(`[benchmark] target rows: ${TARGET_ROWS}`);
    await db.execute(sql`
      create table if not exists order_index_benchmark (
        id bigint generated always as identity primary key,
        order_number varchar(120) not null,
        normalized_order_number varchar(120) not null,
        case_id uuid not null,
        purchased_at timestamptz not null,
        amount_minor integer not null,
        currency varchar(3) not null default 'USD'
      )
    `);
    await db.execute(sql`
      create index if not exists order_index_benchmark_lookup_idx
        on order_index_benchmark (normalized_order_number)
    `);
    await db.execute(sql`truncate order_index_benchmark`);

    // --- Import ---
    const importStart = Date.now();
    for (let offset = 0; offset < TARGET_ROWS; offset += BATCH) {
      const rows: string[] = [];
      for (let i = 0; i < BATCH && offset + i < TARGET_ROWS; i += 1) {
        const orderNumber = `ORD-${String(offset + i).padStart(10, '0')}`;
        rows.push(
          `('${orderNumber}', '${normalizeOrderNumber(orderNumber)}', gen_random_uuid(), now(), ${1000 + ((offset + i) % 9000)}, 'USD')`,
        );
      }
      await db.execute(
        sql`insert into order_index_benchmark
          (order_number, normalized_order_number, case_id, purchased_at, amount_minor, currency)
          values ${sql.raw(rows.join(', '))}`,
      );
    }
    const importMs = Date.now() - importStart;
    console.log(
      `[benchmark] import: ${TARGET_ROWS} rows in ${importMs}ms (${Math.round((TARGET_ROWS / importMs) * 1000)} rows/s)`,
    );

    // --- P95/P99 lookup latency ---
    const probes = Array.from({ length: 100 }, () =>
      normalizeOrderNumber(
        `ORD-${String(Math.floor(Math.random() * TARGET_ROWS)).padStart(10, '0')}`,
      ),
    );
    const latencies: number[] = [];
    for (const probe of probes) {
      const start = performance.now();
      await db.execute(
        sql`select id from order_index_benchmark where normalized_order_number = ${probe}`,
      );
      latencies.push(performance.now() - start);
    }
    latencies.sort((a, b) => a - b);
    console.log(
      `[benchmark] lookup P50=${percentile(latencies, 50).toFixed(2)}ms P95=${percentile(latencies, 95).toFixed(2)}ms P99=${percentile(latencies, 99).toFixed(2)}ms`,
    );

    // --- Index size ---
    const sizeResult = await db.execute(sql`
      select pg_size_pretty(pg_relation_size('order_index_benchmark_lookup_idx')) as index_size,
             pg_size_pretty(pg_total_relation_size('order_index_benchmark')) as total_size
    `);
    const rows = Array.isArray(sizeResult) ? sizeResult : sizeResult.rows;
    console.log('[benchmark] index size:', rows?.[0]);

    // --- Cleanup ---
    await db.execute(sql`drop table if exists order_index_benchmark`);
    console.log('[benchmark] cleaned up benchmark table.');
  } finally {
    await handle.close();
  }
}

await benchmark();
