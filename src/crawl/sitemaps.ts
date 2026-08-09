/**
 * Sitemap discovery and flattening.
 *
 * Seeding order (`dev-notes/02`, amended 2026-08-01):
 *
 *   1. `--sitemap` on the command line, if given. Suppresses everything below.
 *   2. `Sitemap:` directives from robots.txt.
 *   3. Only if robots.txt declared none, probe the well-known paths.
 *
 * Sitemaps in the wild are considerably messier than `<urlset>` and
 * `<sitemapindex>`. This module also handles gzip, plain-text sitemaps, RSS and
 * Atom, index recursion, cycles, and hosts that answer `/sitemap.xml` with a
 * 200 and an HTML "page not found".
 */

import zlib from 'node:zlib';
import { promisify } from 'node:util';

import { XMLParser, XMLValidator } from 'fast-xml-parser';

import type { PoliteFetcher } from '../net/fetcher.ts';
import { tryCanonicaliseUrl } from '../url/canonical.ts';

const gunzip = promisify(zlib.gunzip);

/** Probed only when robots.txt declares no sitemaps at all. */
export const WELL_KNOWN_SITEMAP_PATHS: readonly string[] = [
  '/sitemap.xml',
  '/sitemap_index.xml',
  '/sitemap-index.xml',
  '/wp-sitemap.xml',
  '/sitemap/sitemap.xml',
];

/** Uncompressed cap. The sitemaps.org limit is 50 MB; a gzip bomb is not our problem to absorb. */
const MAX_UNCOMPRESSED_BYTES = 50 * 1024 * 1024;

export type SitemapSource = 'cli' | 'robots' | 'probed';

export type SitemapFormat = 'urlset' | 'sitemapindex' | 'rss' | 'atom' | 'text';

export interface FetchedSitemap {
  url: string;
  source: SitemapSource;
  depth: number;
  httpStatus: number | null;
  /** Null when the fetch or parse failed. */
  format: SitemapFormat | null;
  gzipped: boolean;
  bytes: number;
  /** Page URLs found directly in this sitemap. */
  urlCount: number;
  /** Child sitemaps found directly in this sitemap. */
  childCount: number;
  redirected: boolean;
  finalUrl: string;
  error: string | null;
}

export interface SitemapEntry {
  /** Canonicalised. This is the identity used everywhere downstream. */
  url: string;
  /** Exactly as written in the sitemap, for the report. */
  rawUrl: string;
  lastmod: string | null;
  /** Which sitemap it came from — provenance is mandatory. */
  fromSitemap: string;
}

export interface DroppedEntry {
  rawUrl: string;
  fromSitemap: string;
  reason: string;
}

/**
 * Kept, but on a different spelling of the host than we were given — the site's
 * own sitemap disagrees with the operator about where it lives. A finding in its
 * own right, per the URL-hygiene checks.
 */
export interface HostDivergence {
  rawUrl: string;
  fromSitemap: string;
  crawlHost: string;
  entryHost: string;
}

/**
 * Are two hosts the same site?
 *
 * The cross-host filter exists to stop a cross-submitted sitemap turning a
 * one-site audit into an open crawl of somebody else's server.
 * `www.example.com` is not somebody else's server, and treating it as one
 * dropped every URL of a real site and left us auditing its front page alone.
 *
 * Only the `www.` prefix is forgiven. Anything else — a different subdomain, a
 * different domain — stays cross-host, because those genuinely can be someone
 * else's. Doing this properly by registrable domain would need a public suffix
 * list (`example.co.uk` is not `co.uk`), which is not worth a dependency for
 * the one case that actually occurs.
 */
export function isSameSiteHost(left: string, right: string): boolean {
  const strip = (host: string): string => host.replace(/^www\./i, '');
  return strip(left.toLowerCase()) === strip(right.toLowerCase());
}

export interface SitemapDiscovery {
  /** Every sitemap we touched, in the order we touched them. */
  sitemaps: FetchedSitemap[];
  /** Deduplicated page URLs, in sitemap document order. */
  urls: SitemapEntry[];
  dropped: DroppedEntry[];
  /** Kept, but on a `www.`/bare variant of the host we were given. */
  hostDivergence: HostDivergence[];
  errors: string[];
}

