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
            // Duplicate of a page already listed, with a tracking parameter.
            `${origin(request)}/about?utm_source=newsletter`,
            // Redirects twice before landing.
            `${origin(request)}/moved`,
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

    '/moved': { status: 301, headers: { location: '/moved-again' } },
    '/moved-again': { status: 302, headers: { location: '/moved-target' } },
    '/moved-target': htmlRoute(html('Moved Target', [ORGANIZATION, webPage('Moved Target')])),

    '/private/secret': htmlRoute(html('Secret', [webPage('Secret')])),
    '/gone': { status: 404, body: 'not found' },
    '/brochure.pdf': { headers: { 'content-type': 'application/pdf' }, body: '%PDF-1.4 fake' },
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
