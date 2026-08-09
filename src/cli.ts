#!/usr/bin/env node
/**
 * schemanator CLI.
 *
 * Deliberately thin. Phase 0 is not a product — no config files, no plugin
 * system, no abstraction layers (`dev-notes/00`).
 */

import { parseArgs } from 'node:util';
import process from 'node:process';

import { CrawlAbortedError, runCrawl } from './crawl/run.ts';
import { runPipeline, type PipelineOptions } from './pipeline.ts';
import { runAnalysis, UnknownRunError } from './analyse.ts';
import { RobotsUnavailableError } from './crawl/robots.ts';
import { MIN_DELAY_MS, USER_AGENT } from './net/fetcher.ts';
import { createLogger, resolveLogLevel, LOG_LEVELS } from './log.ts';
import { defaultWorkRoot, DEFAULT_VERBOSE_ERRORS, MODE, VERSION } from './runtime.ts';
import { siteSlugFor } from './store/workdir.ts';
import { coerceToUrl, looksLikeTarget, UrlCanonicalisationError } from './url/canonical.ts';
import { UnresolvableContextError } from './extract/context.ts';
import { EXIT, type ExitCode } from './exit-codes.ts';
import { applyPurge, formatBytes, listSites, planPurge } from './store/inventory.ts';
import {
  acquireCrawlLock,
  adoptCrawlLock,
  CrawlInProgressError,
  heartbeatAgeMs,
  holdsLock,
  readAllStatuses,
  readStatus,
  type CrawlLock,
} from './store/crawl-lock.ts';
import { spawn } from 'node:child_process';
import fsSync from 'node:fs';
import pathModule from 'node:path';

/** Subcommands. Anything not in here, and not hostname-shaped, is an error. */
const KNOWN_COMMANDS = new Set(['scan', 'crawl', 'analyse', 'analyze', 'sites', 'purge', 'status']);

/** Commands that operate on the work directory rather than on one site. */
const WORKDIR_COMMANDS = new Set(['sites', 'status']);

const USAGE = `schemanator — whole-site structured-data integrity checking

Usage:
  schemanator <site> [options]          Crawl, extract, check and report.
  schemanator crawl <site> [options]    Crawl only, no analysis.
  schemanator analyse <site> [options]  Re-analyse a stored crawl. No network,
                                        so rule changes can be re-evaluated
                                        against real sites in seconds.
  schemanator sites                     List what has been crawled, and what it
                                        is costing on disk.
  schemanator purge <site> [--html]     Remove a crawl. Prints what it would
                                        remove; needs --yes to act.
  schemanator status [site]             Progress of a running or finished crawl.
                                        No site lists every one.

<site> may be a bare hostname — "example.com" is read as "https://example.com".

Options:
  --dry-run              Print the URL list and fetch no pages. Still fetches
                         robots.txt and the sitemaps — there is no other way to
                         produce the list.
  --sitemap <url>        Use this sitemap. Repeatable. Suppresses both the
                         robots.txt directives and well-known-path probing;
                         robots.txt is still obeyed for Disallow and Crawl-delay.
  --max-pages <n>        Cap the crawl. Default 500. The cap and what it dropped
                         are recorded in the run summary.
  --sample <how>         Which URLs survive the cap. Default "spread":
                         round-robin across the source sitemaps, so a site whose
                         sitemap index is partitioned by post type still gets its
                         pages audited and not just its 500 newest posts. Use
                         "document" for strict sitemap document order.
  --max-depth <n>        Sitemap index recursion depth. Default 3.
  --delay <ms>           Delay between requests to one host. Default 1000,
                         floor ${MIN_DELAY_MS}.
  --work-dir <path>      Where to write output. Defaults to ./work from a
                         checkout, or $XDG_STATE_HOME/schemanator when
                         installed. $SCHEMANATOR_WORK_DIR overrides.
  --site <slug>          Site key under the work directory. Default: the hostname.
  --resume               Continue from an existing frontier rather than starting over.
  --detach               Crawl in the background and return at once. Poll with
                         'schemanator status <site>'. Output goes to a log file
                         under the run directory, never discarded.
  --allow-concurrent     Permit a crawl while one is running for a DIFFERENT
                         site. One crawl at a time is the default because the
                         polite queue governs a single process, and sites often
                         share hosting. Never relaxes the same-site lock.
  --force                Take a lock held by a process whose liveness cannot be
                         checked - one taken on another machine. A dead lock on
                         this machine is reclaimed without it.
  --no-sort-query        Do not sort query parameters when canonicalising.
  --disable <check>      Disable a check or a whole group. Repeatable.
  --format <fmt>         md (default), json, or html. All three are written to
                         the run directory regardless; this picks what goes to
                         stdout.
  --json                 Alias for --format json.
  --since <run-id>       Diff this run against an earlier one and print the
                         diff instead of the report. "last" picks the most
                         recent previous run. Findings are matched by id, so a
                         half-fixed problem shows as Changed, not as one
                         resolved plus one new.
  --html                 purge only: remove stored HTML, keep reports and nodes.
  --yes                  purge only: actually delete. Without it, purge is a
                         dry run — re-crawling costs the site's bandwidth, not
                         just your time.
  --log-level <level>    ${LOG_LEVELS.join(' | ')}. Default info.
  --quiet                Alias for --log-level error.
  --verbose              Alias for --log-level debug.
  --help                 Show this message.
  --version              Print the version and exit.

Logs go to stderr; data goes to stdout. So this pipes cleanly:
  schemanator example.com --dry-run > urls.txt

Politeness is not optional. One request in flight per host, robots.txt fully
obeyed, and an unreadable robots.txt (5xx, timeout) refuses the crawl outright.

Environment:
  SCHEMANATOR_WORK_DIR   Default for --work-dir.
  SCHEMANATOR_CONTACT    Contact URL in the User-Agent. Set this before
                         crawling anything you do not own.
  SCHEMANATOR_ENV        development | installed. Normally detected.
  LOG_LEVEL              Default for --log-level.

User-Agent: ${USER_AGENT}
Mode:       ${MODE}
`;

