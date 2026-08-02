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

/** Subcommands. Anything not in here, and not hostname-shaped, is an error. */
const KNOWN_COMMANDS = new Set(['scan', 'crawl', 'analyse', 'analyze']);

const USAGE = `schemanator — whole-site structured-data integrity checking

Usage:
  schemanator <site> [options]          Crawl, extract, check and report.
  schemanator crawl <site> [options]    Crawl only, no analysis.
  schemanator analyse <site> [options]  Re-analyse a stored crawl. No network,
                                        so rule changes can be re-evaluated
                                        against real sites in seconds.

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
  --no-sort-query        Do not sort query parameters when canonicalising.
  --disable <check>      Disable a check or a whole group. Repeatable.
  --json                 Emit report.json to stdout instead of markdown.
  --since <run-id>       Diff this run against an earlier one and print the
                         diff instead of the report. "last" picks the most
                         recent previous run. Findings are matched by id, so a
                         half-fixed problem shows as Changed, not as one
                         resolved plus one new.
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

async function main(argv: string[]): Promise<number> {
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
      json: { type: 'boolean', default: false },
      since: { type: 'string' },
      'log-level': { type: 'string' },
      quiet: { type: 'boolean', default: false },
      verbose: { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
      version: { type: 'boolean', default: false },
    },
  });

  // Bare version, nothing else. Anything wrapping this — a CI job, a bug
  // report template, `npx <tool> --version` — wants one parseable line, not a
  // banner.
  if (values.version === true) {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }

  if (values.help === true || positionals.length === 0) {
    process.stdout.write(USAGE);
    return values.help === true ? 0 : 1;
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
    return 1;
  }
  if (target === undefined) {
    process.stderr.write(`${command} needs a site\n\n${USAGE}`);
    return 1;
  }

  const numeric = (name: string, raw: string | undefined): number | undefined => {
    if (raw === undefined) return undefined;
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`--${name} must be a positive integer, got ${raw}`);
    return parsed;
  };

  const sample = values.sample;
  if (sample !== undefined && sample !== 'spread' && sample !== 'document') {
    throw new Error(`--sample must be "spread" or "document", got ${JSON.stringify(sample)}`);
  }

  // Aliases resolve to a level here so there is exactly one precedence chain.
  const levelFlag = values.quiet === true ? 'error' : values.verbose === true ? 'debug' : values['log-level'];
  const logger = createLogger(resolveLogLevel({ flag: levelFlag, env: process.env['LOG_LEVEL'] }));

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
    const result = await runAnalysis({
      workRoot: values['work-dir'] ?? defaultWorkRoot(),
      siteSlug: slug,
      logger,
      disabledChecks: values.disable ?? [],
      ...(values.since === undefined ? {} : { since: values.since }),
    });

    if (result.diff !== null) {
      process.stdout.write(
        values.json === true ? `${JSON.stringify(result.diff, null, 2)}\n` : (result.diffMarkdown ?? ''),
      );
    } else {
      process.stdout.write(values.json === true ? `${JSON.stringify(result.report, null, 2)}\n` : result.markdown);
    }
    logger.info(`\nReport: ${result.reportDir}`);
    return 0;
  }

  // A dry run never analyses: there is nothing stored to analyse.
  if (command === 'scan' && values['dry-run'] !== true) {
    const result = await runPipeline({
      ...shared,
      disabledChecks: values.disable ?? [],
    });

    // Report to stdout, logs to stderr, so this pipes into a pager, a file or
    // an agent without commentary corrupting the output.
    process.stdout.write(values.json === true ? `${JSON.stringify(result.report, null, 2)}\n` : result.markdown);
    logger.info(`\nReport: ${result.reportDir}`);
    return result.crawl.aborted !== null ? 2 : 0;
  }

  const summary = await runCrawl(shared);

  if (summary.dry_run) {
    // The URL list is data. It goes to stdout regardless of log level, so
    // `--dry-run --quiet > urls.txt` yields a clean file.
    for (const url of summary.queued_urls ?? []) process.stdout.write(`${url}\n`);
    return 0;
  }

  // Say what this run did, then what is stored. Conflating the two makes a
  // resumed crawl claim it fetched pages it did not touch.
  const requested = summary.fetched_this_run;
  logger.info(
    `\nDone. ${requested} page(s) requested this run` +
      (requested === 0 ? ' (everything was already stored)' : '') +
      `. ${summary.fetched} stored, ${summary.skipped} skipped, ${summary.failed} failed.`,
  );
  logger.info(`Output: ${summary.work_dir}`);

  if (summary.aborted !== null) return 2;
  return 0;
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  if (error instanceof RobotsUnavailableError) {
    process.stderr.write(`\n${error.message}\n`);
    process.exitCode = 3;
  } else if (error instanceof CrawlAbortedError) {
    process.stderr.write(`\n${error.message}\n`);
    process.exitCode = 2;
  } else if (error instanceof UnknownRunError) {
    process.stderr.write(`\n${error.message}\n`);
    process.exitCode = 1;
  } else if (error instanceof UrlCanonicalisationError) {
    process.stderr.write(`\n${error.message}\n`);
    process.exitCode = 1;
  } else if (error instanceof Error) {
    // A stack trace helps us and means nothing to an operator.
    process.stderr.write(`\n${DEFAULT_VERBOSE_ERRORS ? (error.stack ?? error.message) : error.message}\n`);
    process.exitCode = 1;
  } else {
    process.stderr.write(`\n${String(error)}\n`);
    process.exitCode = 1;
  }
}
