/**
 * The fixture corpus.
 *
 * **Never crawl a third-party site to test a code change** (`dev-notes/02`).
 * This is a deliberately nasty little site covering the cases that break
 * crawlers in the wild:
 *
 *   - a sitemap index recursing into children, one of them gzipped
 *   - a redirect chain
 *   - a 429 with `Retry-After` that succeeds on retry
 *   - a sitemap entry that 404s
 *   - a cross-host sitemap entry
 *   - one URL listed twice inside a sitemap, and another listed in two of them
 *   - two sitemap URLs that redirect to pages the sitemap **also lists
 *     directly**, one in each order: `/moved` before its destination and
 *     `/old-post` after its own. Both must collapse to a single stored page,
 *     and neither may depend on which was fetched first
 *   - a non-HTML entry (PDF) that must be skipped by Content-Type
 *   - a robots.txt `Disallow` covering one sitemap entry
 *
 * The pages also carry JSON-LD, including a malformed block and a
 * plugin-style repeated Organization node, so the same corpus drives the
 * extraction work in `dev-notes/03` without needing to be rebuilt.
 */

import zlib from 'node:zlib';

import { startTestServer, type RouteResponse, type TestServer } from '../helpers/server.ts';

const html = (title: string, jsonLd: string[]): string =>
  `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${title}</title>
${jsonLd.map((block) => `<script type="application/ld+json">${block}</script>`).join('\n')}
</head>
<body><h1>${title}</h1></body>
</html>`;

/** The sitewide Organization node an SEO plugin repeats on every page. Repetition is normal. */
const ORGANIZATION = JSON.stringify({
  '@context': 'https://schema.org',
  '@type': 'Organization',
  '@id': '#organization',
  name: 'Fixture Widgets Ltd',
  telephone: '+44 20 7946 0000',
});

/** The same @id with a contradicting telephone — the flagship finding, planted on one page. */
const ORGANIZATION_DIVERGENT = JSON.stringify({
  '@context': 'https://schema.org',
  '@type': 'Organization',
  '@id': '#organization',
  name: 'Fixture Widgets Ltd',
  telephone: '+44 20 7946 1111',
});

const webPage = (name: string): string =>
  JSON.stringify({ '@context': 'https://schema.org', '@type': 'WebPage', name });

const urlset = (entries: string[]): string =>
  `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${entries.map((loc) => `  <url><loc>${loc}</loc><lastmod>2026-07-01</lastmod></url>`).join('\n')}
</urlset>`;

const sitemapindex = (entries: string[]): string =>
  `<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${entries.map((loc) => `  <sitemap><loc>${loc}</loc></sitemap>`).join('\n')}
</sitemapindex>`;

const xmlRoute = (body: string): RouteResponse => ({
  headers: { 'content-type': 'application/xml' },
  body,
});

const htmlRoute = (body: string): RouteResponse => ({
  headers: { 'content-type': 'text/html; charset=utf-8' },
  body,
});

/** Page paths the fixture sitemap advertises and that should end up fetched. */
export const FIXTURE_FETCHABLE_PATHS = [
  '/',
  '/about',
  '/contact',
  '/blog/post-one',
  '/moved-target',
];

/**
 * Advertised and fetched, but **not stored as pages of their own**.
 *
 * Each redirects to a URL the sitemap also lists directly, so the crawl folds it
 * into that page as an alias. One is listed before its destination and one
 * after, because the order is exactly what a naive implementation gets wrong.
 */
export const FIXTURE_ALIAS_PATHS = ['/moved', '/old-post'];

/** Advertised but must NOT be fetched, each for a different reason. */
export const FIXTURE_EXCLUDED_PATHS = {
  disallowed: '/private/secret',
  notFound: '/gone',
  notHtml: '/brochure.pdf',
  crossHost: 'https://someone-else.example/theirs',
};