async function main(argv: string[]): Promise<ExitCode> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      'dry-run': { type: 'boolean', default: false },
      sitemap: { type: 'string', multiple: true, default: [] },
      'max-pages': { type: 'string' },
      sample: { type: 'string' },
      'max-depth': { type: 'string' },
      delay: { type: 'string' },
      'work-dir': { type: 'string' },
      site: { type: 'string' },
      resume: { type: 'boolean', default: false },
      'no-sort-query': { type: 'boolean', default: false },
      disable: { type: 'string', multiple: true, default: [] },
      format: { type: 'string' },
      json: { type: 'boolean', default: false },
      since: { type: 'string' },
      'log-level': { type: 'string' },
      quiet: { type: 'boolean', default: false },
      verbose: { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
      version: { type: 'boolean', default: false },
      yes: { type: 'boolean', default: false },
      html: { type: 'boolean', default: false },
      detach: { type: 'boolean', default: false },
      'allow-concurrent': { type: 'boolean', default: false },
      force: { type: 'boolean', default: false },
    },
  });

  // Bare version, nothing else. Anything wrapping this — a CI job, a bug
  // report template, `npx <tool> --version` — wants one parseable line, not a
  // banner.
  if (values.version === true) {
    process.stdout.write(`${VERSION}\n`);
    return EXIT.OK;
  }

  if (values.help === true || positionals.length === 0) {
    process.stdout.write(USAGE);
    return values.help === true ? EXIT.OK : EXIT.FAILURE;
  }

  /**
   * `--format` is the surface; `--json` is kept as an alias for it.
   *
   * Removing `--json` would be a breaking change to a published CLI, and the
   * documented CI and fleet snippets all use it. It costs one line to keep, and
   * `--json` is the near-universal convention besides.
   *
   * If both are given, the explicit `--format` wins — someone who typed it meant
   * it, and silently preferring the alias would be surprising.
   */
  const format = values.format ?? (values.json === true ? 'json' : 'md');
  if (format !== 'md' && format !== 'json' && format !== 'html') {
    process.stderr.write(
      `unknown --format ${JSON.stringify(format)}. Expected md, json or html.\n`,
    );
    return EXIT.FAILURE;
  }

  // `schemanator example.com` and `schemanator crawl example.com` both work.
  // A bare word is a command; anything with a dot or a scheme is a target, so
  // `crawl` reads as the command and `crawl.com` as a site.
  const [first] = positionals;
  const isTarget = first !== undefined && looksLikeTarget(first);
  const command = isTarget ? 'scan' : first;
  const target = isTarget ? first : positionals[1];

  if (!KNOWN_COMMANDS.has(command ?? '')) {
    process.stderr.write(`unknown command ${JSON.stringify(command)}\n\n${USAGE}`);
    return EXIT.FAILURE;
  }
  // `sites` operates on the whole work directory, so it is the one command that
  // takes no target. Everything else is checked once the housekeeping commands
  // have had their turn, below.
  if (target === undefined && !WORKDIR_COMMANDS.has(command ?? '')) {
    process.stderr.write(`${command} needs a site\n\n${USAGE}`);
    return EXIT.FAILURE;
  }

  const numeric = (name: string, raw: string | undefined): number | undefined => {
    if (raw === undefined) return undefined;
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isFinite(parsed) || parsed <= 0)
      throw new Error(`--${name} must be a positive integer, got ${raw}`);
    return parsed;
  };

  const sample = values.sample;
  if (sample !== undefined && sample !== 'spread' && sample !== 'document') {
    throw new Error(`--sample must be "spread" or "document", got ${JSON.stringify(sample)}`);
  }

  // Aliases resolve to a level here so there is exactly one precedence chain.
  const levelFlag =
    values.quiet === true ? 'error' : values.verbose === true ? 'debug' : values['log-level'];
  const logger = createLogger(resolveLogLevel({ flag: levelFlag, env: process.env['LOG_LEVEL'] }));

  const workRoot = values['work-dir'] ?? defaultWorkRoot();

  // --- housekeeping ----------------------------------------------------------

  if (command === 'sites') {
    const sites = await listSites(workRoot);

    if (format === 'json') {
      process.stdout.write(`${JSON.stringify({ work_dir: workRoot, sites }, null, 2)}\n`);
      return EXIT.OK;
    }

    if (sites.length === 0) {
      process.stdout.write(`Nothing crawled yet under ${workRoot}\n`);
      return EXIT.OK;
    }

    const rows = sites.map((site) => ({
      slug: site.slug,
      pages: site.pages === null ? '—' : `${site.pages_ok ?? site.pages}/${site.pages}`,
      size: formatBytes(site.usage.total_bytes),
      html: site.html_purged ? 'purged' : formatBytes(site.usage.html_bytes),
      runs: String(site.runs),
      crawled: site.last_crawled === null ? '—' : (site.last_crawled.slice(0, 10) ?? '—'),
    }));

    const width = (key: keyof (typeof rows)[number], heading: string): number =>
      Math.max(heading.length, ...rows.map((row) => row[key].length));

    const columns = [
      { key: 'slug' as const, heading: 'SITE' },
      { key: 'pages' as const, heading: 'PAGES' },
      { key: 'size' as const, heading: 'SIZE' },
      { key: 'html' as const, heading: 'HTML' },
      { key: 'runs' as const, heading: 'RUNS' },
      { key: 'crawled' as const, heading: 'CRAWLED' },
    ].map((column) => ({ ...column, width: width(column.key, column.heading) }));

    const line = (cells: string[]): string =>
      cells
        .map((cell, index) => cell.padEnd(columns[index]?.width ?? 0))
        .join('  ')
        .trimEnd();

    process.stdout.write(`${line(columns.map((column) => column.heading))}\n`);
    for (const row of rows)
      process.stdout.write(`${line(columns.map((column) => row[column.key]))}\n`);

    const total = sites.reduce((sum, site) => sum + site.usage.total_bytes, 0);
    const html = sites.reduce((sum, site) => sum + site.usage.html_bytes, 0);
    process.stdout.write(
      `\n${sites.length} site(s), ${formatBytes(total)} total` +
        (html > 0 ? `, ${formatBytes(html)} of it reclaimable stored HTML` : '') +
        `\n${workRoot}\n`,
    );

    for (const site of sites) {
      for (const note of site.notes) logger.warn(`${site.slug}: ${note}`);
    }
    return EXIT.OK;
  }

  if (command === 'status') {
    // `status <site>` narrows to one; bare `status` lists everything, which is
    // what you want after a detached crawl you have lost track of.
    const wanted = target === undefined ? null : (values.site ?? siteSlugFor(coerceToUrl(target)));
    const all = await readAllStatuses(workRoot);
    const statuses = wanted === null ? all : all.filter((entry) => entry.site_slug === wanted);

    if (format === 'json') {
      process.stdout.write(
        `${JSON.stringify(
          {
            work_dir: workRoot,
            statuses: statuses.map((entry) => ({
              ...entry,
              running: holdsLock(entry),
              heartbeat_age_ms: heartbeatAgeMs(entry),
            })),
          },
          null,
          2,
        )}\n`,
      );
      return EXIT.OK;
    }

    if (statuses.length === 0) {
      process.stdout.write(
        wanted === null
          ? `No crawl has been started under ${workRoot}\n`
          : `No crawl recorded for ${wanted}\n`,
      );
      return EXIT.OK;
    }

    for (const entry of statuses) {
      const running = holdsLock(entry);
      // "crawling" from a dead process is the one state a reader must never be
      // shown as live — it is the stale lock, and naming it is how they know to
      // re-run rather than wait.
      const state = entry.state !== 'crawling' ? entry.state : running ? 'crawling' : 'stalled';
      const progress =
        entry.pages_total > 0
          ? `${entry.pages_fetched}/${entry.pages_total} pages`
          : `${entry.pages_fetched} pages`;

      process.stdout.write(`${entry.site_slug}\n`);
      process.stdout.write(`  state     ${state}${entry.detached ? ' (detached)' : ''}\n`);
      process.stdout.write(`  progress  ${progress}\n`);
      process.stdout.write(`  started   ${entry.started_at}\n`);
      if (entry.finished_at !== null) process.stdout.write(`  finished  ${entry.finished_at}\n`);
      if (entry.state === 'crawling') {
        process.stdout.write(
          `  heartbeat ${Math.round(heartbeatAgeMs(entry) / 1000)}s ago (pid ${entry.pid})\n`,
        );
      }
      if (entry.log_path !== null) process.stdout.write(`  log       ${entry.log_path}\n`);
      if (entry.error !== null) process.stdout.write(`  error     ${entry.error}\n`);

      if (state === 'stalled') {
        process.stdout.write(
          `\n  This crawl's process is gone. The lock will be reclaimed automatically by the\n` +
            `  next crawl; add --resume to continue from where it stopped.\n`,
        );
      }
      process.stdout.write('\n');
    }
    return EXIT.OK;
  }

  // Everything past here needs a target. `sites` and `status` have already
  // returned, so this both reports the error and narrows the type below.
  if (target === undefined) {
    process.stderr.write(`${command} needs a site\n\n${USAGE}`);
    return EXIT.FAILURE;
  }

  if (command === 'purge') {
    const slug = values.site ?? siteSlugFor(coerceToUrl(target));
    const scope = values.html === true ? 'html' : 'all';

    /**
     * Never delete a site out from under a running crawl.
     *
     * `purge` is dry by default because re-crawling costs the *site's*
     * bandwidth, an hour of it, one polite request at a time — and purging
     * mid-crawl throws away bandwidth already spent while the crawl is still
     * spending more. The crawl does notice (it fails, rather than corrupting
     * anything) but by then the damage is done and the operator has to go back
     * and take it again.
     *
     * Refused rather than warned, and `--yes` does not override it: `--yes`
     * means "I have read what this removes", which nobody has when the file
     * list is still being written.
     */
    const running = await readStatus(workRoot, slug);
    if (running !== null && holdsLock(running)) {
      process.stderr.write(
        `\n${slug} is being crawled right now (pid ${running.pid}, ` +
          `${running.pages_fetched} of ${running.pages_total} pages).\n\n` +
          `Nothing has been removed. Purging mid-crawl throws away bandwidth already\n` +
          `taken from the site, and the crawl would fail part-written.\n\n` +
          `  schemanator status ${slug}\n\nWait for it to finish, then purge.\n`,
      );
      return EXIT.CRAWL_IN_PROGRESS;
    }

    const plan = await planPurge(workRoot, slug, scope);

    if (plan.missing) {
      process.stderr.write(`nothing to purge: ${plan.root} does not exist\n`);
      return EXIT.FAILURE;
    }
    if (plan.files === 0) {
      process.stdout.write(
        scope === 'html'
          ? `${slug}: no stored HTML — already purged?\n`
          : `${slug}: nothing to remove\n`,
      );
      return EXIT.OK;
    }

    const what =
      scope === 'html'
        ? `${plan.files} stored page(s), ${formatBytes(plan.bytes)}, from ${slug}`
        : `all of ${slug} — ${plan.files} file(s), ${formatBytes(plan.bytes)}`;

    // Dry by default, and the reason is not generic caution. Re-crawling costs
    // somebody else's bandwidth, an hour of it, one polite request at a time.
    // An accidental purge is not merely your inconvenience.
    if (values.yes !== true) {
      process.stdout.write(`Would remove ${what}.\n`);
      if (scope === 'all') {
        process.stdout.write(
          `Reports and extracted nodes go too. Re-crawling means hitting the site again.\n`,
        );
      } else {
        process.stdout.write(
          `Reports and extracted nodes are kept, but re-analysis needs the HTML.\n`,
        );
      }
      process.stdout.write(`\nNothing has been deleted. Add --yes to go ahead.\n`);
      return EXIT.OK;
    }

    await applyPurge(plan);
    process.stdout.write(`Removed ${what}.\n`);
    return EXIT.OK;
  }

  const maxPages = numeric('max-pages', values['max-pages']);
  const maxDepth = numeric('max-depth', values['max-depth']);
  const delayMs = numeric('delay', values.delay);

  const shared: PipelineOptions = {
    startUrl: coerceToUrl(target),
    workRoot: values['work-dir'] ?? defaultWorkRoot(),
    ...(values.site === undefined ? {} : { siteSlug: values.site }),
    cliSitemaps: values.sitemap ?? [],
    ...(maxPages === undefined ? {} : { maxPages }),
    ...(sample === undefined ? {} : { sample }),
    ...(maxDepth === undefined ? {} : { maxDepth }),
    ...(delayMs === undefined ? {} : { delayMs }),
    dryRun: values['dry-run'] === true,
    resume: values.resume === true,
    sortQuery: values['no-sort-query'] !== true,
    logger,
  };

  if (command === 'analyse' || command === 'analyze') {
    const slug = values.site ?? siteSlugFor(coerceToUrl(target));

    // Warn, never block. An agent polling a detached crawl will do exactly this,
    // and a partial answer is honest — `coverage.complete` already says so. The
    // warning exists because "17 pages" reads like a finding about the site
    // rather than a snapshot of a crawl still running.
    const live = await readStatus(workRoot, slug);
    if (live !== null && holdsLock(live)) {
      logger.warn(
        `A crawl of ${slug} is still running (${live.pages_fetched} of ${live.pages_total} pages). ` +
          `This report covers only what has been stored so far.`,
      );
    }

    const result = await runAnalysis({
      workRoot: values['work-dir'] ?? defaultWorkRoot(),
      siteSlug: slug,
      logger,
      disabledChecks: values.disable ?? [],
      ...(values.since === undefined ? {} : { since: values.since }),
    });

    if (result.diff !== null) {
      // No HTML renderer for a diff yet, so `--format html` falls back to
      // markdown rather than pretending. Saying so beats emitting the wrong
      // document silently.
      if (format === 'html')
        logger.warn('--format html does not cover diffs yet; printing markdown.');
      process.stdout.write(
        format === 'json'
          ? `${JSON.stringify(result.diff, null, 2)}\n`
          : (result.diffMarkdown ?? ''),
      );
    } else {
      process.stdout.write(
        format === 'json'
          ? `${JSON.stringify(result.report, null, 2)}\n`
          : format === 'html'
            ? result.html
            : result.markdown,
      );
    }
    logger.info(`\nReport: ${result.reportDir}`);
    return EXIT.OK;
  }

  const slug = values.site ?? siteSlugFor(coerceToUrl(target));

  /**
   * A dry run takes no lock and cannot detach.
   *
   * It fetches `robots.txt` and the sitemaps and nothing else, so it neither
   * writes the work directory nor puts a meaningful load on the host — the two
   * things the lock exists to govern. Blocking it would make "what would this
   * crawl do?" unanswerable while a crawl is running, which is precisely when
   * somebody asks.
   */
  const wantsLock = values['dry-run'] !== true;

  if (values.detach === true && !wantsLock) {
    process.stderr.write('--detach has nothing to detach from under --dry-run.\n');
    return EXIT.FAILURE;
  }

  if (values.detach === true) {
    return await detachCrawl({ argv, workRoot, slug, origin: coerceToUrl(target), values, logger });
  }

  // A detached child is handed the lock its parent already took, so ownership
  // moves without the file ever being unheld. Falling back to acquiring covers
  // the case where the file has gone -- never proceeding unlocked.
  const inherited = process.env['SCHEMANATOR_LOCK_HELD'];
  const lock: CrawlLock | null = !wantsLock
    ? null
    : ((inherited === undefined ? null : await adoptCrawlLock(inherited)) ??
      (await acquireCrawlLock({
        workRoot,
        siteSlug: slug,
        siteOrigin: coerceToUrl(target),
        allowConcurrent: values['allow-concurrent'] === true,
        force: values.force === true,
        logger,
      })));

  // The lock must outlive every path out of the crawl, including a throw —
  // otherwise a failed crawl leaves a lock nothing will reclaim until the pid
  // happens to be checked.
  try {
    return await runCrawlCommand();
  } catch (error) {
    await lock?.finish('failed', { error: error instanceof Error ? error.message : String(error) });
    throw error;
  }

  async function runCrawlCommand(): Promise<ExitCode> {
    const progress: PipelineOptions['onProgress'] = (update) => {
      void lock?.update({ pages_fetched: update.fetched, pages_total: update.total });
    };

    // A dry run never analyses: there is nothing stored to analyse.
    if (command === 'scan' && values['dry-run'] !== true) {
      const result = await runPipeline({
        ...shared,
        onProgress: progress,
        disabledChecks: values.disable ?? [],
      });

      await lock?.finish('finished', {
        pages_fetched: result.crawl.fetched_this_run,
        ...(result.crawl.aborted === null ? {} : { error: result.crawl.aborted }),
      });

      // Report to stdout, logs to stderr, so this pipes into a pager, a file or
      // an agent without commentary corrupting the output.
      process.stdout.write(
        format === 'json'
          ? `${JSON.stringify(result.report, null, 2)}\n`
          : format === 'html'
            ? result.html
            : result.markdown,
      );
      logger.info(`\nReport: ${result.reportDir}`);
      return result.crawl.aborted !== null ? EXIT.CRAWL_ABORTED : EXIT.OK;
    }

    const summary = await runCrawl({ ...shared, onProgress: progress });

    if (summary.dry_run) {
      // The URL list is data. It goes to stdout regardless of log level, so
      // `--dry-run --quiet > urls.txt` yields a clean file.
      for (const url of summary.queued_urls ?? []) process.stdout.write(`${url}\n`);
      return EXIT.OK;
    }

    await lock?.finish('finished', {
      pages_fetched: summary.fetched_this_run,
      ...(summary.aborted === null ? {} : { error: summary.aborted }),
    });

    // Say what this run did, then what is stored. Conflating the two makes a
    // resumed crawl claim it fetched pages it did not touch.
    const requested = summary.fetched_this_run;
    logger.info(
      `\nDone. ${requested} page(s) requested this run` +
        (requested === 0 ? ' (everything was already stored)' : '') +
        `. ${summary.fetched} stored, ${summary.skipped} skipped, ${summary.failed} failed.`,
    );
    logger.info(`Output: ${summary.work_dir}`);

    if (summary.aborted !== null) return EXIT.CRAWL_ABORTED;
    return EXIT.OK;
  }
}

