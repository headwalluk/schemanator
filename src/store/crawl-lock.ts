/**
 * The crawl lock, which is also the status file. One artefact, two jobs.
 *
 * A crawl writes its progress here on an interval, and that same write is the
 * proof it is still alive. Keeping them separate would mean a lockfile that can
 * disagree with reality — held by a process that died an hour ago, with no way
 * to tell that from one merely being slow.
 *
 * ## Why the policy is global and the storage is per-site
 *
 * Files live at `<work-root>/.locks/<slug>.json`, one per site, because
 * `--allow-concurrent` permits several and `status` has to list them all. But
 * the default *policy* is one crawl at a time across the whole work directory,
 * and that is the decision worth explaining, because per-site looks sufficient
 * and is not:
 *
 * 1. **Correctness.** Two processes appending to one site's `pages.jsonl` and
 *    manifest corrupts both. Per-site covers this, and this lock is never
 *    relaxed — `--allow-concurrent` does not reach it.
 * 2. **Politeness, which per-site does not cover.** `02`'s polite queue is *per
 *    process*. `tools/crawl-batch.sh` already serialises every crawl for exactly
 *    this reason and says so in its header. We are a host, so client sites share
 *    infrastructure: five detached crawls of five different sites can put five
 *    requests in flight against one network. `02` says every default errs slow,
 *    so the default is one crawl, full stop.
 *
 * `--allow-concurrent` relaxes only the second. Whoever passes it has asserted
 * that the targets are on unrelated infrastructure, and owns that claim.
 *
 * ## Stale locks are what kill designs like this
 *
 * A machine reboots mid-crawl and the site is un-crawlable forever, with no
 * message explaining why. The rules in {@link liveness} exist so that never
 * happens, and so the opposite never happens either — stealing the lock of a
 * crawl that is merely blocked on a slow response is how two crawls end up
 * racing, which is the thing this module exists to prevent.
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

import { SILENT_LOGGER, type Logger } from '../log.ts';

/** Bumps if the on-disk shape changes incompatibly. Read by `status`. */
export const CRAWL_STATUS_SCHEMA = 1;

/** How often a running crawl refreshes `heartbeat_at`. */
export const HEARTBEAT_MS = 10_000;

export type CrawlState = 'crawling' | 'finished' | 'failed';

export interface CrawlStatus {
  status_schema: number;
  site_slug: string;
  site_origin: string;
  state: CrawlState;
  /** The process that owns this crawl. Meaningful only alongside `hostname`. */
  pid: number;
  hostname: string;
  /** Set when the crawl was started with `--detach`. */
  detached: boolean;
  started_at: string;
  heartbeat_at: string;
  finished_at: string | null;
  pages_fetched: number;
  pages_total: number;
  /** Where a detached crawl's output went. Null for a foreground run. */
  log_path: string | null;
  /** Populated when `state` is `failed`. */
  error: string | null;
}

/**
 * Can we tell whether the owning process still exists?
 *
 * - `live` — it does, so the lock is real.
 * - `dead` — it definitively does not, so the lock is reclaimable.
 * - `unknown` — the lock was taken on another machine, and a pid from there
 *   means nothing here. Never reclaimed automatically.
 */
export type Liveness = 'live' | 'dead' | 'unknown';

export function liveness(status: CrawlStatus): Liveness {
  if (status.hostname !== os.hostname()) return 'unknown';

  try {
    // Signal 0 checks for existence without delivering anything.
    process.kill(status.pid, 0);
    return 'live';
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // EPERM means the process exists and belongs to somebody else, which is
    // still alive. Only ESRCH proves absence.
    if (code === 'EPERM') return 'live';
    return 'dead';
  }
}

/**
 * Is this status actually holding the lock?
 *
 * **A stale heartbeat alone is never enough**, and that is deliberate: a crawl
 * blocked on a 30-second timeout, or paused by the OS, is alive and its lock is
 * real. Only a process we can prove is gone releases one.
 */
export function holdsLock(status: CrawlStatus): boolean {
  return status.state === 'crawling' && liveness(status) !== 'dead';
}

/** Seconds since the heartbeat. Reported by `status`; never used to decide. */
export function heartbeatAgeMs(status: CrawlStatus, now = Date.now()): number {
  return now - Date.parse(status.heartbeat_at);
}

export function locksDir(workRoot: string): string {
  return path.join(workRoot, '.locks');
}

export function statusPath(workRoot: string, siteSlug: string): string {
  return path.join(locksDir(workRoot), `${siteSlug}.json`);
}

function isCrawlStatus(value: unknown): value is CrawlStatus {
  if (value === null || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record['site_slug'] === 'string' &&
    typeof record['pid'] === 'number' &&
    typeof record['hostname'] === 'string' &&
    (record['state'] === 'crawling' || record['state'] === 'finished' || record['state'] === 'failed')
  );
}

