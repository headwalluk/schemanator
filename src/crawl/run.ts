/**
 * The crawl: seed, filter, fetch, store.
 *
 * Phase 0 crawls the sitemap and nothing else. Discovery of pages that are
 * linked but absent from the sitemap is Phase 1+ (`dev-notes/02`).
 */

import { CrawlAbortedError, PoliteFetcher, type FetchRecord } from '../net/fetcher.ts';
import { canonicaliseUrl, tryCanonicaliseUrl } from '../url/canonical.ts';
import { Frontier } from './frontier.ts';
import {
  fetchRobots,
  RobotsUnavailableError,
  summarisePolicy,
  type RobotsPolicy,
} from './robots.ts';
import { discoverSitemaps, type SitemapDiscovery } from './sitemaps.ts';
import {
  pageIdFor,
  sha256,
  siteSlugFor,
  WorkDir,
  type PageAlias,
  type PageRecord,
} from '../store/workdir.ts';
import { SILENT_LOGGER, type Logger } from '../log.ts';

/**
 * How to choose which URLs survive `--max-pages`.
 *
 * - `spread` — round-robin across the source sitemaps, so every sitemap is
 *   represented in proportion to nothing at all. Default.
 * - `document` — strict sitemap document order. The first N URLs, full stop.
 */
export type SampleStrategy = 'spread' | 'document';

export interface CrawlOptions {
  startUrl: string;
  workRoot: string;
  siteSlug?: string;
  cliSitemaps?: readonly string[];
  maxPages?: number;
  sample?: SampleStrategy;
  maxDepth?: number;
  delayMs?: number;
  dryRun?: boolean;
  resume?: boolean;
  sortQuery?: boolean;
  logger?: Logger;
  /**
   * Called after each page is stored, so a detached crawl can publish
   * progress. Kept to counters: this must not become a second logger.
   */
  onProgress?: (progress: { fetched: number; total: number }) => void;
}

export interface CrawlSummary {
  start_url: string;
  site_origin: string;
  site_slug: string;
  work_dir: string | null;
  dry_run: boolean;
  robots: Record<string, unknown>;
  sitemaps: SitemapDiscovery['sitemaps'];
  sitemap_errors: string[];
  dropped_entries: SitemapDiscovery['dropped'];
  /**
   * URLs listed more than once across this site's sitemaps.
   *
   * **Absent on a crawl older than 1.12.0, and that is not the same as empty.**
   * The two checks reading it must treat the missing key as *unknown* rather
   * than as *none* — and unlike `microdata_types`, re-running `analyse` cannot
   * fill it in, because deduplication happens at discovery. It takes a re-crawl.
   */
  duplicate_entries?: SitemapDiscovery['duplicates'];
  host_divergence: SitemapDiscovery['hostDivergence'];
  /** URLs found before robots filtering and the page cap. */
  urls_discovered: number;
  urls_disallowed: number;
  urls_queued: number;
  truncated: { limit: number; dropped: number } | null;
  sample_strategy: SampleStrategy;
  seeded_from: 'sitemap' | 'front-page';
  /**
   * Pages actually requested during THIS run.
   *
   * Distinct from `fetched`, which is the cumulative count of everything stored
   * for the site. On a resumed crawl the two differ sharply, and reporting only
   * the total says "47 fetched" when nothing was fetched at all.
   */
  fetched_this_run: number;
  /** Populated only under --dry-run: the URLs that would have been fetched. */
  queued_urls?: string[];
  fetched: number;
  failed: number;
  skipped: number;
  aborted: string | null;
  started_at: string;
  finished_at: string;
}

const HTML_TYPES = ['text/html', 'application/xhtml+xml'];

/**
 * Below this share of the discovered URLs, the crawl warns that cross-page
 * checks become unreliable. See the use site for why a half.
 */
const SAMPLING_WARNING_SHARE = 0.5;

interface Candidate {
  url: string;
  source: string;
  /** Which sitemap supplied it — the grouping key for `spread` sampling. */
  fromSitemap: string;
}