/**
 * Start a crawl in a detached child and return immediately.
 *
 * The lock is taken **here, in the parent, before the child exists**, and the
 * child's pid is written into it the moment `spawn` returns. Letting the child
 * take its own lock would leave a window — the parent has already exited, and a
 * second `crawl` invoked straight afterwards would find nothing holding it.
 *
 * Output goes to a log file rather than being discarded. A detached crawl that
 * fails silently is worse than one that fails loudly: the operator sees a
 * "started" message, waits, and finds an empty work directory with no
 * explanation anywhere.
 */
async function detachCrawl(context: {
  argv: string[];
  workRoot: string;
  slug: string;
  origin: string;
  values: Record<string, unknown>;
  logger: ReturnType<typeof createLogger>;
}): Promise<ExitCode> {
  const { argv, workRoot, slug, origin, values, logger } = context;

  const lock = await acquireCrawlLock({
    workRoot,
    siteSlug: slug,
    siteOrigin: origin,
    detached: true,
    // Filled in below. Until then the lock is held by *this* process, which is
    // alive, so the window is covered rather than merely short.
    pid: process.pid,
    allowConcurrent: values['allow-concurrent'] === true,
    force: values.force === true,
    logger,
  });

  const logDir = pathModule.join(workRoot, slug, 'crawl');
  fsSync.mkdirSync(logDir, { recursive: true });
  const logPath = pathModule.join(logDir, 'detached.log');
  const logFd = fsSync.openSync(logPath, 'a');

  // Same arguments minus --detach, so the child runs an ordinary foreground
  // crawl. It inherits nothing else: no stdin, and its own session.
  const childArgv = argv.filter((argument) => argument !== '--detach');

  const child = spawn(process.execPath, [process.argv[1] ?? '', ...childArgv], {
    detached: true,
    stdio: ['ignore', logFd, logFd],
    env: { ...process.env, SCHEMANATOR_LOCK_HELD: lock.path },
  });

  child.unref();
  fsSync.closeSync(logFd);

  if (child.pid === undefined) {
    await lock.finish('failed', { error: 'the detached process could not be started' });
    process.stderr.write('Could not start the detached crawl.\n');
    return EXIT.FAILURE;
  }

  await lock.update({ pid: child.pid, log_path: logPath });

  process.stdout.write(`Crawling ${slug} in the background (pid ${child.pid}).\n\n`);
  process.stdout.write(`  schemanator status ${slug}        progress\n`);
  process.stdout.write(`  ${logPath}\n\n`);
  process.stdout.write(`Poll status until state is no longer "crawling", then analyse.\n`);

  return EXIT.OK;
}