export interface DiscoverOptions {
  /** Explicit `--sitemap` values. Suppresses robots directives and probing. */
  cliSitemaps?: readonly string[];
  /** `Sitemap:` directives from robots.txt. */
  robotsSitemaps?: readonly string[];
  /** How deep to follow sitemap indexes. Default 3. */
  maxDepth?: number;
  /** Refuse to fetch more than this many sitemap documents. Default 200. */
  maxSitemaps?: number;
  /**
   * Called with each sitemap body as it arrives, decompressed, so the caller
   * can write it to `crawl/sitemaps/`. A callback rather than a return value:
   * a large index can run to tens of megabytes and there is no reason to hold
   * all of it in memory at once.
   */
  onSitemapBody?: (url: string, body: Buffer, index: number) => Promise<void>;
}

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  trimValues: true,
  // Sitemaps are namespaced, and image/video/news extensions add prefixes.
  // Stripping them means `<loc>` is `loc` regardless of how it was declared.
  removeNSPrefix: true,
  isArray: (name) => ['url', 'sitemap', 'item', 'entry'].includes(name),
  parseTagValue: false,
  parseAttributeValue: false,
});

/** gzip magic bytes. More reliable than either the extension or the Content-Type. */
function looksGzipped(body: Buffer): boolean {
  return body.length >= 2 && body[0] === 0x1f && body[1] === 0x8b;
}

async function decompressIfNeeded(body: Buffer): Promise<{ body: Buffer; gzipped: boolean }> {
  if (!looksGzipped(body)) return { body, gzipped: false };

  const inflated = await gunzip(body, { maxOutputLength: MAX_UNCOMPRESSED_BYTES });
  return { body: Buffer.isBuffer(inflated) ? inflated : Buffer.from(inflated), gzipped: true };
}

function textOf(value: unknown): string | null {
  if (typeof value === 'string') return value.trim() === '' ? null : value.trim();
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  // fast-xml-parser gives `{ '#text': ..., '@_attr': ... }` for mixed content.
  if (value !== null && typeof value === 'object' && '#text' in value) {
    return textOf((value as Record<string, unknown>)['#text']);
  }
  return null;
}