/**
 * Choose which candidates survive the page cap.
 *
 * Why `spread` is the default, and why it matters more than it looks:
 *
 * A large WordPress site partitions its sitemap index by post type — eight
 * `post` sitemaps of 1,000 URLs each, one `page` sitemap of 82, one taxonomy
 * sitemap of 1,031. Under document order, `--max-pages 500` takes 500 news
 * articles and never reaches the `page` sitemap at all. But the `page` sitemap
 * is where `Organization`, `LocalBusiness` and `AboutPage` live — and the
 * homepage with them.
 *
 * The resulting report would state "no LocalBusiness found on this site". That
 * is not an incomplete answer, it is a **wrong** one, and it is exactly the
 * failure mode `02` warns about for JavaScript-injected schema: a confident
 * negative drawn from a blind spot.
 *
 * Round-robin costs nothing, stays deterministic, and guarantees every content
 * type is represented. The front page is hoisted to the front regardless: it is
 * the single most valuable page on any site for entity reconciliation, and on a
 * partitioned sitemap it is easy to miss entirely.
 */
export function selectSample(
  candidates: readonly Candidate[],
  maxPages: number,
  strategy: SampleStrategy,
  siteOrigin: string,
): Candidate[] {
  if (candidates.length <= maxPages) return [...candidates];

  const frontPage = `${siteOrigin}/`;
  const front = candidates.filter((candidate) => candidate.url === frontPage);
  const rest = candidates.filter((candidate) => candidate.url !== frontPage);

  if (strategy === 'document') {
    return [...front, ...rest].slice(0, maxPages);
  }

  // Group by source sitemap, preserving within-group document order.
  const groups = new Map<string, Candidate[]>();
  for (const candidate of rest) {
    const group = groups.get(candidate.fromSitemap) ?? [];
    group.push(candidate);
    groups.set(candidate.fromSitemap, group);
  }

  const selected: Candidate[] = front.slice(0, maxPages);
  const buckets = [...groups.values()];
  const cursors = new Array<number>(buckets.length).fill(0);

  let exhausted = false;
  while (selected.length < maxPages && !exhausted) {
    exhausted = true;
    for (let index = 0; index < buckets.length; index += 1) {
      const bucket = buckets[index];
      const cursor = cursors[index] ?? 0;
      if (bucket === undefined || cursor >= bucket.length) continue;

      const candidate = bucket[cursor];
      if (candidate !== undefined) selected.push(candidate);
      cursors[index] = cursor + 1;
      exhausted = false;

      if (selected.length >= maxPages) break;
    }
  }

  return selected;
}

