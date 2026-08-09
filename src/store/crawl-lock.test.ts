/**
 * The lock, and specifically the paths that only fail in production.
 *
 * A lock is easy to get right for the case where everything works and
 * catastrophic in the cases where it does not, so most of what follows is about
 * dead processes, other machines, and two callers arriving at once.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  acquireCrawlLock,
  adoptCrawlLock,
  CrawlInProgressError,
  holdsLock,
  liveness,
  readAllStatuses,
  readStatus,
  statusPath,
  type CrawlStatus,
} from './crawl-lock.ts';

let counter = 0;
async function workRoot(): Promise<string> {
  counter += 1;
  const root = path.join(os.tmpdir(), `schemanator-lock-${process.pid}-${counter}`);
  await fs.rm(root, { recursive: true, force: true });
  await fs.mkdir(root, { recursive: true });
  return root;
}

const acquire = (root: string, slug: string, extra: Record<string, unknown> = {}) =>
  acquireCrawlLock({ workRoot: root, siteSlug: slug, siteOrigin: `https://${slug}`, ...extra });

/** A pid that cannot exist. Linux caps at 2^22; this is comfortably past it. */
const DEAD_PID = 0x7ffffff0;

test('a lock is taken, recorded, and released as finished rather than deleted', async () => {
  const root = await workRoot();
  const lock = await acquire(root, 'a.example');

  const held = await readStatus(root, 'a.example');
  assert.equal(held?.state, 'crawling');
  assert.equal(held?.pid, process.pid);
  assert.equal(holdsLock(held as CrawlStatus), true);

  await lock.finish('finished', { pages_fetched: 12 });

  // Kept, not removed: `status` after a detached crawl must be able to say what
  // happened, and a missing file is indistinguishable from a crawl never run.
  const done = await readStatus(root, 'a.example');
  assert.equal(done?.state, 'finished');
  assert.equal(done?.pages_fetched, 12);
  assert.equal(done?.finished_at !== null, true);
  assert.equal(holdsLock(done as CrawlStatus), false);
});

test('a second crawl of the same site is refused', async () => {
  const root = await workRoot();
  await acquire(root, 'a.example');

  await assert.rejects(
    () => acquire(root, 'a.example'),
    (error: unknown) => {
      assert.equal(error instanceof CrawlInProgressError, true);
      assert.match((error as Error).message, /already running/);
      // The message has to be actionable, not merely correct.
      assert.match((error as Error).message, /schemanator status a\.example/);
      return true;
    },
  );
});

test('a crawl of a different site is refused by default', async () => {
  // Politeness, not correctness. The polite queue governs one process, so two
  // crawls of sites that share infrastructure defeat it.
  const root = await workRoot();
  await acquire(root, 'a.example');

  await assert.rejects(() => acquire(root, 'b.example'), CrawlInProgressError);
});

test('--allow-concurrent permits another site but never the same one', async () => {
  const root = await workRoot();
  await acquire(root, 'a.example');

  const other = await acquire(root, 'b.example', { allowConcurrent: true });
  assert.equal(other.path.endsWith('b.example.json'), true);

  // The same-site lock is correctness — two writers on one manifest — and is
  // never relaxed, whatever flags are passed.
  await assert.rejects(
    () => acquire(root, 'a.example', { allowConcurrent: true }),
    CrawlInProgressError,
  );
});

test('a lock held by a dead process on this machine is reclaimed automatically', async () => {
  const root = await workRoot();
  const lock = await acquire(root, 'a.example');
  await lock.update({ pid: DEAD_PID });

  const stale = await readStatus(root, 'a.example');
  assert.equal(liveness(stale as CrawlStatus), 'dead');
  assert.equal(holdsLock(stale as CrawlStatus), false);

  // No --force needed: the process is provably gone, so the lock is not real.
  const fresh = await acquire(root, 'a.example');
  assert.equal((await readStatus(root, 'a.example'))?.pid, process.pid);
  await fresh.finish('finished');
});

