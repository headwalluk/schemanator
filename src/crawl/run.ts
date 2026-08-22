/**
 * The crawl: seed, filter, fetch, store.
 *
 * The sitemap is the sample, plus **one hop** out of it: internal URLs that are
 * linked from a sitemap page but listed in no sitemap. Those are not sample
 * members — they are the evidence that makes a claim about the sample
 * trustworthy. Without them "nothing links to this page" cannot be
 * distinguished from "the page that links to it was never fetched", which on
 * the first real site measured was a 37% false-positive rate (`dev-notes/11`).
 *
 * It stops there. Following the hop's own links would be a general web crawler,
 * which is a different tool with a different politeness argument.
 */

import { CrawlAbortedError, PoliteFetcher, type FetchRecord } from '../net/fetcher.ts';
import { canonicaliseUrl, tryCanonicaliseUrl } from '../url/canonical.ts';
import { collectLinkTargets, loadDom } from '../extract/page-facts.ts';
import { Frontier, type FrontierItem } from './frontier.ts';
import {
  fetchRobots,
  RobotsUnavailableError,
  summarisePolicy,
  type RobotsPolicy,
} from './robots.ts';
import { discoverSitemaps, type SitemapDiscovery } from './sitemaps.ts';
import {
  LINK_HOP_SOURCE,
  pageIdFor,
  sha256,
  SITEMAP_SOURCE,
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
  /** Follow internal links out of the sitemap. Default true — see {@link DEFAULT_LINK_HOP_PAGES}. */
  linkHop?: boolean;
  /** Cap on the hop, separate from {@link DEFAULT_MAX_PAGES} on purpose. */
  linkHopPages?: number;
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
   * The one hop out of the sitemap. `null` when it was disabled.
   *
   * **Absent on a crawl older than 1.13.0, and that is not the same as
   * disabled.** The link checks must treat a missing key as *unknown* and
   * qualify themselves by coverage: on a sitemap-only crawl every unlisted page
   * is invisible, so "nothing links here" cannot be distinguished from "the
   * page that links here was never fetched" — which is the whole reason the hop
   * exists (`dev-notes/11`). It takes a re-crawl to fill in.
   */
  link_hop?: {
    /** Distinct internal URLs linked from sitemap pages that no sitemap lists. */
    discovered: number;
    queued: number;
    /**
     * Refused by robots.txt. **Not the same as `dropped`**, and the split is
     * not pedantry: the first live run of the hop reported "2 not followed —
     * raise --link-hop-pages" against a cap of 50 that was nowhere near biting.
     * Both were `/basket/` and `/account/`, `Disallow`ed, and no cap would ever
     * have fetched them. Advice that names the wrong constraint sends somebody
     * to change a setting that cannot help.
     */
    disallowed: number;
    /** Over `--link-hop-pages`. Raising it would fetch these. */
    dropped: number;
    /**
     * Linked, unlisted, and not an HTML page — never requested at all.
     *
     * Counted rather than silently discarded, and kept out of `discovered` on
     * purpose: `discovered` feeds the "use --link-hop-pages N" advice, and a
     * number inflated with image links names a setting that would not close the
     * graph. Absent on a crawl older than this fix.
     */
    non_page: number;
  } | null;
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
  /**
   * Pages in the manifest — which is **not** `fetched`.
   *
   * `fetched` counts requests that succeeded, and since 1.12.0 two requests can
   * land on one page: a sitemap listing both a redirecting URL and its
   * destination produces two fetches and one record. Reporting the request count
   * as "stored" is a number that cannot be true, which is the exact fault the
   * release this shipped in was written to remove.
   */
  pages_stored: number;
  failed: number;
  skipped: number;
  aborted: string | null;
  started_at: string;
  finished_at: string;
}

const HTML_TYPES = ['text/html', 'application/xhtml+xml'];

/**
 * How many pages a crawl takes when nobody says otherwise.
 *
 * A hundred, because the job of the default is to see **several instances of
 * every content type**, and under `spread` sampling that is governed by how
 * many sitemaps a site partitions into, not by the total. Six groups — posts,
 * pages, products, categories, tags, authors — is a typical WordPress site,
 * and a hundred pages is sixteen of each. Divergence under a shared `@id`
 * shows up in the first handful; the next four hundred pages restate it.
 *
 * It was 500 until 1.13.0, chosen when the cap was purely a time-and-politeness
 * knob. At one request per second 500 pages is nine minutes, which outlives
 * most agent shell timeouts, and an audit nobody waits for is worth nothing.
 * A hundred is under two minutes.
 *
 * What this costs is bought back by a flag: cross-page checks such as
 * `indexing.duplicate-content` need both halves of a pair in the sample, and a
 * lower cap means more sites fall under {@link SAMPLING_WARNING_SHARE}. That
 * warning is the whole mitigation — it names the checks that weaken, and
 * raising `--max-pages` is one argument away.
 */
