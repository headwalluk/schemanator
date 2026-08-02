/**
 * The full pipeline: crawl → extract → check → report.
 *
 * What `schemanator <site>` runs, and what `npx @headwall/schemanator
 * example.com` promises (`06`).
 */

import { runChecks } from './checks/run.ts';
import { buildGraph } from './checks/graph.ts';
import { runCrawl, type CrawlOptions, type CrawlSummary } from './crawl/run.ts';
import { readGraph, runExtraction } from './extract/run.ts';
import { SILENT_LOGGER, type Logger } from './log.ts';
import { buildReport, type Report } from './report/build.ts';
import { renderMarkdown } from './report/markdown.ts';
import { DEFAULT_EMIT_BY_TYPE, VERSION } from './runtime.ts';
import { siteSlugFor, WorkDir } from './store/workdir.ts';

export interface PipelineOptions extends CrawlOptions {
  disabledChecks?: readonly string[];
  emitByType?: boolean;
  version?: string;
}

export interface PipelineResult {
  crawl: CrawlSummary;
  report: Report;
  markdown: string;
  reportDir: string;
}

/** Sortable, filesystem-safe, and it matches `reports/<run-id>/` in `01`. */
function runId(): string {
  return new Date().toISOString().replace(/[:.]/g, '').replace(/-/g, '').slice(0, 15).concat('Z');
}

export async function runPipeline(options: PipelineOptions): Promise<PipelineResult> {
  const logger: Logger = options.logger ?? SILENT_LOGGER;

  const crawl = await runCrawl(options);
  if (crawl.dry_run) throw new Error('runPipeline cannot be used with dryRun; call runCrawl directly');

  const workDir = new WorkDir(options.workRoot, options.siteSlug ?? siteSlugFor(crawl.site_origin));

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

  await workDir.writeReport(report.run.run_id, 'report.json', `${JSON.stringify(report, null, 2)}\n`);
  await workDir.writeReport(report.run.run_id, 'report.md', markdown);

  return { crawl, report, markdown, reportDir: workDir.reportsDir(report.run.run_id) };
}
