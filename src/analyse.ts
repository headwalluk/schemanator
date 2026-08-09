/**
 * Re-analyse a stored crawl: extract → check → report, with no network.
 *
 * The crawl is the expensive, impolite part; analysis is cheap and repeatable.
 * Separating them means a rule change, a new check or a bug fix can be
 * re-evaluated against real sites in seconds without fetching a single page —
 * which is the whole reason `02` stores the HTML.
 *
 * It is also step 4 of the fix-verify loop in `00`: after the operator fixes
 * their markup, re-crawl once and re-analyse as often as needed.
 */

import fs from 'node:fs/promises';
import path from 'node:path';

import { buildGraph } from './checks/graph.ts';
import { readStoredRobots } from './checks/robots.ts';
import { runChecks } from './checks/run.ts';
import type { CrawlSummary } from './crawl/run.ts';
import { readGraph, runExtraction } from './extract/run.ts';
import { SILENT_LOGGER, type Logger } from './log.ts';
import { buildReport, type Report } from './report/build.ts';
import { renderMarkdown } from './report/markdown.ts';
import { renderHtml } from './report/html.ts';
import { diffReports, type ReportDiff } from './report/diff.ts';
import { renderDiffMarkdown } from './report/diff-markdown.ts';
import { DEFAULT_EMIT_BY_TYPE, VERSION } from './runtime.ts';
import { WorkDir } from './store/workdir.ts';

export interface AnalyseOptions {
  workRoot: string;
  siteSlug: string;
  logger?: Logger;
  disabledChecks?: readonly string[];
  emitByType?: boolean;
  version?: string;
  /** A run id, or `last` for the most recent run before this one. */
  since?: string;
}

export interface AnalyseResult {
  report: Report;
  markdown: string;
  html: string;
  reportDir: string;
  diff: ReportDiff | null;
  diffMarkdown: string | null;
}

export class UnknownRunError extends Error {
  constructor(requested: string, available: string[]) {
    super(
      available.length === 0
        ? `no previous runs found for this site, so there is nothing to diff against`
        : `no run "${requested}". Available: ${available.join(', ')}`,
    );
    this.name = 'UnknownRunError';
  }
}

function runId(): string {
  return new Date().toISOString().replace(/[:.]/g, '').replace(/-/g, '').slice(0, 15).concat('Z');
}

/**
 * Recover the crawl's coverage numbers.
 *
 * Without them the report cannot state what it did and did not cover, and rule
 * 3 of `04` — an absence claim is only as good as the coverage — has nothing to
 * stand on. A missing summary is therefore treated as unknown-and-partial
 * rather than quietly assumed complete.
 */
async function readCrawlSummary(workDir: WorkDir, pageCount: number): Promise<CrawlSummary> {
  try {
    const raw = await fs.readFile(path.join(workDir.root, 'crawl-summary.json'), 'utf8');
    return JSON.parse(raw) as CrawlSummary;
  } catch {
    return {
      start_url: '',
      site_origin: workDir.siteSlug,
      site_slug: workDir.siteSlug,
      work_dir: workDir.root,
      dry_run: false,
      robots: {},
      sitemaps: [],
      sitemap_errors: [],
      dropped_entries: [],
      host_divergence: [],
      urls_discovered: pageCount,
      urls_disallowed: 0,
      urls_queued: pageCount,
      truncated: null,
      sample_strategy: 'spread',
      seeded_from: 'sitemap',
      fetched: pageCount,
      fetched_this_run: 0,
      failed: 0,
      skipped: 0,
      aborted: null,
      started_at: new Date().toISOString(),
      finished_at: new Date().toISOString(),
    };
  }
}

export async function runAnalysis(options: AnalyseOptions): Promise<AnalyseResult> {
  const logger = options.logger ?? SILENT_LOGGER;
  const workDir = new WorkDir(options.workRoot, options.siteSlug);

  const pagesBefore = await workDir.readPageRecords();
  const crawl = await readCrawlSummary(workDir, pagesBefore.length);

  const extraction = await runExtraction({
    workDir,
    logger,
    emitByType: options.emitByType ?? DEFAULT_EMIT_BY_TYPE,
  });

  logger.info('Running checks …');
  const nodes = await readGraph(workDir);
  const pages = await workDir.readPageRecords();

  const { findings, silenced, checksRun, checksDisabled } = runChecks({
    nodes,
    pages,
    partialCoverage: crawl.truncated !== null,
    robots: await readStoredRobots(workDir.crawlDir),
    sitemapsFound: crawl.sitemaps.map((entry) => (typeof entry === 'string' ? entry : entry.url)),
    ...(options.disabledChecks === undefined ? {} : { disabled: options.disabledChecks }),
  });

  const report = buildReport({
    version: options.version ?? VERSION,
    runId: runId(),
    crawl,
    extraction,
    pages,
    entities: buildGraph(nodes).groups.size,
    findings,
    silenced,
    checksRun,
    checksDisabled,
  });

  const markdown = renderMarkdown(report);
  const html = renderHtml(report);

  // Resolve --since BEFORE writing this run, or `last` would find itself.
  let previous: Report | null = null;
  if (options.since !== undefined) {
    const runs = await workDir.listRuns();
    const wanted =
      options.since === 'last' || options.since === 'previous'
        ? runs[runs.length - 1]
        : options.since;
    if (wanted === undefined || !runs.includes(wanted))
      throw new UnknownRunError(options.since, runs);
    previous = (await workDir.readReport(wanted)) as Report | null;
    if (previous === null) throw new UnknownRunError(wanted, runs);
  }

  await workDir.writeReport(
    report.run.run_id,
    'report.json',
    `${JSON.stringify(report, null, 2)}\n`,
  );
  await workDir.writeReport(report.run.run_id, 'report.md', markdown);
  await workDir.writeReport(report.run.run_id, 'report.html', html);

  let diff: ReportDiff | null = null;
  let diffMarkdown: string | null = null;
  if (previous !== null) {
    diff = diffReports(previous, report);
    diffMarkdown = renderDiffMarkdown(diff, report.run.site_origin);
    await workDir.writeReport(report.run.run_id, 'diff.json', `${JSON.stringify(diff, null, 2)}\n`);
    await workDir.writeReport(report.run.run_id, 'diff.md', diffMarkdown);
  }

  return {
    report,
    markdown,
    html,
    reportDir: workDir.reportsDir(report.run.run_id),
    diff,
    diffMarkdown,
  };
}