/**
 * A reader that stops reading is not an error.
 *
 * `schemanator example.com | less` and quitting before the end, or `| head -1`,
 * closes the pipe while we are still writing to it. Node's default response is
 * an unhandled `'error'` event and a stack trace, which is an unhelpful answer
 * to a command this tool's own documentation recommends.
 *
 * Whether it fires at all is a race between the reader exiting and the next
 * write, so it is intermittent — which makes it worse rather than better,
 * because it will surface once, for somebody else, at a bad moment.
 *
 * Exit quietly: the consumer got what it asked for. Anything that is *not*
 * EPIPE is still a real failure and still rethrown.
 */
process.stdout.on('error', (error: NodeJS.ErrnoException) => {
  if (error.code === 'EPIPE') process.exit(0);
  throw error;
});

/**
 * Which exit code each known failure earns.
 *
 * A table rather than the `if/else` ladder this replaced, for two reasons: a new
 * error class becomes one row instead of a branch somebody has to remember to
 * add in the right place, and `exit-codes.test.ts` can assert that **every**
 * exported `Error` subclass in `src/` appears here. A class missing from the
 * ladder used to fall silently into the catch-all, which is how
 * `UnresolvableContextError` came to have an exit code nobody had chosen.
 *
 * Order is significant: first match wins, so a subclass must precede its parent.
 * Nothing here subclasses anything but `Error` today.
 */