function asArray(value: unknown): unknown[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

interface ParsedSitemap {
  format: SitemapFormat;
  /** Page URLs, as written. */
  urls: { raw: string; lastmod: string | null }[];
  /** Child sitemap URLs, as written. */
  children: string[];
  /**
   * Set when the document is not well-formed XML. Reported as a finding, but
   * NOT fatal — see the note on lenient parsing below.
   */
  malformed: string | null;
}

/**
 * Parse a sitemap body into page URLs and child sitemaps.
 * @throws {Error} when the body is not a sitemap in any recognised form.
 */
export function parseSitemap(body: Buffer): ParsedSitemap {
  const text = body
    .toString('utf8')
    .replace(/^\uFEFF/, '')
    .trim();

  if (text === '') throw new Error('empty sitemap body');

  // A great many hosts answer /sitemap.xml with 200 and their HTML 404 page.
  // Treating that as a sitemap produces confusing downstream errors.
  if (/^<(?:!doctype\s+html|html[\s>])/i.test(text)) {
    throw new Error('body is an HTML document, not a sitemap');
  }

  if (!text.startsWith('<')) {
    // Plain-text sitemap: one URL per line. The protocol permits this.
    const urls = text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line !== '' && !line.startsWith('#'))
      .map((raw) => ({ raw, lastmod: null }));

    if (urls.length === 0) throw new Error('no URLs in plain-text sitemap');
    return { format: 'text', urls, children: [], malformed: null };
  }

  // Validate for *reporting*, then parse leniently regardless.
  //
  // Strict rejection is not an option: an unescaped `&` in a query string fails
  // XML validation and is endemic in real sitemaps. Refusing the document would
  // silently drop an entire site's URL list over one stray character. So the
  // malformedness becomes a finding, and we still harvest what we can.
  const validation = XMLValidator.validate(text);
  const malformed =
    validation === true
      ? null
      : `malformed XML: ${validation.err.msg} (line ${validation.err.line})`;

  let document: Record<string, unknown>;
  try {
    document = xmlParser.parse(text) as Record<string, unknown>;
  } catch (error) {
    throw new Error(`XML parse failed: ${error instanceof Error ? error.message : String(error)}`, {
      cause: error,
    });
  }

  if (document['sitemapindex'] !== undefined) {
    const index = document['sitemapindex'] as Record<string, unknown>;
    const children = asArray(index['sitemap'])
      .map((entry) => textOf((entry as Record<string, unknown>)['loc']))
      .filter((loc): loc is string => loc !== null);
    return { format: 'sitemapindex', urls: [], children, malformed };
  }

  if (document['urlset'] !== undefined) {
    const set = document['urlset'] as Record<string, unknown>;
    const urls = asArray(set['url'])
      .map((entry) => {
        const record = entry as Record<string, unknown>;
        const raw = textOf(record['loc']);
        return raw === null ? null : { raw, lastmod: textOf(record['lastmod']) };
      })
      .filter((entry): entry is { raw: string; lastmod: string | null } => entry !== null);
    return { format: 'urlset', urls, children: [], malformed };
  }

  if (document['rss'] !== undefined) {
    const channel = (document['rss'] as Record<string, unknown>)['channel'] as
      Record<string, unknown> | undefined;
    const urls = asArray(channel?.['item'])
      .map((entry) => {
        const record = entry as Record<string, unknown>;
        const raw = textOf(record['link']);
        return raw === null ? null : { raw, lastmod: textOf(record['pubDate']) };
      })
      .filter((entry): entry is { raw: string; lastmod: string | null } => entry !== null);
    return { format: 'rss', urls, children: [], malformed };
  }

  if (document['feed'] !== undefined) {
    const feed = document['feed'] as Record<string, unknown>;
    const urls = asArray(feed['entry'])
      .map((entry) => {
        const record = entry as Record<string, unknown>;
        // Atom puts the URL in an attribute, and an entry may carry several
        // links; the one without a rel, or with rel="alternate", is the page.
        const links = asArray(record['link']);
        for (const link of links) {
          const linkRecord = link as Record<string, unknown>;
          const rel = linkRecord['@_rel'];
          if (rel === undefined || rel === 'alternate') {
            const href = linkRecord['@_href'];
            if (typeof href === 'string' && href.trim() !== '') {
              return { raw: href.trim(), lastmod: textOf(record['updated']) };
            }
          }
        }
        return null;
      })
      .filter((entry): entry is { raw: string; lastmod: string | null } => entry !== null);
    return { format: 'atom', urls, children: [], malformed };
  }

  throw new Error(`unrecognised root element: ${Object.keys(document).join(', ') || 'none'}`);
}

interface QueueItem {
  url: string;
  source: SitemapSource;
  depth: number;
}

/**
 * Discover every sitemap for a site and flatten it to a deduplicated,
 * document-ordered list of page URLs on the crawl host.
 */
