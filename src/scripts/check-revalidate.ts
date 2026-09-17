/**
 * Live check of the on-demand cache invalidation path. Drives the backend's
 * real invalidator adapter against a real running web app — no mocks — so it
 * exercises the same code the publish route uses.
 *
 * Local:
 *   BASE=http://localhost:3005 SECRET=local-selftest-secret pnpm revalidate:check
 *
 * Production — this is the check that proves the two secrets actually match,
 * which configuration alone cannot show, since Sensitive values are not
 * readable back:
 *   BASE=https://www.koiimprtinc.com SECRET=<web REVALIDATE_SECRET> pnpm revalidate:check
 *
 * SECRET is that web deployment's `REVALIDATE_SECRET`. It is stored Sensitive on
 * the web project, so read it from the Vercel dashboard (Project → Settings →
 * Environment Variables → reveal), not from `vercel env pull`, which returns it
 * blank by design.
 *
 * Cache-hit detection is self-calibrating rather than a fixed millisecond
 * threshold: it takes the fastest of several warm requests as the local floor,
 * so the same script works against localhost (~25ms) and against a remote
 * deployment where network latency dominates.
 */
import { WebRevalidateCacheInvalidator } from '../platform/cache-invalidation/web-revalidate.js';

const BASE = process.env.BASE ?? 'http://localhost:3005';
const SECRET = process.env.SECRET ?? '';
const SLUG = process.env.SLUG ?? 'music-lollipop-demo-2026';

const ENDPOINT = `${BASE}/api/revalidate`;
const PAGE = `${BASE}/recalls/${SLUG}`;

let failures = 0;
function check(label: string, ok: boolean, detail = ''): void {
  if (!ok) failures += 1;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
}

async function pageMs(): Promise<number> {
  const started = Date.now();
  const response = await fetch(PAGE);
  await response.text();
  return Date.now() - started;
}

/** Fastest of n samples — the floor a cache hit can achieve from here. */
async function fastestOf(samples: number): Promise<number> {
  const times: number[] = [];
  for (let i = 0; i < samples; i += 1) times.push(await pageMs());
  return Math.min(...times);
}

async function main(): Promise<void> {
  if (!SECRET) throw new Error('SECRET env var is required');

  console.log(`endpoint: ${ENDPOINT}`);
  console.log(`page    : ${PAGE}`);
  console.log('');

  const page = await fetch(PAGE);
  await page.text();
  console.log(`page status: ${page.status}`);
  if (page.status !== 200) {
    console.log('page is not serving 200 — cannot assess caching');
    process.exitCode = 1;
    return;
  }

  console.log('');
  console.log('1) establish the cache-hit floor');
  const floor = await fastestOf(5);
  const warm = await pageMs();
  console.log(`  fastest of 5 warm reads: ${floor}ms`);
  check('reads settle to a consistent floor', warm < floor * 3, `${warm}ms vs floor ${floor}ms`);

  console.log('');
  console.log('2) the configured secret is accepted');
  const invalidator = new WebRevalidateCacheInvalidator(ENDPOINT, SECRET);
  const result = await invalidator.invalidateCampaign(SLUG);
  check('adapter reports success', result.invalidated === true, JSON.stringify(result));
  if (!result.invalidated) {
    // A rejected secret means the two deployments hold different values. Every
    // remaining check depends on an accepted invalidation, so stop rather than
    // report a pile of misleading failures.
    console.log('');
    console.log('STOPPING: the secret was rejected, so the deployments disagree.');
    console.log('Set REVALIDATE_SECRET (web) and WEB_REVALIDATE_SECRET (backend) to the same value.');
    console.log(failures === 0 ? '' : `${failures} CHECK(S) FAILED`);
    process.exitCode = 1;
    return;
  }

  console.log('');
  console.log('3) the tagged read actually expired — next read refetches');
  const afterInvalidate = await pageMs();
  // A refetch has to reach the backend, which costs far more than the floor.
  check(
    'refetched rather than served stale',
    afterInvalidate > floor * 2.5,
    `${afterInvalidate}ms vs floor ${floor}ms`,
  );
  const rewarmed = await fastestOf(3);
  check('re-cached afterwards', rewarmed < floor * 2.5, `${rewarmed}ms`);

  console.log('');
  console.log('4) a wrong secret is refused');
  const wrong = new WebRevalidateCacheInvalidator(ENDPOINT, `${SECRET}-wrong`);
  const wrongResult = await wrong.invalidateCampaign(SLUG);
  check('adapter reports failure', wrongResult.invalidated === false, JSON.stringify(wrongResult));

  console.log('');
  console.log('5) a malformed slug is rejected');
  const bad = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { Authorization: `Bearer ${SECRET}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ slug: '../../etc/passwd' }),
  });
  check('rejected with 400', bad.status === 400, `status ${bad.status}`);

  console.log('');
  console.log(failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`);
  if (failures > 0) process.exitCode = 1;
}

await main();