const EXIT_BY_ERROR: readonly [new (...args: never[]) => Error, ExitCode][] = [
  [CrawlInProgressError, EXIT.CRAWL_IN_PROGRESS],
  [RobotsUnavailableError, EXIT.ROBOTS_UNAVAILABLE],
  [CrawlAbortedError, EXIT.CRAWL_ABORTED],
  [UnknownRunError, EXIT.FAILURE],
  [UrlCanonicalisationError, EXIT.FAILURE],
  // Extraction catches this per block and records it on the page, where
  // `syntax.unresolvable-context` reports it — so it should never reach here.
  // Listed anyway, and deliberately: if it does escape, that is a bug in
  // extraction rather than a distinct outcome worth its own code.
  [UnresolvableContextError, EXIT.FAILURE],
];

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  const matched = EXIT_BY_ERROR.find(([constructor]) => error instanceof constructor);

  if (matched !== undefined && error instanceof Error) {
    process.stderr.write(`\n${error.message}\n`);
    process.exitCode = matched[1];
  } else if (error instanceof Error) {
    // A stack trace helps us and means nothing to an operator.
    process.stderr.write(
      `\n${DEFAULT_VERBOSE_ERRORS ? (error.stack ?? error.message) : error.message}\n`,
    );
    process.exitCode = EXIT.FAILURE;
  } else {
    process.stderr.write(`\n${String(error)}\n`);
    process.exitCode = EXIT.FAILURE;
  }
}