export async function startFixtureSite(): Promise<TestServer> {
  const origin = (request: { headers: { host?: string | undefined } }): string =>
    `http://${request.headers.host}`;

  return startTestServer({
    '/robots.txt': (request) => ({
      headers: { 'content-type': 'text/plain' },
      body: [
        'User-agent: *',
        'Disallow: /private/',
        'Crawl-delay: 0',
        `Sitemap: ${origin(request)}/sitemap_index.xml`,
        '',
      ].join('\n'),
    }),

    '/sitemap_index.xml': (request) =>
      xmlRoute(
        sitemapindex([
          `${origin(request)}/sitemap-pages.xml`,
          `${origin(request)}/sitemap-posts.xml.gz`,
        ]),
      ),

    '/sitemap-pages.xml': (request) =>
      xmlRoute(
        urlset([
          `${origin(request)}/`,
          `${origin(request)}/about`,
          `${origin(request)}/contact`,
          // Listed twice in one file. Crawled once — and since 1.12.0 the
          // repetition is recorded rather than silently deduplicated, because
          // it is a fact about the site's generator that nothing else can see.
          `${origin(request)}/contact`,
          // Advertised but excluded by robots.txt.
          `${origin(request)}${FIXTURE_EXCLUDED_PATHS.disallowed}`,
          // Advertised but gone.
          `${origin(request)}${FIXTURE_EXCLUDED_PATHS.notFound}`,
          // Advertised but not a page.
          `${origin(request)}${FIXTURE_EXCLUDED_PATHS.notHtml}`,
          // Cross-submitted to another host — legal, but not ours to crawl.
          FIXTURE_EXCLUDED_PATHS.crossHost,
        ]),
      ),

    // Gzipped, and served with a Content-Type that lies about it.
    '/sitemap-posts.xml.gz': (request) => ({
      headers: { 'content-type': 'application/xml' },
      body: zlib.gzipSync(
        Buffer.from(
          urlset([
            `${origin(request)}/blog/post-one`,
            // Redirects to /blog/post-one, listed directly just above it — so
            // the destination is already stored when this is fetched.
            `${origin(request)}/old-post`,
            // Duplicate of a page already listed, with a tracking parameter.
            `${origin(request)}/about?utm_source=newsletter`,
            // Redirects twice before landing.
            `${origin(request)}/moved`,
            // The destination of /moved, listed directly and *after* it — so
            // the redirect is fetched first and the page it lands on has not
            // been seen yet. The order that would have stored it twice.
            `${origin(request)}/moved-target`,
          ]),
        ),
      ),
    }),

    '/': htmlRoute(html('Fixture Widgets — Home', [ORGANIZATION, webPage('Home')])),
    '/about': htmlRoute(html('About', [ORGANIZATION, webPage('About')])),

    // Same @id, different telephone: the contradiction the whole tool exists for.
    '/contact': htmlRoute(
      html('Contact', [
        ORGANIZATION_DIVERGENT,
        webPage('Contact'),
        '{ "@context": "https://schema.org", broken ',
      ]),
    ),

    '/blog/post-one': htmlRoute(html('Post One', [ORGANIZATION, webPage('Post One')])),

    '/old-post': { status: 301, headers: { location: '/blog/post-one' } },
    '/moved': { status: 301, headers: { location: '/moved-again' } },
    '/moved-again': { status: 302, headers: { location: '/moved-target' } },
    '/moved-target': htmlRoute(html('Moved Target', [ORGANIZATION, webPage('Moved Target')])),

    '/private/secret': htmlRoute(html('Secret', [webPage('Secret')])),
    '/gone': { status: 404, body: 'not found' },
    '/brochure.pdf': { headers: { 'content-type': 'application/pdf' }, body: '%PDF-1.4 fake' },
  });
}

