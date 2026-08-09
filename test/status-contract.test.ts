/**
 * `status --json` is a published contract, so its shape is pinned.
 *
 * It carries a `status_schema` integer, which is a promise that consumers can
 * pin against it — the same promise `report.json` makes. `report.json` has
 * `src/report/contract.test.ts` making it good; this surface shipped in 1.4.0
 * without an equivalent, so the promise was resting on nobody renaming a key by
 * accident.
 *
 * It matters more than it looks. **This is the surface an agent polls in a
 * loop**, and `docs/agents.md` tells it to. A renamed `state`, or a `running`
 * that quietly stops appearing, does not raise an error — it makes the poll
 * never terminate, or terminate immediately on a crawl that has not started.
 *
 * Exercised through the CLI rather than by calling a function, because the shape
 * is assembled at the point of output. A unit test over `CrawlStatus` would pass
 * while the thing a consumer actually reads had changed.
 *
 * ## What counts as breaking, and needs `CRAWL_STATUS_SCHEMA` bumped
 *
 *   - Removing or renaming any key below, or changing a value's type.
 *   - Changing what a `state` value means, or adding one consumers must handle.
 *
 * Adding a key is not breaking. Add it to the list so the addition is deliberate.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import { CRAWL_STATUS_SCHEMA } from '../src/store/crawl-lock.ts';

const run = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'src', 'cli.ts');

const BUMP = 'If deliberate, bump CRAWL_STATUS_SCHEMA and update docs/usage.md.';

/** A work directory holding one finished and one live-looking crawl. */
async function workRootWithStatuses(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'schemanator-status-'));
  await fs.mkdir(path.join(root, '.locks'), { recursive: true });

  const base = {
    status_schema: CRAWL_STATUS_SCHEMA,
    site_origin: 'https://example.com',
    // A pid that cannot exist, so `running` is false deterministically rather
    // than depending on what else is on the machine.
    pid: 0x7ffffff0,
    hostname: os.hostname(),
    detached: true,
    heartbeat_at: '2026-08-09T00:00:05.000Z',
    pages_fetched: 8,
    pages_total: 8,
    log_path: null,
    error: null,
  };

  await fs.writeFile(
    path.join(root, '.locks', 'done.example.json'),
    JSON.stringify({
      ...base,
      site_slug: 'done.example',
      state: 'finished',
      started_at: '2026-08-09T00:00:00.000Z',
      finished_at: '2026-08-09T00:00:05.000Z',
    }),
  );

  await fs.writeFile(
    path.join(root, '.locks', 'stalled.example.json'),
    JSON.stringify({
      ...base,
      site_slug: 'stalled.example',
      state: 'crawling',
      started_at: '2026-08-08T00:00:00.000Z',
      finished_at: null,
    }),
  );

  return root;
}

async function statusJson(root: string, args: string[] = []): Promise<Record<string, unknown>> {
  const { stdout } = await run(process.execPath, [CLI, 'status', ...args, '--work-dir', root, '--json']);
  return JSON.parse(stdout) as Record<string, unknown>;
}

test('the top-level shape is what consumers are promised', async () => {
  const root = await workRootWithStatuses();
  assert.deepEqual(Object.keys(await statusJson(root)).sort(), ['statuses', 'work_dir'], BUMP);
});

test('each status carries exactly its documented keys', async () => {
  const root = await workRootWithStatuses();
  const statuses = (await statusJson(root))['statuses'] as Record<string, unknown>[];

  assert.equal(statuses.length, 2);
  assert.deepEqual(Object.keys(statuses[0] ?? {}).sort(), [
    'detached', 'error', 'finished_at', 'heartbeat_age_ms', 'heartbeat_at', 'hostname',
    'log_path', 'pages_fetched', 'pages_total', 'pid', 'running', 'site_origin',
    'site_slug', 'started_at', 'state', 'status_schema',
  ], BUMP);
});

test('running is derived, not copied from state', async () => {
  // The field an agent leans on hardest, because it saves re-implementing the
  // liveness rules. A crawl whose process is gone is `state: "crawling"` and
  // `running: false`, and an agent trusting `state` alone polls forever.
  const root = await workRootWithStatuses();
  const statuses = (await statusJson(root))['statuses'] as Record<string, unknown>[];

  const stalled = statuses.find((entry) => entry['site_slug'] === 'stalled.example');
  assert.equal(stalled?.['state'], 'crawling');
  assert.equal(stalled?.['running'], false, 'a dead process must never report running');

  const finished = statuses.find((entry) => entry['site_slug'] === 'done.example');
  assert.equal(finished?.['state'], 'finished');
  assert.equal(finished?.['running'], false);
});

test('status_schema is the constant, and an integer', async () => {
  const root = await workRootWithStatuses();
  const statuses = (await statusJson(root))['statuses'] as Record<string, unknown>[];
  for (const entry of statuses) assert.equal(entry['status_schema'], CRAWL_STATUS_SCHEMA);
  assert.equal(Number.isInteger(CRAWL_STATUS_SCHEMA), true);
});

test('a site argument narrows to one, and an unknown site is empty rather than an error', async () => {
  const root = await workRootWithStatuses();

  const one = (await statusJson(root, ['done.example', '--site', 'done.example']))['statuses'];
  assert.equal((one as unknown[]).length, 1);

  // Empty rather than a failure: an agent polling a crawl that has not been
  // started yet must be able to tell "nothing here" from "the call broke".
  const none = (await statusJson(root, ['nope.example', '--site', 'nope.example']))['statuses'];
  assert.deepEqual(none, []);
});

test('the JSON surface is stable while the human one is explicitly not', async () => {
  // Both formats are built. Only this one is a contract, and the difference is
  // the whole reason docs/agents.md tells an agent to pass --json.
  const root = await workRootWithStatuses();
  const { stdout } = await run(process.execPath, [CLI, 'status', '--work-dir', root]);

  assert.match(stdout, /done\.example/);
  assert.match(stdout, /stalled/, 'the human format must name a dead crawl as stalled, not crawling');
});