test('a lock from another machine blocks, and --force takes it', async () => {
  const root = await workRoot();
  const lock = await acquire(root, 'a.example');
  await lock.update({ hostname: 'some-other-host' });

  const foreign = await readStatus(root, 'a.example');
  // A pid from another machine means nothing here, so it is never assumed dead.
  assert.equal(liveness(foreign as CrawlStatus), 'unknown');
  assert.equal(holdsLock(foreign as CrawlStatus), true);

  await assert.rejects(
    () => acquire(root, 'a.example'),
    (error: unknown) => {
      assert.match((error as Error).message, /some-other-host/);
      assert.match((error as Error).message, /--force/);
      return true;
    },
  );

  const forced = await acquire(root, 'a.example', { force: true });
  assert.equal((await readStatus(root, 'a.example'))?.hostname, os.hostname());
  await forced.finish('finished');
});

test('a finished lock does not block the next crawl', async () => {
  const root = await workRoot();
  const first = await acquire(root, 'a.example');
  await first.finish('finished');

  const second = await acquire(root, 'a.example');
  assert.equal((await readStatus(root, 'a.example'))?.state, 'crawling');
  await second.finish('finished');
});

test('a failed crawl records why', async () => {
  const root = await workRoot();
  const lock = await acquire(root, 'a.example');
  await lock.finish('failed', { error: 'robots.txt was unreadable' });

  const status = await readStatus(root, 'a.example');
  assert.equal(status?.state, 'failed');
  assert.equal(status?.error, 'robots.txt was unreadable');
  assert.equal(holdsLock(status as CrawlStatus), false);
});

test('a detached child adopts its parent lock rather than taking a second', async () => {
  // The window this closes: if the child acquired its own, the parent would
  // have exited with nothing holding the lock, and a crawl started in that
  // instant would run alongside it.
  const root = await workRoot();
  const parent = await acquire(root, 'a.example', { detached: true });
  await parent.update({ pid: DEAD_PID });

  const child = await adoptCrawlLock(statusPath(root, 'a.example'));
  assert.notEqual(child, null);

  const adopted = await readStatus(root, 'a.example');
  assert.equal(adopted?.pid, process.pid, 'ownership should move to the adopting process');
  assert.equal(adopted?.state, 'crawling', 'adoption must not disturb the state');
  assert.equal(adopted?.detached, true);

  // Still one lock, not two.
  assert.equal((await readAllStatuses(root)).length, 1);
});

test('adopting a lock that has gone returns null rather than proceeding unlocked', async () => {
  const root = await workRoot();
  assert.equal(await adoptCrawlLock(statusPath(root, 'nothing.example')), null);
});

test('a torn or malformed status file reads as absent rather than throwing', async () => {
  // Runtime state, unlike anything under data/: a crash can legitimately leave
  // this half-written, and refusing to crawl over it turns a cosmetic problem
  // into a blocking one.
  const root = await workRoot();
  await fs.mkdir(path.join(root, '.locks'), { recursive: true });
  await fs.writeFile(statusPath(root, 'torn.example'), '{"site_slug": "torn.exa');

  assert.equal(await readStatus(root, 'torn.example'), null);
  assert.deepEqual(await readAllStatuses(root), []);

  // And it must not block a new crawl.
  const lock = await acquire(root, 'torn.example');
  await lock.finish('finished');
});

test('readAllStatuses lists every site, newest first', async () => {
  const root = await workRoot();

  // Timestamps are set explicitly. Two locks taken back to back land in the
  // same millisecond, so a test relying on wall-clock ordering asserts nothing
  // and fails whenever the machine is quick.
  const older = await acquire(root, 'a.example');
  await older.update({ started_at: '2026-08-01T00:00:00.000Z' });
  await older.finish('finished');

  const newer = await acquire(root, 'b.example');
  await newer.update({ started_at: '2026-08-02T00:00:00.000Z' });
  await newer.finish('finished');

  assert.deepEqual(
    (await readAllStatuses(root)).map((entry) => entry.site_slug),
    ['b.example', 'a.example'],
  );
});