export async function runCrawl(options: CrawlOptions): Promise<CrawlSummary> {
  const {
    workRoot,
    cliSitemaps = [],
    maxPages = 500,
    sample = 'spread',
    maxDepth = 3,
    delayMs = 1000,
    dryRun = false,
    resume = false,
    sortQuery = true,
    logger = SILENT_LOGGER,
    onProgress,
  } = options;

  const startedAt = new Date().toISOString();
  const startUrl = canonicaliseUrl(options.startUrl, { sortQuery });
  const fetcher = new PoliteFetcher({ delayMs });

  // --- robots.txt --------------------------------------------------------
  // Fetched first, and unconditionally. If it is unreadable for a reason that
  // means "stop", this throws and nothing else happens.
  logger.info(`Fetching robots.txt for ${new URL(startUrl).origin} …`);
  const policy: RobotsPolicy = await fetchRobots(fetcher, startUrl);

  const siteOrigin = policy.siteOrigin;
  const siteSlug = options.siteSlug ?? siteSlugFor(siteOrigin);
  const workDir = new WorkDir(workRoot, siteSlug);

  for (const note of policy.errors) logger.warn(note);
  logger.info(
    `  robots.txt: ${policy.source}${policy.httpStatus === null ? '' : ` (HTTP ${policy.httpStatus})`}`,
  );

  if (policy.crawlDelayMs !== null) {
    // Honoured when longer than ours. Never shortened by it.
    const host = new URL(siteOrigin).host;
    const before = fetcher.hostDelay(host);
    fetcher.setHostDelay(host, policy.crawlDelayMs);
    const after = fetcher.hostDelay(host);
    logger.info(
      `  Crawl-delay: ${policy.crawlDelayMs} ms — ` +
        (after > before
          ? `raising our delay to ${after} ms`
          : `shorter than our ${before} ms, ignored`),
    );
  }

  if (!dryRun) {
    await workDir.init();
    if (!resume) await workDir.resetCrawlState();
    if (policy.text !== null) await workDir.writeCrawlFile('robots.txt', policy.text);
    await workDir.writeCrawlFile(
      'robots.parsed.json',
      `${JSON.stringify(summarisePolicy(policy), null, 2)}\n`,
    );
  }

  // --- sitemaps ----------------------------------------------------------
  const seedNote =
    cliSitemaps.length > 0
      ? `${cliSitemaps.length} from --sitemap (robots directives and probing suppressed)`
      : policy.sitemaps.length > 0
        ? `${policy.sitemaps.length} declared in robots.txt`
        : 'none declared — probing the well-known paths';
  logger.info(`Discovering sitemaps: ${seedNote}`);

  const discovery = await discoverSitemaps(fetcher, siteOrigin, {
    cliSitemaps,
    robotsSitemaps: policy.sitemaps,
    maxDepth,
    ...(dryRun
      ? {}
      : {
          onSitemapBody: async (_url: string, body: Buffer, index: number) => {
            await workDir.writeSitemap(index, body);
          },
        }),
  });

  for (const sitemap of discovery.sitemaps) {
    const detail =
      sitemap.error !== null
        ? `ERROR ${sitemap.error}`
        : `${sitemap.format}, ${sitemap.urlCount} urls, ${sitemap.childCount} children`;
    logger.debug(`  [${sitemap.source}] ${sitemap.url} — ${detail}`);
  }
  for (const error of discovery.errors) logger.warn(`sitemap: ${error}`);
  if (discovery.hostDivergence.length > 0) {
    const first = discovery.hostDivergence[0];
    logger.warn(
      `${discovery.hostDivergence.length} sitemap entr(ies) use host "${first?.entryHost}" ` +
        `but we were given "${first?.crawlHost}" — crawling them anyway, recorded as a finding`,
    );
  }
  // Dropped entries are easy to lose sight of, and a sitemap that is mostly
  // cross-host entries means the URL list is not what the operator expects.
  if (discovery.dropped.length > 0) {
    logger.warn(`${discovery.dropped.length} sitemap entr(ies) dropped:`);
    for (const entry of discovery.dropped.slice(0, 10))
      logger.warn(`  ${entry.rawUrl} — ${entry.reason}`);
    if (discovery.dropped.length > 10)
      logger.warn(`  … and ${discovery.dropped.length - 10} more (see crawl-summary.json)`);
  }

  // --- seed the frontier -------------------------------------------------
  let seededFrom: 'sitemap' | 'front-page' = 'sitemap';
  let candidates: Candidate[] = discovery.urls.map((entry) => ({
    url: entry.url,
    source: `sitemap:${entry.fromSitemap}`,
    fromSitemap: entry.fromSitemap,
  }));

  if (candidates.length === 0) {
    // No sitemaps, or sitemaps that yielded nothing. Fall back to the front page.
    seededFrom = 'front-page';
    candidates = [
      {
        url: canonicaliseUrl(`${siteOrigin}/`, { sortQuery }),
        source: 'front-page-fallback',
        fromSitemap: '',
      },
    ];
    logger.warn('no sitemap URLs found — falling back to the front page');
  }

  const discovered = candidates.length;

  const allowed = candidates.filter((candidate) => policy.isAllowed(candidate.url));
  const disallowed = discovered - allowed.length;
  if (disallowed > 0) logger.info(`  ${disallowed} URL(s) excluded by robots.txt`);

  // Truncation must be recorded — a report that implies whole-site coverage it
  // does not have is worse than one that admits the cap.
  const queued = selectSample(allowed, maxPages, sample, siteOrigin);
  const truncated =
    allowed.length > maxPages ? { limit: maxPages, dropped: allowed.length - maxPages } : null;

  if (truncated !== null) {
    logger.info(
      `  capped at --max-pages=${maxPages} (--sample ${sample}); ` +
        `${truncated.dropped} of ${allowed.length} URL(s) not queued`,
    );
    // Show what the sample actually covers. On a partitioned sitemap index this
    // is the difference between a representative audit and 500 news articles.
    const perSitemap = new Map<string, number>();
    for (const candidate of queued)
      perSitemap.set(candidate.fromSitemap, (perSitemap.get(candidate.fromSitemap) ?? 0) + 1);
    for (const [sitemap, count] of perSitemap) {
      const available = allowed.filter((candidate) => candidate.fromSitemap === sitemap).length;
      logger.info(`    ${String(count).padStart(5)} of ${String(available).padEnd(6)} ${sitemap}`);
    }

    /**
     * Say which conclusions get weaker, not just that the crawl was capped.
     *
     * `--max-pages` used to be purely a time-and-politeness knob: it changed how
     * long the crawl took and set `coverage.complete`, and nothing else. Some
     * checks now *reason across the sample*, and for those a small share is not
     * merely less coverage — it produces a **false negative that reads as a
     * pass**, which is the worst outcome available.
     *
     * `indexing.duplicate-content` is the live example: crawl one URL of a
     * duplicate pair and never see the other, and it reports nothing at all.
     * The same will apply to boilerplate and near-duplicate detection when they
     * arrive (`07`).
     *
     * The threshold is a half. Below that the sample is a minority of the site
     * and comparisons across it stop being representative; above it, the
     * existing `coverage_qualified` machinery already says enough.
     */
    const share = allowed.length === 0 ? 1 : queued.length / allowed.length;
    if (share < SAMPLING_WARNING_SHARE) {
      logger.warn(
        `  sampling ${queued.length} of ${allowed.length} URL(s) (${Math.round(share * 100)}%) — ` +
          `checks that compare pages against each other, such as duplicate-content, can miss a ` +
          `pair when only one half was crawled, and will report nothing rather than a maybe`,
      );
      logger.warn(
        `  raise --max-pages for a conclusive answer on those; findings that assert something is ` +
          `absent are already marked as qualified by coverage`,
      );
    }
  }

  const summary: CrawlSummary = {
    start_url: startUrl,
    site_origin: siteOrigin,
    site_slug: siteSlug,
    work_dir: dryRun ? null : workDir.root,
    dry_run: dryRun,
    robots: summarisePolicy(policy),
    sitemaps: discovery.sitemaps,
    sitemap_errors: discovery.errors,
    dropped_entries: discovery.dropped,
    duplicate_entries: discovery.duplicates,
    host_divergence: discovery.hostDivergence,
    urls_discovered: discovered,
    urls_disallowed: disallowed,
    urls_queued: queued.length,
    truncated,
    sample_strategy: sample,
    seeded_from: seededFrom,
    fetched_this_run: 0,
    fetched: 0,
    failed: 0,
    skipped: 0,
    aborted: null,
    started_at: startedAt,
    finished_at: startedAt,
  };

  if (dryRun) {
    // The URL list is the *output* of --dry-run, not commentary about it, so it
    // travels in the summary and the caller decides where to put it.
    summary.queued_urls = queued.map((candidate) => candidate.url);
    logger.info(`${queued.length} URL(s) would be fetched. --dry-run: no pages were requested.`);
    summary.finished_at = new Date().toISOString();
    return summary;
  }

  // --- fetch -------------------------------------------------------------
  const frontier = new Frontier(workDir.frontierPath);
  if (resume) await frontier.load();

  /**
   * Every page record this site has, keyed by resolved id.
   *
   * Seeded from disk on a resumed crawl so a redirect fetched today can be
   * folded into a destination fetched last week. Rewritten over the manifest
   * when the fetch loop ends — appending alone cannot express a record that was
   * merged after it was written.
   */
  const records = new Map<string, PageRecord>();
  if (resume) {
    try {
      for (const existing of await workDir.readPageRecords())
        records.set(existing.page_id, existing);
    } catch {
      // No manifest yet. A resumed crawl of a site with no stored pages is
      // unusual but not wrong, and an empty map is the correct starting point.
    }
  }

  for (const candidate of queued) {
    await frontier.add(candidate.url, pageIdFor(candidate.url), candidate.source);
  }

  const pending = frontier.pending();
  const alreadyDone = frontier.counts().done;
  if (resume && alreadyDone > 0)
    logger.info(`Resuming: ${alreadyDone} already fetched, ${pending.length} to go`);

  const estimateMs = pending.length * fetcher.hostDelay(new URL(siteOrigin).host);
  logger.info(
    `Fetching ${pending.length} page(s), ~${Math.ceil(estimateMs / 60000)} min at the current delay …`,
  );

  const total = pending.length;
  const width = String(total).length;
  let index = 0;

  for (const item of pending) {
    index += 1;

    let record: FetchRecord;
    try {
      record = await fetcher.fetch(item.url, { accept: HTML_TYPES });
    } catch (error) {
      if (error instanceof CrawlAbortedError) {
        summary.aborted = error.message;
        logger.error(error.message);
        break;
      }
      throw error;
    }

    await workDir.appendCrawlLog(record);
    summary.fetched_this_run += 1;
    await storeResult(
      workDir,
      frontier,
      records,
      item.url,
      item.page_id,
      item.source,
      record,
      summary,
      sortQuery,
    );

    // Per-page progress. A long crawl is otherwise silent for over an hour,
    // which makes a wedged run indistinguishable from a slow one.
    const outcome = record.status ?? record.error?.kind ?? '—';
    const size = record.bytes > 0 ? `${(record.bytes / 1024).toFixed(1)} KB` : '';
    const note = record.redirectChain.length > 0 ? ` → ${record.finalUrl}` : '';
    logger.info(
      `  [${String(index).padStart(width)}/${total}] ${String(outcome).padEnd(7)}${size.padStart(9)}  ${item.url}${note}`,
    );

    onProgress?.({ fetched: index, total });
  }

  /**
   * One line per page, with merged pairs collapsed.
   *
   * The manifest is appended to during the loop so a crawl that dies still
   * describes what it fetched, which means a record merged *after* it was
   * appended is on disk twice. `01` says the manifest is truth, so the truth
   * gets written once the loop can no longer change it.
   */
  const reconciled = [...records.values()];
  const folded = reconciled.reduce((total, record) => total + (record.aliases?.length ?? 0), 0);
  if (folded > 0) {
    logger.info(
      `  ${folded} redirecting URL(s) resolved to a page already crawled — recorded as aliases ` +
        `rather than stored twice`,
    );
  }
  if (reconciled.length > 0) await workDir.rewritePageRecords(reconciled);

  const counts = frontier.counts();
  summary.fetched = counts.done;
  summary.failed = counts.failed;
  summary.skipped = counts.skipped;
  summary.finished_at = new Date().toISOString();

  await workDir.writeRunSummary(summary as unknown as Record<string, unknown>);
  return summary;
}

