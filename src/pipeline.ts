/**
 * The full pipeline: crawl → extract → check → report.
 *
 * What `schemanator <site>` runs, and what `npx @headwall/schemanator
 * example.com` promises (`06`).
 */

import { runChecks } from './checks/run.ts';
import { buildGraph } from './checks/graph.ts';
import { readStoredRobots } from './checks/robots.ts';
import { runCrawl, type CrawlOptions, type CrawlSummary } from './crawl/run.ts';
import { sitemapsFound } from './crawl/sitemaps.ts';
import { readGraph, runExtraction } from './extract/run.ts';
import { SILENT_LOGGER, type Logger } from './log.ts';
import { buildReport, type Report } from './report/build.ts';
import { renderMarkdown } from './report/markdown.ts';
import { renderHtml } from './report/html.ts';
import { DEFAULT_EMIT_BY_TYPE, VERSION } from './runtime.ts';
import { isHopPage, siteSlugFor, WorkDir } from './store/workdir.ts';

export interface PipelineOptions extends CrawlOptions {
  disabledChecks?: readonly string[];
  emitByType?: boolean;
  version?: string;
}

export interface PipelineResult {
  crawl: CrawlSummary;
  report: Report;
  markdown: string;
  html: string;
  reportDir: string;
}

/** Sortable, filesystem-safe, and it matches `reports/<run-id>/` in `01`. */
function runId(): string {
  return new Date().toISOString().replace(/[:.]/g, '').replace(/-/g, '').slice(0, 15).concat('Z');
}

export async function runPipeline(options: PipelineOptions): Promise<PipelineResult> {
  const logger: Logger = options.logger ?? SILENT_LOGGER;

  const crawl = await runCrawl(options);
  if (crawl.dry_run)
    throw new Error('runPipeline cannot be used with dryRun; call runCrawl directly');

  const workDir = new WorkDir(options.workRoot, options.siteSlug ?? siteSlugFor(crawl.site_origin));

  const extraction = await runExtraction({
    workDir,
    logger,
    emitByType: options.emitByType ?? DEFAULT_EMIT_BY_TYPE,
  });

  logger.info('Running checks …');
  const nodes = await readGraph(workDir);
  const pages = await workDir.readPageRecords();
  // The audited sample and its nodes, split once and used by both the checks
  // and the report — see `isHopPage`.
  const auditedPageIds = new Set(pages.filter((page) => !isHopPage(page)).map((p) => p.page_id));
  const auditedNodes = nodes.filter((node) => auditedPageIds.has(node.page_id));

  const { findings, silenced, checksRun, checksDisabled } = runChecks({
    nodes,
    pages,
    partialCoverage: crawl.truncated !== null,
    robots: await readStoredRobots(workDir.crawlDir),
    sitemapsFound: sitemapsFound(crawl.sitemaps),
    // `?? null` rather than `?? []`: a crawl older than 1.12.0 has no
    // `duplicate_entries` key at all, and reading that absence as "none found"
    // would let two checks report a clean sitemap they never looked at.
    sitemapDuplicates: crawl.duplicate_entries ?? null,
    links: await workDir.readLinks(),
    // Same rule again, and it matters more here: a crawl older than 1.13.0 has
    // no `link_hop` key, and group `link` reading that as "the hop found
    // nothing" would report every page behind a noindexed hub as an orphan.
    linkHop: crawl.link_hop ?? null,
    ...(options.disabledChecks === undefined ? {} : { disabled: options.disabledChecks }),
  });

  const report = buildReport({
    version: options.version ?? VERSION,
    runId: runId(),
    crawl,
    extraction,
    pages,
    // Over the audited nodes, matching `graph.nodes` beside it. A hop page
    // repeating the sitewide Organization must not add an entity the checks
    // never looked at.
    entities: buildGraph(auditedNodes).groups.size,
    findings,
    silenced,
    checksRun,
    checksDisabled,
  });

  const markdown = renderMarkdown(report);
  const html = renderHtml(report);

  // All three are written regardless of --format (`05`), so the artefacts exist
  // whichever way the command was invoked — you can email the HTML later without
  // re-running anything.
  await workDir.writeReport(
    report.run.run_id,
    'report.json',
    `${JSON.stringify(report, null, 2)}\n`,
  );
  await workDir.writeReport(report.run.run_id, 'report.md', markdown);
  await workDir.writeReport(report.run.run_id, 'report.html', html);

  return { crawl, report, markdown, html, reportDir: workDir.reportsDir(report.run.run_id) };
}