/** Sitemap pages of the link-graph fixture, by the role each one plays. */
export const LINK_GRAPH_PATHS = {
  /** Links to the hub and to `/linked-post`. */
  home: '/',
  /** Linked from the home page. Neither orphaned nor cut off. */
  linked: '/linked-post',
  /** Linked only from `/hub`, which is noindex. `link.noindex-only-inbound`. */
  behindNoIndex: ['/guide-one', '/guide-two'],
  /**
   * Linked only from `/archive/page/2`, which is unlisted but **indexable**.
   *
   * The false positive the hop exists to kill: sitemap-only, this page has no
   * inbound link and reads exactly like `/guide-one`. It is the difference
   * between a check that is right and one that is right 63% of the time.
   */
  behindPagination: '/page-two-post',
  /** Linked from nowhere at all. `link.orphan`. */
  orphan: '/stranded',
  /**
   * In the sitemap, linked from the home page, and last in document order.
   *
   * Exists to be dropped by a low `--max-pages`. A sitemap URL the sample let
   * go is **not** an unlisted page, and the hop must not spend its budget
   * re-fetching it — the bug a larger site's dry run exposed, where 464
   * dropped sitemap URLs read as "linked but in no sitemap".
   */
  droppedBySample: '/also-in-the-sitemap',
} as const;

/** Pages the link-graph fixture does NOT list in a sitemap. Reached only by the hop. */
export const LINK_GRAPH_UNLISTED = {
  /** `noindex, follow` — a section index, exactly as an SEO plugin produces one. */
  hub: '/hub',
  /** `index, follow` — archive pagination, normal to leave out of a sitemap. */
  paginated: '/archive/page/2',
  /**
   * Redirects to {@link hub}, so two hop requests produce **one** hop record.
   *
   * The condition that broke the report's arithmetic on a large site: 48 hop
   * requests, 44 records. Any coverage number computed by subtracting a record
   * count from a request count is wrong the moment this exists, and it exists
   * on real sites constantly.
   */
  redirectsToHub: '/guides-old',
  /**
   * Linked sitewide, unlisted, and `Disallow`ed — a basket or account screen.
   *
   * Here because the first live run of the hop got this wrong: two such URLs on
   * a real site were reported as *"2 not followed — raise --link-hop-pages"*
   * against a cap of 50 that was nowhere near biting. No cap would ever fetch
   * them. The counts must keep the two reasons apart.
   */
  disallowed: '/private/basket',
} as const;

/**
 * A site whose link graph disagrees with its sitemap.
 *
 * Modelled directly on what `headwall-hosting.com` turned out to be
 * (`dev-notes/11`), because the shape is what makes the checks hard: a
 * noindexed section index is the only route to the pages under it, and a
 * paginated archive nobody lists is the only route to the posts on page 2.
 * Sitemap-only, those two are indistinguishable. One is a finding and the other
 * is nothing at all.
 *
 * Separate from {@link startFixtureSite} on purpose. That one is dense with
 * redirect and duplicate semantics whose counts a dozen tests assert, and
 * threading link structure through it would make both harder to read and every
 * one of those counts a guess.
 */