/**
 * Fold a second request that landed on an already-recorded page into that page.
 *
 * The **direct** request wins the record — the one whose requested URL is the
 * URL it resolved to — and the redirected one becomes an alias, whichever order
 * the two were fetched in. Order-independence is the whole point: a sitemap
 * lists `/shop/` before `/pricing/` on one site and after it on another, and the
 * manifest must not depend on which.
 */
function mergePageRecord(existing: PageRecord, incoming: PageRecord): PageRecord {
  const asAlias = (record: PageRecord): PageAlias => ({
    url: record.url,
    source: record.source,
    http_status: record.http_status,
    redirect_chain: record.redirect_chain,
    fetched_at: record.fetched_at,
  });

  const incomingIsDirect = incoming.url === incoming.canonical_url;
  const [primary, demoted] = incomingIsDirect ? [incoming, existing] : [existing, incoming];

  const aliases = [...(existing.aliases ?? []), ...(incoming.aliases ?? [])];
  // Two requests for one URL cannot both reach here — they would be one
  // frontier item — so the demoted record is always a distinct URL.
  if (!aliases.some((alias) => alias.url === demoted.url)) aliases.push(asAlias(demoted));

  return { ...primary, aliases };
}

async function storeResult(
  workDir: WorkDir,
  frontier: Frontier,
  records: Map<string, PageRecord>,
  url: string,
  pageId: string,
  source: string,
  record: FetchRecord,
  summary: CrawlSummary,
  sortQuery: boolean,
): Promise<void> {
  // `error` and `notFetchedReason` overlap when both are set — a rejected
  // content-type populates both — so prefer the more descriptive one.
  const errors: string[] = [];
  if (record.error !== null) {
    errors.push(`${record.error.kind}: ${record.error.message}`);
  } else if (record.notFetchedReason !== null) {
    errors.push(record.notFetchedReason);
  }

  // The final URL after redirects is the page's identity (`02`), canonicalised
  // like everything else (`01`). It sits next to the requested `url`: where the
  // two differ, the sitemap is advertising a URL that is not the one served,
  // which is a finding in its own right.
  const canonical = tryCanonicaliseUrl(record.finalUrl, { sortQuery });
  const canonicalUrl = canonical.ok ? canonical.url : record.finalUrl;

  /**
   * Identity is the URL we ended at, not the one we asked for.
   *
   * `pageId` is what the frontier derived from the requested URL, which is
   * right for bookkeeping — the frontier's job is to remember what was asked —
   * and wrong for storage. Writing the destination's HTML under the requesting
   * URL's id is what stored one page twice.
   */
  const resolvedId = pageIdFor(canonicalUrl);

  const pageRecord: PageRecord = {
    page_id: resolvedId,
    url,
    canonical_url: canonicalUrl,
    // Filled by extraction (`dev-notes/03`), which is the layer that parses HTML.
    declared_canonical: null,
    source,
    http_status: record.status,
    redirect_chain: record.redirectChain,
    content_type: record.contentType,
    fetched_at: new Date().toISOString(),
    content_sha256: record.body === null ? null : sha256(record.body),
    bytes: record.bytes,
    html_purged: false,
    extraction: null,
    microdata_types: [],
    page_facts: null,
    errors,
  };

  const existing = records.get(resolvedId);
  const merged = existing === undefined ? pageRecord : mergePageRecord(existing, pageRecord);
  records.set(resolvedId, merged);

  const meta = {
    ...merged,
    requested_url: record.requestedUrl,
    headers: record.headers,
    attempts: record.attempts,
    elapsed_ms: record.elapsedMs,
  };

  if (record.body !== null) {
    // Written under the resolved id, so the second request overwrites the same
    // directory with the same bytes rather than creating a second copy.
    await workDir.savePage(resolvedId, record.body, meta);
    await frontier.markDone(url);
  } else {
    await workDir.saveFailedPage(resolvedId, meta);
    // A non-2xx or wrong content-type is a *skip* — expected, recorded, not a
    // malfunction. A timeout or network failure is a genuine failure.
    if (record.error === null || record.error.kind === 'content-type-rejected') {
      await frontier.markSkipped(url, errors.join('; ') || 'no body');
    } else {
      await frontier.markFailed(url, errors.join('; '));
    }
  }

  // Appended as the crawl goes, so a run that dies still leaves a manifest
  // describing what it fetched. `runCrawl` rewrites it from `records` at the
  // end, which is what collapses a merged pair into its single line.
  await workDir.appendPageRecord(merged);
  summary.fetched = frontier.counts().done;
}

export { RobotsUnavailableError, CrawlAbortedError };