export const DEFAULT_MAX_PAGES = 100;

/**
 * Extensions the hop will not spend a request on.
 *
 * The hop exists to fetch unlisted *pages*, because a page might hold the link
 * that proves another page is not an orphan. A PNG holds no links, and the
 * fetcher refuses it on Content-Type the moment the headers arrive — so
 * requesting one is a request nobody needed, made against somebody else's
 * server, and `02` is emphatic about that.
 *
 * **Measured on a real 150-page site, 2026-08-22: 30 of 50 hop slots went to
 * `.png`, `.jpeg` and `.pdf` while 70 unlisted pages were dropped for want of
 * budget.** That is not bad luck. The hop ranks candidates most-linked-first,
 * and the most-linked unlisted URLs on a WordPress site are sitewide asset
 * links — a certificate logo in the footer outranks every real page — so images
 * sort straight to the top of the queue. The group the hop exists to serve was
 * starved by its own ranking.
 *
 * **Sitemap URLs are deliberately *not* filtered this way.** A sitemap entry is
 * the site asking for that URL to be indexed, so a PDF listed in one is a fact
 * worth fetching and reporting — `indexing.sitemap-dead-url` and
 * `indexing.thin-sitemap-entry` both have things to say about it. The hop is
 * speculative and the sitemap is a request; only the speculative half guesses.
 *
 * Extension-only, and conservative by design. An extensionless URL is a page,
 * and so are `.html`, `.php` and `.aspx`. Anything ambiguous stays in: a wrong
 * exclusion costs a page that is never audited, which is worse than a wrong
 * inclusion costing one request.
 */
const NON_PAGE_EXTENSIONS = new Set([
  // Images. 29 of the 30 wasted slots on the site that exposed this.
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
  'avif',
  'svg',
  'bmp',
  'ico',
  'tif',
  'tiff',
  // Documents. A PDF is the one a site is most likely to link from body copy.
  'pdf',
  'doc',
  'docx',
  'xls',
  'xlsx',
  'ppt',
  'pptx',
  'odt',
  'ods',
  'odp',
  'rtf',
  'csv',
  // Archives and installers.
  'zip',
  'gz',
  'tgz',
  'bz2',
  'xz',
  'rar',
  '7z',
  'exe',
  'dmg',
  'pkg',
  'deb',
  'rpm',
  // Media.
  'mp3',
  'wav',
  'ogg',
  'm4a',
  'flac',
  'mp4',
  'm4v',
  'mov',
  'avi',
  'wmv',
  'webm',
  'mkv',
  // Assets and data. `.xml` covers a sitemap the hop has no business re-fetching.
  'css',
  'js',
  'mjs',
  'json',
  'xml',
  'rss',
  'atom',
  'txt',
  'map',
  // Fonts.
  'woff',
  'woff2',
  'ttf',
  'otf',
  'eot',
]);

/**
 * Could this URL be an HTML page?
 *
 * Judged on the path's extension alone — no request, no HEAD, no guessing from
 * the link text. Anything without a recognised non-page extension is treated as
 * a page, which is the safe direction to be wrong in.
 */
export function couldBeAPage(url: string): boolean {
  let pathname: string;
  try {
    pathname = new URL(url).pathname;
  } catch {
    return false;
  }

  const lastSegment = pathname.split('/').pop() ?? '';
  const dot = lastSegment.lastIndexOf('.');
  // `dot <= 0` covers both "no extension" and a leading-dot name.
  if (dot <= 0) return true;

  return !NON_PAGE_EXTENSIONS.has(lastSegment.slice(dot + 1).toLowerCase());
}

/**
 * How many unlisted pages the link hop may fetch, on top of `--max-pages`.
 *
 * **A separate budget, deliberately.** `--max-pages` is a sample of the site;
 * these are not sample members, they are *evidence about* the sample — the
 * pages that hold the inbound links. Sharing one cap means an audited page
 * drops out to make room for a footer link, which is the wrong trade every
 * time.
 *
 * Fifty is a **politeness default, not a sufficient one**, and the difference
 * matters because group `link` goes silent when this cap bites.
 *
 * It was chosen believing the unlisted set stays small — section indexes, tag
 * pages, pagination — and that it does not scale with the site the way the
 * sitemap does. **The corpus shakedown falsified that**: 21 unlisted URLs on a
 * 54-page site, and 832 on a 564-page shop, which generates `/product-tag/`,
 * `/brand/` and similar taxonomy archives in bulk and lists none of them. It
 * scales *faster* than the sitemap.
 *
 * So on a large site the default cannot close the graph, and 50 stays the
 * default anyway: the alternative is a tool that quietly makes several hundred
 * extra requests to somebody's server because a check wanted them. The crawl
 * prints the number that would close it instead, and the choice stays with the
 * person whose bandwidth it is.
 *
 * When the cap does bite, the most-linked candidates are kept — a page linked
 * from everywhere is the one most likely to explain an orphan (`dev-notes/11`).
 */
