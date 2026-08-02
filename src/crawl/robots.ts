/**
 * robots.txt fetching and policy.
 *
 * The failure policy here is the one that matters, and it is asymmetric on
 * purpose (RFC 9309 §2.3.1, and `dev-notes/02`):
 *
 *   - **4xx** — the file genuinely is not there. No restrictions. Crawl.
 *   - **5xx, timeout, connection refused** — assume *complete disallow*, and
 *     refuse to crawl at all.
 *
 * The tempting reading of an unreachable robots.txt is "no rules, crawl
 * freely". It is backwards. A 503 on robots.txt is usually a WAF, a
 * rate-limiter or an overloaded host — precisely the moment to back off.
 */

import robotsParserImport from 'robots-parser';

import type { FetchRecord, PoliteFetcher, RedirectHop } from '../net/fetcher.ts';
import { tryCanonicaliseUrl } from '../url/canonical.ts';

interface ParsedRobots {
  isAllowed(url: string, userAgent?: string): boolean | undefined;
  getCrawlDelay(userAgent?: string): number | undefined;
  getSitemaps(): string[];
}

/**
 * robots-parser is CommonJS (`module.exports = fn`) but ships a `.d.ts` written
 * as an ESM default export. Node's interop hands us the function; TypeScript's
 * nodenext resolution disagrees. Narrow it once, here, rather than at each use.
 */
const robotsParser = robotsParserImport as unknown as (url: string, contents: string) => ParsedRobots;

/** The product token we match robots.txt `User-agent` groups against. */
export const ROBOTS_USER_AGENT = 'schemanator';

export class RobotsUnavailableError extends Error {
  readonly robotsUrl: string;
  readonly detail: string;

  constructor(robotsUrl: string, detail: string) {
    super(
      `refusing to crawl: ${robotsUrl} could not be read (${detail}). ` +
        'A server error on robots.txt is treated as a complete disallow, per RFC 9309.',
    );
    this.name = 'RobotsUnavailableError';
    this.robotsUrl = robotsUrl;
    this.detail = detail;
  }
}

export interface RobotsPolicy {
  /** Whether robots.txt was found, or absent and therefore permissive. */
  source: 'fetched' | 'absent';
  robotsUrl: string;
  /**
   * The origin the crawl should actually use. If `example.com/robots.txt`
   * redirects to `www.example.com/robots.txt`, `www` is the host that governs,
   * and it is the host whose sitemaps we should be probing.
   */
  siteOrigin: string;
  httpStatus: number | null;
  redirectChain: RedirectHop[];
  /** Verbatim, for `crawl/robots.txt`. Null when absent. */
  text: string | null;
  /** `Sitemap:` directives, canonicalised. Unparseable ones land in `errors`. */
  sitemaps: string[];
  /** `Crawl-delay` for our user-agent, in milliseconds. Null when unspecified. */
  crawlDelayMs: number | null;
  errors: string[];
  isAllowed(url: string): boolean;
}

/** The serialisable half, for `crawl/robots.parsed.json`. */
export function summarisePolicy(policy: RobotsPolicy): Record<string, unknown> {
  return {
    source: policy.source,
    robots_url: policy.robotsUrl,
    site_origin: policy.siteOrigin,
    http_status: policy.httpStatus,
    redirect_chain: policy.redirectChain,
    sitemaps: policy.sitemaps,
    crawl_delay_ms: policy.crawlDelayMs,
    user_agent_matched: ROBOTS_USER_AGENT,
    errors: policy.errors,
  };
}

/**
 * Resolve one `Sitemap:` directive.
 *
 * The directive is specified to carry an **absolute** URL, and we hold it to
 * that. Resolving relative values against the robots.txt URL would quietly turn
 * junk — `Sitemap: not a url` really does appear in the wild — into a
 * plausible-looking `https://host/not%20a%20url` that we would then go and
 * fetch. Better to record it as the malformed directive it is.
 *
 * The one concession is the protocol-relative form, which is unambiguous.
 */