export async function discoverSitemaps(
  fetcher: PoliteFetcher,
  siteOrigin: string,
  options: DiscoverOptions = {},
): Promise<SitemapDiscovery> {
  const {
    cliSitemaps = [],
    robotsSitemaps = [],
    maxDepth = 3,
    maxSitemaps = 200,
    onSitemapBody,
  } = options;

  const siteHost = new URL(siteOrigin).host;
  const sitemaps: FetchedSitemap[] = [];
  const dropped: DroppedEntry[] = [];
  const hostDivergence: HostDivergence[] = [];
  const errors: string[] = [];
  /** Insertion-ordered, so the URL list stays in sitemap document order. */
  const urls = new Map<string, SitemapEntry>();

  const queue: QueueItem[] = [];
  const seen = new Set<string>();

  const enqueue = (rawUrl: string, source: SitemapSource, depth: number): void => {
    const canonical = tryCanonicaliseUrl(rawUrl);
    if (!canonical.ok) {
      errors.push(`unusable sitemap URL ${JSON.stringify(rawUrl)}: ${canonical.reason}`);
      return;
    }
    if (seen.has(canonical.url)) return;
    seen.add(canonical.url);
    queue.push({ url: canonical.url, source, depth });
  };

  // Seeding. `--sitemap` is an override, not an addition: if you named the
  // sitemaps, you get exactly those.
  let probing = false;
  if (cliSitemaps.length > 0) {
    for (const url of cliSitemaps) enqueue(url, 'cli', 0);
  } else if (robotsSitemaps.length > 0) {
    for (const url of robotsSitemaps) enqueue(url, 'robots', 0);
  } else {
    probing = true;
    for (const path of WELL_KNOWN_SITEMAP_PATHS) enqueue(`${siteOrigin}${path}`, 'probed', 0);
  }

  while (queue.length > 0) {
    if (sitemaps.length >= maxSitemaps) {
      errors.push(
        `stopped after ${maxSitemaps} sitemaps; the remaining ${queue.length} were not fetched`,
      );
      break;
    }

    const item = queue.shift();
    if (item === undefined) break;

    const record = await fetcher.fetch(item.url, {
      // Sitemaps are served as application/xml, text/xml, text/plain,
      // application/gzip, application/octet-stream and occasionally text/html.
      // The Content-Type is not worth refusing over; the body tells the truth.
      accept: [],
      acceptHeader: 'application/xml,text/xml,application/gzip;q=0.9,*/*;q=0.5',
    });

    const entry: FetchedSitemap = {
      url: item.url,
      source: item.source,
      depth: item.depth,
      httpStatus: record.status,
      format: null,
      gzipped: false,
      bytes: record.bytes,
      urlCount: 0,
      childCount: 0,
      redirected: record.redirectChain.length > 0,
      finalUrl: record.finalUrl,
      error: null,
    };

    if (record.error !== null) {
      entry.error = `${record.error.kind}: ${record.error.message}`;
    } else if (record.status !== null && (record.status < 200 || record.status >= 300)) {
      entry.error = `HTTP ${record.status}`;
    } else if (record.body === null) {
      entry.error = record.notFetchedReason ?? 'no body';
    } else {
      try {
        const { body, gzipped } = await decompressIfNeeded(record.body);
        entry.gzipped = gzipped;

        if (onSitemapBody !== undefined) await onSitemapBody(item.url, body, sitemaps.length);

        const parsed = parseSitemap(body);
        entry.format = parsed.format;
        // Not fatal: a malformed document that still yielded URLs is a finding
        // to report, not a reason to discard what we recovered from it.
        entry.error = parsed.malformed;
        entry.urlCount = parsed.urls.length;
        entry.childCount = parsed.children.length;

        for (const child of parsed.children) {
          if (item.depth >= maxDepth) {
            errors.push(`sitemap index depth limit (${maxDepth}) reached; not following ${child}`);
            continue;
          }
          enqueue(child, item.source, item.depth + 1);
        }

        for (const found of parsed.urls) {
          const canonical = tryCanonicaliseUrl(found.raw);
          if (!canonical.ok) {
            dropped.push({ rawUrl: found.raw, fromSitemap: item.url, reason: canonical.reason });
            continue;
          }
          const entryHost = new URL(canonical.url).host;
          if (entryHost !== siteHost) {
            if (!isSameSiteHost(entryHost, siteHost)) {
              // Cross-submission is legal, but following it silently turns a
              // one-site audit into an open crawl of somebody else's server.
              dropped.push({
                rawUrl: found.raw,
                fromSitemap: item.url,
                reason: `cross-host: ${entryHost} is not ${siteHost}`,
              });
              continue;
            }
            // Same site, different spelling of the host. Crawl it — but record
            // the disagreement, because it fractures entity identity.
            hostDivergence.push({
              rawUrl: found.raw,
              fromSitemap: item.url,
              crawlHost: siteHost,
              entryHost,
            });
          }
          if (!urls.has(canonical.url)) {
            urls.set(canonical.url, {
              url: canonical.url,
              rawUrl: found.raw,
              lastmod: found.lastmod,
              fromSitemap: item.url,
            });
          }
        }
      } catch (error) {
        entry.error = error instanceof Error ? error.message : String(error);
      }
    }

    // A probe missing is expected and uninteresting. A declared sitemap
    // failing is a finding, and must reach the report.
    const isExpectedProbeMiss =
      probing && (entry.httpStatus === 404 || entry.httpStatus === 410 || entry.error !== null);
    if (entry.error !== null && !isExpectedProbeMiss) {
      errors.push(`${item.url}: ${entry.error}`);
    } else if (entry.httpStatus !== null && entry.httpStatus !== 200 && !isExpectedProbeMiss) {
      errors.push(`${item.url}: HTTP ${entry.httpStatus}`);
    }

    sitemaps.push(entry);
  }

  return { sitemaps, urls: [...urls.values()], dropped, hostDivergence, errors };
}