/**
 * Read one status file. A malformed or unreadable file reads as absent.
 *
 * Deliberately lenient, unlike everything under `data/`: those are rules we
 * author and a typo must be loud, whereas this is runtime state that a crash
 * can legitimately leave half-written. Refusing to crawl because a status file
 * is torn would turn a cosmetic problem into a blocking one.
 */
export async function readStatus(workRoot: string, siteSlug: string): Promise<CrawlStatus | null> {
  try {
    const parsed: unknown = JSON.parse(await fs.readFile(statusPath(workRoot, siteSlug), 'utf8'));
    return isCrawlStatus(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** Every status file under the work root, newest crawl first. */
export async function readAllStatuses(workRoot: string): Promise<CrawlStatus[]> {
  let names: string[];
  try {
    names = await fs.readdir(locksDir(workRoot));
  } catch {
    return [];
  }

  const statuses = await Promise.all(
    names
      .filter((name) => name.endsWith('.json'))
      .map((name) => readStatus(workRoot, name.slice(0, -'.json'.length))),
  );

  return statuses
    .filter((status): status is CrawlStatus => status !== null)
    // Slug breaks the tie, because two crawls started in the same millisecond
    // are otherwise ordered by whatever `readdir` happened to return.
    .sort(
      (left, right) =>
        right.started_at.localeCompare(left.started_at) ||
        left.site_slug.localeCompare(right.site_slug),
    );
}

/**
 * A crawl is already running.
 *
 * Its own error class so `cli.ts` can map it to a distinct exit code: an agent
 * branches on "wait and retry" versus "this failed" without reading the message,
 * and conflating the two makes it retry a genuine failure forever.
 */
export class CrawlInProgressError extends Error {
  readonly blocker: CrawlStatus;

  constructor(blocker: CrawlStatus, message: string) {
    super(message);
    this.name = 'CrawlInProgressError';
    this.blocker = blocker;
  }
}

function describeBlocker(blocker: CrawlStatus, now = Date.now()): string {
  const runningFor = Math.max(0, Math.round((now - Date.parse(blocker.started_at)) / 1000));
  const minutes = Math.floor(runningFor / 60);
  const elapsed = minutes > 0 ? `${minutes}m ${runningFor % 60}s` : `${runningFor}s`;
  const progress =
    blocker.pages_total > 0
      ? `${blocker.pages_fetched} of ${blocker.pages_total} pages`
      : `${blocker.pages_fetched} pages`;

  return `${blocker.site_slug} (pid ${blocker.pid}, running ${elapsed}, ${progress})`;
}

export interface CrawlLock {
  readonly path: string;
  /** Merge a patch into the status file and refresh the heartbeat. */
  update(patch: Partial<CrawlStatus>): Promise<void>;
  /** Record the outcome and stop the heartbeat. The file is kept, not deleted. */
  finish(state: Exclude<CrawlState, 'crawling'>, patch?: Partial<CrawlStatus>): Promise<void>;
}

export interface AcquireOptions {
  workRoot: string;
  siteSlug: string;
  siteOrigin: string;
  /** Whose liveness proves the lock. Defaults to this process. */
  pid?: number;
  detached?: boolean;
  logPath?: string | null;
  pagesTotal?: number;
  /** Permit a crawl of a *different* site to run alongside. Never relaxes the same-site lock. */
  allowConcurrent?: boolean;
  /** Reclaim a lock we cannot prove is dead. The operator is asserting it is. */
  force?: boolean;
  logger?: Logger;
}

/**
 * Take the lock, or throw {@link CrawlInProgressError} explaining who has it.
 *
 * The file is created with the `wx` flag, which is the only part of this that is
 * genuinely atomic — everything before it is advisory, and two processes racing
 * this closely will have exactly one win the `wx`.
 */
export async function acquireCrawlLock(options: AcquireOptions): Promise<CrawlLock> {
  const {
    workRoot,
    siteSlug,
    siteOrigin,
    pid = process.pid,
    detached = false,
    logPath = null,
    pagesTotal = 0,
    allowConcurrent = false,
    force = false,
    logger = SILENT_LOGGER,
  } = options;

  await fs.mkdir(locksDir(workRoot), { recursive: true });

  for (const existing of await readAllStatuses(workRoot)) {
    if (existing.state !== 'crawling') continue;

    const state = liveness(existing);

    if (state === 'dead') {
      // Provably gone, on this machine. Reclaiming is safe and saying so
      // matters: a silently-cleared lock looks like it was never taken.
      logger.info(
        `Reclaiming the lock left by a crawl of ${existing.site_slug} — pid ${existing.pid} is no longer running.`,
      );
      await fs.rm(statusPath(workRoot, existing.site_slug), { force: true });
      continue;
    }

    const sameSite = existing.site_slug === siteSlug;

    // Same site is a correctness lock and `--allow-concurrent` does not reach
    // it. A different site is a politeness lock, which it does.
    if (!sameSite && allowConcurrent) continue;
    if (force) {
      logger.warn(`--force: taking the lock held by ${describeBlocker(existing)}.`);
      await fs.rm(statusPath(workRoot, existing.site_slug), { force: true });
      continue;
    }

    // Neither reason repeats the detail line below it. The first draft did, and
    // printed the pid and progress twice in four lines.
    const reason = sameSite
      ? `A crawl of ${siteSlug} is already running.`
      : `A crawl of another site is already running, and only one runs at a time.`;

    const advice = sameSite
      ? 'Wait for it to finish, or stop it.'
      : 'One crawl runs at a time so the polite queue governs every request to a host — ' +
        'client sites often share infrastructure. Pass --allow-concurrent if you are certain ' +
        'these targets do not.';

    const unknownNote =
      state === 'unknown'
        ? `\n\nThe lock was taken on ${existing.hostname}, and this is ${os.hostname()}, so whether ` +
          `that process still exists cannot be checked from here. If you are certain it is gone, ` +
          `re-run with --force.`
        : '';

    throw new CrawlInProgressError(
      existing,
      `${reason}\n\n  ${describeBlocker(existing)}\n  status: schemanator status ${existing.site_slug}` +
        `${existing.log_path === null ? '' : `\n  log:    ${existing.log_path}`}` +
        `\n\n${advice}${unknownNote}`,
    );
  }

  const now = new Date().toISOString();
  const status: CrawlStatus = {
    status_schema: CRAWL_STATUS_SCHEMA,
    site_slug: siteSlug,
    site_origin: siteOrigin,
    state: 'crawling',
    pid,
    hostname: os.hostname(),
    detached,
    started_at: now,
    heartbeat_at: now,
    finished_at: null,
    pages_fetched: 0,
    pages_total: pagesTotal,
    log_path: logPath,
    error: null,
  };

  const target = statusPath(workRoot, siteSlug);

  // A finished run leaves its file behind so `status` can report the outcome,
  // and a crash can leave a torn one. Clear either, so the `wx` below is testing
  // for a live race and nothing else.
  //
  // **`null` has to clear too.** The first version only removed a file it could
  // parse, so a half-written status — which `readStatus` correctly reports as
  // absent — sailed past the blocker loop and then collided with `wx`, refusing
  // the crawl with "another crawl claimed the lock a moment ago" and no way
  // back. Anything still holding the lock has already thrown above.
  const previous = await readStatus(workRoot, siteSlug);
  if (previous === null || !holdsLock(previous)) await fs.rm(target, { force: true });

  try {
    await fs.writeFile(target, `${JSON.stringify(status, null, 2)}\n`, { flag: 'wx' });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const winner = await readStatus(workRoot, siteSlug);
    throw new CrawlInProgressError(
      winner ?? status,
      `Another crawl of ${siteSlug} claimed the lock a moment ago. Nothing was started.`,
    );
  }

  return makeLock(target, status);
}

/**
 * Take over a lock this process did not create.
 *
 * `--detach` needs this. The parent takes the lock *before* spawning, because a
 * child that acquired its own would leave a window in which the parent has
 * exited and nothing is holding it — a second `crawl` in that instant would
 * start a rival. But that means the child then finds a live lock and, quite
 * correctly, refuses to run.
 *
 * So the parent passes the lock's path down through the environment and the
 * child adopts it, replacing the recorded pid with its own. Ownership moves in
 * one step, and at no point is the file unheld.
 *
 * Returns `null` if the file has gone or is unreadable, which the caller must
 * treat as "acquire normally" rather than "proceed unlocked".
 */
export async function adoptCrawlLock(target: string, pid = process.pid): Promise<CrawlLock | null> {
  let status: CrawlStatus;
  try {
    const parsed: unknown = JSON.parse(await fs.readFile(target, 'utf8'));
    if (!isCrawlStatus(parsed)) return null;
    status = parsed;
  } catch {
    return null;
  }

  const adopted: CrawlStatus = { ...status, pid, hostname: os.hostname() };
  const lock = makeLock(target, adopted);
  await lock.update({});
  return lock;
}

/** The shared write-and-heartbeat machinery behind both entry points. */
function makeLock(target: string, initial: CrawlStatus): CrawlLock {
  let current = initial;
  let stopped = false;

  const write = async (): Promise<void> => {
    if (stopped) return;
    try {
      await fs.writeFile(target, `${JSON.stringify(current, null, 2)}\n`);
    } catch {
      // A status write failing must never take the crawl down with it. The
      // crawl is the valuable thing; this file is how you watch it.
    }
  };

  // `unref` so a finished crawl is not held open by its own heartbeat.
  const timer = setInterval(() => {
    current = { ...current, heartbeat_at: new Date().toISOString() };
    void write();
  }, HEARTBEAT_MS);
  timer.unref();

  return {
    path: target,
    async update(patch) {
      current = { ...current, ...patch, heartbeat_at: new Date().toISOString() };
      await write();
    },
    async finish(state, patch = {}) {
      const finishedAt = new Date().toISOString();
      current = { ...current, ...patch, state, finished_at: finishedAt, heartbeat_at: finishedAt };
      await write();
      stopped = true;
      clearInterval(timer);
    },
  };
}