export const DEFAULT_LINK_HOP_PAGES = 50;

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
 * sitemap of 1,031. Under document order, `--max-pages 100` takes 100 news
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
    maxPages = DEFAULT_MAX_PAGES,
    sample = 'spread',
    maxDepth = 3,
    delayMs = 1000,
    dryRun = false,
    resume = false,
    sortQuery = true,
    linkHop = true,
    linkHopPages = DEFAULT_LINK_HOP_PAGES,
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
    source: `${SITEMAP_SOURCE}${entry.fromSitemap}`,
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
    // is the difference between a representative audit and 100 news articles.
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

    /**
     * Group `link` is silenced by a cap, not merely weakened by it, so the cap
     * has to say so at any size — the warning above only fires below half.
     *
     * "Nothing links to this page" is an absence claim over the *whole* site,
     * and every URL the cap dropped is a page free to hold the link that would
     * disprove it. Naming the number that would lift the silence is the
     * difference between a silence somebody can act on and one they read as a
     * pass.
     */
    logger.info(
      `  group link is silent on a capped crawl: "nothing links here" cannot be true of a site ` +
        `only ${queued.length} of ${allowed.length} pages were seen of. Use --max-pages ${allowed.length} for it`,
    );
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
    pages_stored: 0,
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

  const siteHost = new URL(siteOrigin).host;
  const estimateMs = pending.length * fetcher.hostDelay(siteHost);
  logger.info(
    `Fetching ${pending.length} page(s), ~${Math.ceil(estimateMs / 60000)} min at the current delay …`,
  );

  /**
   * Every internal URL linked from a page we fetched: how many pages link to
   * it, and the first one that did.
   *
   * The count is the ranking that survives the hop's cap. `from` becomes the
   * fetched page's `source`, so a URL in the manifest that no sitemap lists can
   * still say why it is there — provenance is mandatory (`01`), and "because
   * something linked to it" is not an answer without the something.
   */
  const linkedTargets = new Map<string, { count: number; from: string }>();

  /**
   * Progress counts across both rounds rather than restarting.
   *
   * The hop's size is unknowable until the first round finishes — it is a fact
   * about the pages, not about the site — so `total` grows once, mid-crawl.
   * That is honest; resetting the numerator to zero for a second round is not,
   * and `status` prints this straight to somebody watching a detached run.
   */
  let total = pending.length;
  let index = 0;
  let aborted = false;

  const fetchRound = async (items: readonly FrontierItem[]): Promise<void> => {
    const width = String(total).length;

    for (const item of items) {
      index += 1;

      let record: FetchRecord;
      try {
        record = await fetcher.fetch(item.url, { accept: HTML_TYPES });
      } catch (error) {
        if (error instanceof CrawlAbortedError) {
          summary.aborted = error.message;
          logger.error(error.message);
          aborted = true;
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

      /**
       * Collect link targets while the body is still in memory.
       *
       * The crawl does not otherwise parse HTML — `03` gives that job to
       * extraction, and this does not take it back: no blocks, no anchor text,
       * no chrome. Only "which internal URLs does this page point at", which
       * the hop needs *now* and extraction cannot answer until the crawl is
       * over. One cheap parse against a one-second delay is free, and
       * `resolveHref` is shared so the two layers cannot disagree about what
       * counts as internal.
       */
      if (record.body !== null && !item.source.startsWith(LINK_HOP_SOURCE)) {
        // `utf8` to match `readPageHtml`, so the hop sees exactly the bytes
        // extraction will see later rather than a second decoding of them.
        const dom = loadDom(record.body.toString('utf8'));
        for (const target of collectLinkTargets(dom, record.finalUrl, siteHost)) {
          const canonical = tryCanonicaliseUrl(target, { sortQuery });
          if (!canonical.ok) continue;
          const seen = linkedTargets.get(canonical.url);
          if (seen === undefined) {
            linkedTargets.set(canonical.url, { count: 1, from: item.page_id });
          } else {
            seen.count += 1;
          }
        }
      }

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
  };

  await fetchRound(pending);

  // --- the one hop out of the sitemap ------------------------------------
  if (!linkHop) {
    summary.link_hop = null;
  } else if (!aborted) {
    /**
     * Everything a sitemap listed, **not** everything the sample kept.
     *
     * `candidates` rather than `queued`, and the difference is the whole check:
     * a hop target is a URL *in no sitemap*, which is a fact about the site. A
     * sitemap URL that lost the `--max-pages` lottery is still in a sitemap.
     *
     * Keyed on `queued` this was invisible on the site it was built against —
     * 54 URLs under a cap of 100, so the two sets were identical. A dry run of
     * a larger site is what exposed it: 564 URLs discovered and 100 sampled, so
     * 464 sitemap URLs would have read as "linked but unlisted" and the hop
     * would have spent its entire budget re-fetching pages the sample had
     * deliberately dropped — then excluded them from the audit for being hop
     * pages. Wasted requests against somebody else's server, and a
     * `link_hop.discovered` that measured the cap rather than the site.
     */
    const known = new Set<string>();
    for (const candidate of candidates) known.add(candidate.url);
    for (const record of records.values()) {
      known.add(record.canonical_url);
      known.add(record.url);
    }

    const offSitemap = [...linkedTargets.entries()].filter(([url]) => !known.has(url));
    // Assets are removed before anything is counted, so every number below
    // describes pages. See `NON_PAGE_EXTENSIONS`.
    const unlisted = offSitemap.filter(([url]) => couldBeAPage(url));
    const nonPage = offSitemap.length - unlisted.length;
    const allowedUnlisted = unlisted.filter(([url]) => policy.isAllowed(url));

    /**
     * Most-linked first, then alphabetical.
     *
     * The tie-break is not cosmetic: two runs of the same site must queue the
     * same pages or `--since` reports a diff that is really a sort order.
     */
    const ranked = allowedUnlisted.sort(
      ([leftUrl, left], [rightUrl, right]) =>
        right.count - left.count || leftUrl.localeCompare(rightUrl),
    );
    const hopQueue = ranked.slice(0, linkHopPages);

    summary.link_hop = {
      discovered: unlisted.length,
      queued: hopQueue.length,
      disallowed: unlisted.length - allowedUnlisted.length,
      dropped: allowedUnlisted.length - hopQueue.length,
      non_page: nonPage,
    };

    if (hopQueue.length > 0) {
      logger.info(
        `  ${unlisted.length} internal URL(s) linked but in no sitemap; ` +
          `following ${hopQueue.length}`,
      );
      // Two reasons a URL is not followed, and only one of them is a setting.
      if (summary.link_hop.disallowed > 0) {
        logger.info(`    ${summary.link_hop.disallowed} excluded by robots.txt`);
      }
      // Said out loud rather than quietly dropped: a reader comparing this
      // against the site's own link count needs to know where the difference
      // went, and "we ignored 97 of them" is not a detail to leave implicit.
      if (nonPage > 0) {
        logger.info(`    ${nonPage} skipped as images, documents or other non-pages`);
      }
      if (summary.link_hop.dropped > 0) {
        // Name the number that closes the graph, for the same reason the page
        // cap does: group `link` is silent while any of these are unfetched, and
        // a silence nobody can act on reads as a pass.
        const needed = summary.link_hop.queued + summary.link_hop.dropped;
        logger.info(
          `    ${summary.link_hop.dropped} over --link-hop-pages=${linkHopPages}; group link stays ` +
            `silent until every linked page is fetched — use --link-hop-pages ${needed} for it`,
        );
      }

      for (const [url, target] of hopQueue) {
        await frontier.add(url, pageIdFor(url), `${LINK_HOP_SOURCE}${target.from}`);
      }

      const hopPending = frontier.pending();
      total += hopPending.length;
      await fetchRound(hopPending);
    }
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
  /**
   * Records that actually hold a page, not manifest rows.
   *
   * A 404 and a refused Content-Type each get a manifest row — `01` wants the
   * failure inspectable — but neither stored anything: no HTML on disk, no
   * hash, nothing for extraction to read. Counting rows made the crawl's own
   * closing line contradict itself, on a real site: *"200 page(s) requested
   * this run. 199 stored, 30 skipped"*, where 199 and 30 are 229 of 200,
   * because every skip was counted twice. The true figure was 169.
   *
   * `content_sha256` is the discriminator because it is null exactly when no
   * body was kept, which is the definition of not stored.
   */
  summary.pages_stored = reconciled.filter((record) => record.content_sha256 !== null).length;

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
