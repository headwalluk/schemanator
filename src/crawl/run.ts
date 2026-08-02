/**
 * The crawl: seed, filter, fetch, store.
 *
 * Phase 0 crawls the sitemap and nothing else. Discovery of pages that are
 * linked but absent from the sitemap is Phase 1+ (`dev-notes/02`).
 */

import { CrawlAbortedError, PoliteFetcher, type FetchRecord } from '../net/fetcher.ts';
import { canonicaliseUrl, tryCanonicaliseUrl } from '../url/canonical.ts';
import { Frontier } from './frontier.ts';
import { fetchRobots, RobotsUnavailableError, summarisePolicy, type RobotsPolicy } from './robots.ts';
import { discoverSitemaps, type SitemapDiscovery } from './sitemaps.ts';
import { pageIdFor, sha256, siteSlugFor, WorkDir, type PageRecord } from '../store/workdir.ts';
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
  logger.info(`  robots.txt: ${policy.source}${policy.httpStatus === null ? '' : ` (HTTP ${policy.httpStatus})`}`);

  if (policy.crawlDelayMs !== null) {
    // Honoured when longer than ours. Never shortened by it.
    const host = new URL(siteOrigin).host;
    const before = fetcher.hostDelay(host);
    fetcher.setHostDelay(host, policy.crawlDelayMs);
    const after = fetcher.hostDelay(host);
    logger.info(
      `  Crawl-delay: ${policy.crawlDelayMs} ms — ` +
        (after > before ? `raising our delay to ${after} ms` : `shorter than our ${before} ms, ignored`),
    );
  }

  if (!dryRun) {
    await workDir.init();
    if (!resume) await workDir.resetCrawlState();
    if (policy.text !== null) await workDir.writeCrawlFile('robots.txt', policy.text);
    await workDir.writeCrawlFile('robots.parsed.json', `${JSON.stringify(summarisePolicy(policy), null, 2)}\n`);
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
    const detail = sitemap.error !== null ? `ERROR ${sitemap.error}` : `${sitemap.format}, ${sitemap.urlCount} urls, ${sitemap.childCount} children`;
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
    for (const entry of discovery.dropped.slice(0, 10)) logger.warn(`  ${entry.rawUrl} — ${entry.reason}`);
    if (discovery.dropped.length > 10) logger.warn(`  … and ${discovery.dropped.length - 10} more (see crawl-summary.json)`);
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
      { url: canonicaliseUrl(`${siteOrigin}/`, { sortQuery }), source: 'front-page-fallback', fromSitemap: '' },
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
  const truncated = allowed.length > maxPages ? { limit: maxPages, dropped: allowed.length - maxPages } : null;

  if (truncated !== null) {
    logger.info(
      `  capped at --max-pages=${maxPages} (--sample ${sample}); ` +
        `${truncated.dropped} of ${allowed.length} URL(s) not queued`,
    );
    // Show what the sample actually covers. On a partitioned sitemap index this
    // is the difference between a representative audit and 500 news articles.
    const perSitemap = new Map<string, number>();
    for (const candidate of queued) perSitemap.set(candidate.fromSitemap, (perSitemap.get(candidate.fromSitemap) ?? 0) + 1);
    for (const [sitemap, count] of perSitemap) {
      const available = allowed.filter((candidate) => candidate.fromSitemap === sitemap).length;
      logger.info(`    ${String(count).padStart(5)} of ${String(available).padEnd(6)} ${sitemap}`);
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

  for (const candidate of queued) {
    await frontier.add(candidate.url, pageIdFor(candidate.url), candidate.source);
  }

  const pending = frontier.pending();
  const alreadyDone = frontier.counts().done;
  if (resume && alreadyDone > 0) logger.info(`Resuming: ${alreadyDone} already fetched, ${pending.length} to go`);

  const estimateMs = pending.length * fetcher.hostDelay(new URL(siteOrigin).host);
  logger.info(`Fetching ${pending.length} page(s), ~${Math.ceil(estimateMs / 60000)} min at the current delay …`);

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
    await storeResult(workDir, frontier, item.url, item.page_id, item.source, record, summary, sortQuery);

    // Per-page progress. A long crawl is otherwise silent for over an hour,
    // which makes a wedged run indistinguishable from a slow one.
    const outcome = record.status ?? record.error?.kind ?? '—';
    const size = record.bytes > 0 ? `${(record.bytes / 1024).toFixed(1)} KB` : '';
    const note = record.redirectChain.length > 0 ? ` → ${record.finalUrl}` : '';
    logger.info(
      `  [${String(index).padStart(width)}/${total}] ${String(outcome).padEnd(7)}${size.padStart(9)}  ${item.url}${note}`,
    );
  }

  const counts = frontier.counts();
  summary.fetched = counts.done;
  summary.failed = counts.failed;
  summary.skipped = counts.skipped;
  summary.finished_at = new Date().toISOString();

  await workDir.writeRunSummary(summary as unknown as Record<string, unknown>);
  return summary;
}

async function storeResult(
  workDir: WorkDir,
  frontier: Frontier,
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

  const pageRecord: PageRecord = {
    page_id: pageId,
    url,
    canonical_url: canonical.ok ? canonical.url : record.finalUrl,
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
    errors,
  };

  const meta = {
    ...pageRecord,
    requested_url: record.requestedUrl,
    headers: record.headers,
    attempts: record.attempts,
    elapsed_ms: record.elapsedMs,
  };

  if (record.body !== null) {
    await workDir.savePage(pageId, record.body, meta);
    await frontier.markDone(url);
  } else {
    await workDir.saveFailedPage(pageId, meta);
    // A non-2xx or wrong content-type is a *skip* — expected, recorded, not a
    // malfunction. A timeout or network failure is a genuine failure.
    if (record.error === null || record.error.kind === 'content-type-rejected') {
      await frontier.markSkipped(url, errors.join('; ') || 'no body');
    } else {
      await frontier.markFailed(url, errors.join('; '));
    }
  }

  await workDir.appendPageRecord(pageRecord);
  summary.fetched = frontier.counts().done;
}

export { RobotsUnavailableError, CrawlAbortedError };