function resolveSitemapDirective(
  declared: string,
  robotsUrl: string,
): { ok: true; url: string } | { ok: false; reason: string } {
  const trimmed = declared.trim();
  return trimmed.startsWith('//')
    ? tryCanonicaliseUrl(trimmed, { base: robotsUrl })
    : tryCanonicaliseUrl(trimmed);
}

function permissivePolicy(
  robotsUrl: string,
  siteOrigin: string,
  httpStatus: number | null,
  redirectChain: RedirectHop[],
  errors: string[],
): RobotsPolicy {
  return {
    source: 'absent',
    robotsUrl,
    siteOrigin,
    httpStatus,
    redirectChain,
    text: null,
    sitemaps: [],
    crawlDelayMs: null,
    errors,
    isAllowed: () => true,
  };
}

/**
 * Fetch and parse robots.txt for an origin.
 *
 * @throws {RobotsUnavailableError} when the file is unreadable for a reason
 *   that means we should not be crawling this site at all.
 */
export async function fetchRobots(fetcher: PoliteFetcher, startUrl: string): Promise<RobotsPolicy> {
  const origin = new URL(startUrl).origin;
  const robotsUrl = `${origin}/robots.txt`;
  const errors: string[] = [];

  const record: FetchRecord = await fetcher.fetch(robotsUrl, {
    // Servers serve robots.txt as text/plain, text/html, application/octet-stream
    // and worse. The content-type is not worth refusing over.
    accept: [],
    acceptHeader: 'text/plain,*/*;q=0.5',
  });

  // The host that actually served robots.txt is the host that governs. This is
  // the common `example.com` -> `www.example.com` redirect, and getting it wrong
  // means probing sitemaps on a host that only ever redirects.
  const finalOrigin = new URL(record.finalUrl).origin;
  if (finalOrigin !== origin) {
    errors.push(`robots.txt redirected from ${origin} to ${finalOrigin}; adopting ${finalOrigin} as the site origin`);
  }

  if (record.error !== null && record.error.kind !== 'content-type-rejected') {
    throw new RobotsUnavailableError(robotsUrl, `${record.error.kind}: ${record.error.message}`);
  }

  const status = record.status;
  if (status !== null && status >= 500) {
    throw new RobotsUnavailableError(robotsUrl, `HTTP ${status}`);
  }

  if (status !== null && status >= 400) {
    // Genuinely absent. No restrictions.
    return permissivePolicy(record.finalUrl, finalOrigin, status, record.redirectChain, errors);
  }

  if (record.body === null) {
    // 2xx but nothing usable — an empty body or a rejected type. An empty
    // robots.txt is a valid, fully permissive robots.txt.
    return permissivePolicy(record.finalUrl, finalOrigin, status, record.redirectChain, errors);
  }

  const text = record.body.toString('utf8');
  const parsed = robotsParser(record.finalUrl, text);

  const sitemaps: string[] = [];
  for (const declared of parsed.getSitemaps()) {
    const canonical = resolveSitemapDirective(declared, record.finalUrl);
    if (canonical.ok) {
      sitemaps.push(canonical.url);
    } else {
      errors.push(`unusable Sitemap directive ${JSON.stringify(declared)}: ${canonical.reason}`);
    }
  }

  const crawlDelaySeconds = parsed.getCrawlDelay(ROBOTS_USER_AGENT);
  const crawlDelayMs =
    crawlDelaySeconds === undefined || !Number.isFinite(crawlDelaySeconds)
      ? null
      : Math.max(0, crawlDelaySeconds * 1000);

  return {
    source: 'fetched',
    robotsUrl: record.finalUrl,
    siteOrigin: finalOrigin,
    httpStatus: status,
    redirectChain: record.redirectChain,
    text,
    sitemaps: [...new Set(sitemaps)],
    crawlDelayMs,
    errors,
    isAllowed(url: string): boolean {
      // robots-parser returns undefined when the rules cannot apply to the URL
      // — a different host, or an unparseable URL. Absence of a rule is
      // permission, so undefined means allowed.
      return parsed.isAllowed(url, ROBOTS_USER_AGENT) !== false;
    },
  };
}
