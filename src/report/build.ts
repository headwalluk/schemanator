/**
 * Building `report.json` — the contract. Everything else is a renderer over it.
 */

import type { Finding } from '../checks/run.ts';
import type { CrawlSummary } from '../crawl/run.ts';
import type { ExtractionRunSummary } from '../extract/run.ts';
import { isHopPage, type PageRecord } from '../store/workdir.ts';

export const REPORT_SCHEMA = 1;

export interface Report {
  schemanator: { version: string; report_schema: number };
  run: {
    run_id: string;
    site_slug: string;
    site_origin: string;
    started_at: string;
    finished_at: string;
  };
  coverage: {
    complete: boolean;
    urls_discovered: number;
    urls_queued: number;
    pages_fetched: number;
    pages_extracted: number;
    /**
     * Pages the crawl followed one hop out of the sitemap to reach.
     *
     * Not part of the audit — they are evidence for group `link` and appear in
     * no other finding. Added in 1.13.0; absent on an older report, and 0 on a
     * crawl run with `--no-link-hop`.
     */
    pages_linked: number;
    truncated: { limit: number; dropped: number } | null;
    sample_strategy: string;
    caveat: string | null;
  };
  graph: {
    nodes: number;
    entities: number;
    pages_with_data: number;
    json_ld_blocks: number;
    malformed_blocks: number;
  };
  summary: {
    by_severity: Record<string, number>;
    by_check: Record<string, number>;
    silenced: Record<string, number>;
    checks_run: string[];
    checks_disabled: string[];
  };
  findings: Finding[];
}

export function buildReport(input: {
  version: string;
  runId: string;
  crawl: CrawlSummary;
  extraction: ExtractionRunSummary;
  pages: PageRecord[];
  entities: number;
  findings: Finding[];
  silenced: Record<string, number>;
  checksRun: string[];
  checksDisabled: string[];
}): Report {
  const bySeverity: Record<string, number> = {};
  const byCheck: Record<string, number> = {};
  for (const finding of input.findings) {
    bySeverity[finding.severity] = (bySeverity[finding.severity] ?? 0) + 1;
    byCheck[finding.check] = (byCheck[finding.check] ?? 0) + 1;
  }

  const truncated = input.crawl.truncated;
  const complete = truncated === null;

  /**
   * The report describes the **audited sample**, and the link hop is not in it.
   *
   * Its pages were fetched to explain the sample — whether anything links to a
   * page, and whether the thing that does is indexable — and no check outside
   * group `link` looks at them. Counting them here produced the first
   * impossible number the hop shipped: *"Pages fetched | 73 of 54 discovered"*,
   * on a site with 54 URLs in its sitemap and 19 linked pages followed.
   *
   * **Counted from the manifest, never subtracted from a crawl total.** The
   * first attempt did subtract, and got it wrong on the first large site it
   * met: 48 hop requests became 44 stored records because four redirected into
   * each other, two more 404d and were stored as failures, and `crawl.fetched`
   * counts requests that succeeded. Subtracting a record count from a request
   * count printed `pages_fetched: 102` beside `pages_extracted: 98` for a
   * sample of exactly 100 — two numbers in one table that could not both be
   * true.
   *
   * That is the 1.12.0 defect wearing a different hat: requests and records are
   * different things and two of them can land on one page. So each number here
   * is the length of a set a reader can count in `pages.jsonl` themselves.
   */
  const hopPages = input.pages.filter(isHopPage);
  const auditedPages = input.pages.filter((page) => !isHopPage(page));
  const hopTotals = hopPages.reduce(
    (total, page) => ({
      nodes: total.nodes + (page.extraction?.nodes ?? 0),
      blocks: total.blocks + (page.extraction?.json_ld_blocks ?? 0),
      malformed: total.malformed + (page.extraction?.json_ld_failed ?? 0),
    }),
    { nodes: 0, blocks: 0, malformed: 0 },
  );

  return {
    schemanator: { version: input.version, report_schema: REPORT_SCHEMA },
    run: {
      run_id: input.runId,
      site_slug: input.crawl.site_slug,
      site_origin: input.crawl.site_origin,
      started_at: input.crawl.started_at,
      finished_at: new Date().toISOString(),
    },
    coverage: {
      complete,
      urls_discovered: input.crawl.urls_discovered,
      urls_queued: input.crawl.urls_queued,
      pages_fetched: auditedPages.length,
      pages_extracted: auditedPages.filter((page) => page.extraction !== null).length,
      pages_linked: hopPages.length,
      truncated,
      sample_strategy: input.crawl.sample_strategy,
      // Rule 3 of `04`: an absence claim is only as good as the coverage, and
      // the renderer is required to surface this before any finding.
      caveat: complete
        ? null
        : `${input.crawl.urls_queued} of ${input.crawl.urls_discovered} discovered URLs were audited ` +
          `(--sample ${input.crawl.sample_strategy}). Findings that assert something is ABSENT are ` +
          `qualified: it may exist on a page not fetched.`,
    },
    graph: {
      nodes: input.extraction.nodes - hopTotals.nodes,
      entities: input.entities,
      pages_with_data: auditedPages.filter((page) => (page.extraction?.['nodes'] ?? 0) > 0).length,
      json_ld_blocks: input.extraction.json_ld_blocks - hopTotals.blocks,
      malformed_blocks: input.extraction.json_ld_failed - hopTotals.malformed,
    },
    summary: {
      by_severity: bySeverity,
      by_check: byCheck,
      silenced: input.silenced,
      checks_run: input.checksRun,
      checks_disabled: input.checksDisabled,
    },
    // `omitted_count` and `detail` are guaranteed to a consumer and optional to
    // a check: a finding whose `observed` list is complete should not have to
    // say so in its constructor, and a consumer should not have to wonder
    // whether an absent key means "nothing omitted" or "nobody counted".
    findings: input.findings.map((finding) => ({
      ...finding,
      omitted_count: finding.omitted_count ?? 0,
      observed: finding.observed.map((row) => ({ ...row, detail: row.detail ?? null })),
    })),
  };
}