export async function startLinkGraphSite(): Promise<TestServer> {
  const origin = (request: { headers: { host?: string | undefined } }): string =>
    `http://${request.headers.host}`;

  const linked = (title: string, hrefs: string[], robots?: string): string =>
    `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${title}</title>
${robots === undefined ? '' : `<meta name="robots" content="${robots}">`}
<script type="application/ld+json">${ORGANIZATION}</script>
</head>
<body>
<h1>${title}</h1>
<main><p>Body copy for ${title}, long enough not to read as a thin page.</p>
${hrefs.map((href) => `<a href="${href}">${href}</a>`).join('\n')}
<a href="${hrefs[0] ?? '/'}#comment-1">Cancel reply</a>
</main>
</body>
</html>`;

  return startTestServer({
    '/robots.txt': (request) => ({
      headers: { 'content-type': 'text/plain' },
      body: `User-agent: *\nDisallow: /private/\nCrawl-delay: 0\nSitemap: ${origin(request)}/sitemap.xml\n`,
    }),

    '/sitemap.xml': (request) =>
      xmlRoute(
        urlset([
          `${origin(request)}${LINK_GRAPH_PATHS.home}`,
          `${origin(request)}${LINK_GRAPH_PATHS.linked}`,
          ...LINK_GRAPH_PATHS.behindNoIndex.map((path) => `${origin(request)}${path}`),
          `${origin(request)}${LINK_GRAPH_PATHS.behindPagination}`,
          `${origin(request)}${LINK_GRAPH_PATHS.orphan}`,
          `${origin(request)}${LINK_GRAPH_PATHS.droppedBySample}`,
        ]),
      ),

    // The only page linking to the hub and the archive, so the hop has exactly
    // two candidates and the cap can be tested against a known number.
    '/': htmlRoute(
      linked('Home', [
        LINK_GRAPH_PATHS.linked,
        LINK_GRAPH_UNLISTED.hub,
        LINK_GRAPH_UNLISTED.paginated,
        LINK_GRAPH_UNLISTED.disallowed,
        LINK_GRAPH_UNLISTED.redirectsToHub,
        LINK_GRAPH_PATHS.droppedBySample,
      ]),
    ),
    '/linked-post': htmlRoute(linked('Linked Post', [LINK_GRAPH_PATHS.home])),
    '/also-in-the-sitemap': htmlRoute(linked('Also In The Sitemap', [LINK_GRAPH_PATHS.home])),
    '/guide-one': htmlRoute(linked('Guide One', [LINK_GRAPH_PATHS.home])),
    '/guide-two': htmlRoute(linked('Guide Two', [LINK_GRAPH_PATHS.home])),
    '/page-two-post': htmlRoute(linked('Page Two Post', [LINK_GRAPH_PATHS.home])),

    // Links only to itself, the way a real orphan does — a comment permalink
    // and a "Cancel reply". Anything counting self-links finds nothing here.
    '/stranded': htmlRoute(linked('Stranded', [LINK_GRAPH_PATHS.orphan])),

    [LINK_GRAPH_UNLISTED.hub]: htmlRoute(
      linked('Guides', [...LINK_GRAPH_PATHS.behindNoIndex], 'noindex, follow'),
    ),
    [LINK_GRAPH_UNLISTED.paginated]: htmlRoute(
      linked('Archive, page 2', [LINK_GRAPH_PATHS.behindPagination], 'index, follow'),
    ),
    [LINK_GRAPH_UNLISTED.redirectsToHub]: {
      status: 301,
      headers: { location: LINK_GRAPH_UNLISTED.hub },
    },
    // Served, but robots.txt refuses it. Must never be fetched.
    [LINK_GRAPH_UNLISTED.disallowed]: htmlRoute(linked('Basket', [LINK_GRAPH_PATHS.home])),
  });
}

/**
 * A variant that throttles the first request to `/about` with a 429, to prove
 * the crawl backs off and recovers rather than dropping the page.
 */
export async function startThrottlingSite(): Promise<TestServer> {
  const origin = (request: { headers: { host?: string | undefined } }): string =>
    `http://${request.headers.host}`;

  return startTestServer({
    '/robots.txt': (request) => ({
      headers: { 'content-type': 'text/plain' },
      body: `User-agent: *\nDisallow:\nSitemap: ${origin(request)}/sitemap.xml\n`,
    }),
    '/sitemap.xml': (request) =>
      xmlRoute(urlset([`${origin(request)}/`, `${origin(request)}/about`])),
    '/': htmlRoute(html('Home', [ORGANIZATION])),
    '/about': (_request, hit) =>
      hit === 1
        ? { status: 429, headers: { 'retry-after': '0' }, body: 'slow down' }
        : htmlRoute(html('About', [ORGANIZATION])),
  });
}
