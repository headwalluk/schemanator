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
 *
 * Three sites live here, separate on purpose — a dozen tests assert exact counts
 * against each, and a defect added to one for another's benefit is a count to
 * re-derive everywhere:
 *
 *   - {@link startFixtureSite} — the crawler's nasty cases, above.
 *   - {@link startLinkGraphSite} — a link graph that disagrees with its sitemap.
 *   - {@link startDefectSite} — one deliberate defect per check that had never
 *     fired on anything real, and the near misses each must stay silent on.
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
   * A linked, unlisted image. The hop must never spend a request on it.
   *
   * Here because the hop ranks candidates most-linked-first, and on a real site
   * the most-linked unlisted URLs are sitewide asset links — a footer logo
   * outranks every real page. 30 of 50 slots went to images and PDFs on a
   * client site while 70 unlisted pages were dropped for want of budget, and
   * the group the hop exists to serve was starved by its own ranking.
   */
  asset: '/wp-content/uploads/2026/01/logo.png',
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
        LINK_GRAPH_UNLISTED.asset,
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

    // Served, and must never be requested either — for a different reason, which
    // is why both exist. `hits` proves the difference: robots.txt is a rule the
    // crawl obeys after asking, and this one it never asks about at all.
    [LINK_GRAPH_UNLISTED.asset]: {
      headers: { 'content-type': 'image/png' },
      body: 'not really a png',
    },
  });
}

/** Where each defect on the untriggered-check site lives. */
export const DEFECT_PATHS = {
  /** Carries `#brand` as an `Organization`, and a one-crumb trail of its own. */
  home: '/',
  /** Carries `#brand` as a `Person`. `entity.type-conflict`. */
  typeConflict: '/about',
  /** Two telephones on one node, and an address nobody references. */
  multiValue: '/contact',
  /**
   * Named as a crumb by {@link product}'s trail, and publishes none itself.
   * `breadcrumb.missing`.
   */
  breadcrumbSilent: '/shop',
  /** A `Product` with a name and nothing else. `google.incomplete-alternative`. */
  product: '/shop/widget',
  /** A block whose `@context` is not schema.org. `syntax.unresolvable-context`. */
  remoteContext: '/blog/post',
  /**
   * In the sitemap, 404s, and named as a crumb by {@link remoteContext}.
   *
   * `breadcrumb.broken-trail-item` reports only what was *fetched and refused* —
   * "absent from the crawl" was removed after it called four live pages dead
   * (`dev-notes/04`) — so this has to be a URL the crawl actually requested.
   */
  brokenCrumb: '/gone-section',
  /** Byte-identical bodies at two URLs. `indexing.duplicate-content`. */
  twins: ['/twin-a', '/twin-b'],
  /** Declares a canonical pointing at {@link redirecting}. */
  canonicalToRedirect: '/canonical-source',
  /** 301s to {@link redirectDestination}, making the canonical above a contradiction. */
  redirecting: '/moved-away',
  /** Where {@link redirecting} lands. Not in the sitemap; reached only through it. */
  redirectDestination: '/landing',
  /** Canonical → {@link chainMiddle} → {@link chainEnd}. `indexing.canonical-chain`. */
  chainStart: '/chain-start',
  chainMiddle: '/chain-middle',
  /** Self-canonical, which is what stops the chain being two chains. */
  chainEnd: '/chain-end',
  /** More words behind `hidden` than in the open. `content.hidden-text`. */
  hiddenText: '/hidden',
  /**
   * Also more hidden than shown, and **must not be reported**.
   *
   * Both sides are under the 50-word floor, so this is a *sparse* page rather
   * than one concealing anything — the class that made `content.hidden-text`
   * fire on 48 colour-swatch pages of 17 visible words apiece. Without a page of
   * this shape the fixture cannot tell the narrowed rule from the naive one:
   * every other page here hides nothing at all, and `hidden > visible` is false
   * for all of them however the floor is written.
   */
  sparseHidden: '/swatch',
  /** No `<title>` and no `lang`. `page.title-missing`, `page.lang-missing`. */
  bareHead: '/bare-head',
} as const;

/** Every path the defect site lists in its sitemap, in the order it lists them. */
const DEFECT_SITEMAP_PATHS: readonly string[] = [
  DEFECT_PATHS.home,
  DEFECT_PATHS.typeConflict,
  DEFECT_PATHS.multiValue,
  DEFECT_PATHS.breadcrumbSilent,
  DEFECT_PATHS.product,
  DEFECT_PATHS.remoteContext,
  DEFECT_PATHS.brokenCrumb,
  ...DEFECT_PATHS.twins,
  DEFECT_PATHS.canonicalToRedirect,
  DEFECT_PATHS.redirecting,
  DEFECT_PATHS.chainStart,
  DEFECT_PATHS.chainMiddle,
  DEFECT_PATHS.chainEnd,
  DEFECT_PATHS.hiddenText,
  DEFECT_PATHS.sparseHidden,
  DEFECT_PATHS.bareHead,
];

/** The theme directory blocked for everyone. `robots.resource-blocked`. */
export const DEFECT_BLOCKED_RESOURCE = '/wp-content/themes/';

/**
 * Blocked too, and must **not** be reported.
 *
 * The check's own remediation says blocking wp-admin is fine and normal, so a
 * fixture that only carried the theme rule could not tell a working matcher
 * from one that reports every `Disallow` it sees.
 */
export const DEFECT_ALLOWED_BLOCK = '/wp-admin/';

/** AI crawler tokens the defect site disallows. Both are in `data/ai-crawlers.json`. */
export const DEFECT_BLOCKED_CRAWLERS = ['GPTBot', 'CCBot'];

/**
 * A site built to make the never-fired checks fire.
 *
 * **Nineteen checks in the catalogue have never seen a true positive** — not
 * because they are wrong, but because no site in the 22-site corpus does the
 * thing they look for. Several are silent precisely *because* a false-positive
 * class was correctly removed from them, which is the outcome we wanted. But a
 * check that has never fired is untriggered rather than validated, and a
 * regression in one would stay invisible until a user hit it (`dev-notes/00`).
 *
 * So every defect here is deliberate and each one is annotated with the check it
 * exists for. Driven end to end through `runCrawl` → `runAnalysis` rather than
 * by handing synthetic records to a check, for the reason
 * `link-graph.e2e.test.ts` gives: a unit test proves the rule, and what is
 * unproven is whether the pipeline in front of it delivers what the rule needs.
 *
 * Separate from {@link startFixtureSite} and {@link startLinkGraphSite} for the
 * reason those two are separate from each other — a dozen tests assert exact
 * counts against them, and every defect added here would be a count to re-derive
 * there.
 *
 * **Every page links to every other page.** Not decoration: without inbound
 * links `link.orphan` would correctly report the entire sitemap, burying the
 * findings this site exists to produce under fifteen it does not. The nav is a
 * `<nav>`, so it is structural chrome and its words stay out of the content
 * ratios that `content.hidden-text` turns on.
 */
export async function startDefectSite(): Promise<TestServer> {
  const origin = (request: { headers: { host?: string | undefined } }): string =>
    `http://${request.headers.host}`;

  /**
   * `count` words unique to `label`.
   *
   * The label is not decoration. A block repeated on 80% of pages *is* site
   * chrome and its words are subtracted from the page's own — so giving every
   * page the same filler made eleven of them read as having nothing to index,
   * and `indexing.thin-sitemap-entry` said so, correctly, about a fixture that
   * was supposed to carry only deliberate defects.
   */
  const filler = (label: string, count: number): string =>
    Array.from({ length: count }, (_, index) => `${label}${index}`).join(' ');

  /** Body words unique to one page, derived from its title so nothing has to repeat it. */
  const ownWords = (title: string | null): string =>
    filler((title ?? 'untitled').toLowerCase().replace(/[^a-z]+/g, ''), 60);

  const nav = (): string =>
    `<nav>${DEFECT_SITEMAP_PATHS.map((path) => `<a href="${path}">${path}</a>`).join('')}</nav>`;

  interface DefectPage {
    /** Null omits the element entirely, which is what `page.title-missing` reads. */
    title: string | null;
    lang?: boolean;
    canonical?: string;
    jsonLd?: string[];
    body?: string;
    hidden?: string;
  }

  const page = (options: DefectPage): string =>
    `<!DOCTYPE html>
<html${options.lang === false ? '' : ' lang="en"'}>
<head>
<meta charset="utf-8">
${options.title === null ? '' : `<title>${options.title}</title>`}
${options.canonical === undefined ? '' : `<link rel="canonical" href="${options.canonical}">`}
${(options.jsonLd ?? []).map((block) => `<script type="application/ld+json">${block}</script>`).join('\n')}
</head>
<body>
${nav()}
<main>
<h1>${options.title ?? 'Untitled'}</h1>
<p>${options.body ?? ownWords(options.title)}</p>
${options.hidden === undefined ? '' : `<div hidden><p>${options.hidden}</p></div>`}
</main>
</body>
</html>`;

  const brand = (base: string, type: string): string =>
    JSON.stringify({
      '@context': 'https://schema.org',
      '@type': type,
      '@id': `${base}/#brand`,
      name: 'Fixture Defects Ltd',
    });

  const breadcrumb = (base: string, trail: { name: string; path: string }[]): string =>
    JSON.stringify({
      '@context': 'https://schema.org',
      '@type': 'BreadcrumbList',
      '@id': `${base}/#breadcrumb`,
      itemListElement: trail.map((crumb, index) => ({
        '@type': 'ListItem',
        position: index + 1,
        name: crumb.name,
        item: `${base}${crumb.path}`,
      })),
    });

  const htmlPage = (options: DefectPage): RouteResponse => htmlRoute(page(options));

  return startTestServer({
    /**
     * No `Sitemap:` directive, so the crawl finds `/sitemap.xml` by probing —
     * which is the only case `robots.sitemap-missing` reports, because it is the
     * only one where the evidence is unambiguous.
     */
    '/robots.txt': {
      headers: { 'content-type': 'text/plain' },
      body: [
        'User-agent: *',
        `Disallow: ${DEFECT_ALLOWED_BLOCK}`,
        `Disallow: ${DEFECT_BLOCKED_RESOURCE}`,
        'Crawl-delay: 0',
        '',
        ...DEFECT_BLOCKED_CRAWLERS.flatMap((token) => [`User-agent: ${token}`, 'Disallow: /', '']),
      ].join('\n'),
    },

    '/sitemap.xml': (request) =>
      xmlRoute(urlset(DEFECT_SITEMAP_PATHS.map((path) => `${origin(request)}${path}`))),

    // A one-crumb trail. It places nothing in the tree, and `breadcrumb.missing`
    // needs the *parent* of a silent page to carry a trail — without this the
    // check has nothing to compare `/shop` against.
    [DEFECT_PATHS.home]: (request) =>
      htmlPage({
        title: 'Home',
        jsonLd: [
          brand(origin(request), 'Organization'),
          breadcrumb(origin(request), [{ name: 'Home', path: '/' }]),
        ],
      }),

    // The same absolute @id, typed as something an Organization cannot also be.
    // Absolute on purpose: a fragment-only @id resolves per page, so the two
    // observations would never meet and this would be `graph.relative-id`
    // instead — which the other two fixtures already cover.
    [DEFECT_PATHS.typeConflict]: (request) =>
      htmlPage({ title: 'About', jsonLd: [brand(origin(request), 'Person')] }),

    [DEFECT_PATHS.multiValue]: (request) =>
      htmlPage({
        title: 'Contact',
        jsonLd: [
          // Two values for a functional property in one block. schema.org
          // permits any property to repeat, so a per-page validator passes this.
          JSON.stringify({
            '@context': 'https://schema.org',
            '@type': 'Organization',
            '@id': `${origin(request)}/#switchboard`,
            name: 'Fixture Defects Ltd',
            telephone: ['+44 20 7946 0000', '+44 20 7946 3333'],
          }),
          // Defined, complete, and referenced by nothing. A PostalAddress cannot
          // be what a page is about, which is the one distinction that makes
          // `graph.orphan-node` trustworthy rather than a 1,480-hit false alarm.
          JSON.stringify({
            '@context': 'https://schema.org',
            '@type': 'PostalAddress',
            '@id': `${origin(request)}/#address-nobody-uses`,
            // Not "1 Example Street": `value.placeholder` matches that, and a
            // second finding on this node would obscure the one it is here for.
            streetAddress: '12 Fixture Lane',
            addressLocality: 'London',
            postalCode: 'EC1A 1BB',
          }),
        ],
      }),

    [DEFECT_PATHS.breadcrumbSilent]: htmlPage({ title: 'Shop' }),

    [DEFECT_PATHS.product]: (request) =>
      htmlPage({
        title: 'Widget',
        jsonLd: [
          // Google requires one of offers / review / aggregateRating. This has
          // none, which is one decision to fix rather than three fields.
          JSON.stringify({
            '@context': 'https://schema.org',
            '@type': 'Product',
            '@id': `${origin(request)}${DEFECT_PATHS.product}#product`,
            name: 'A Widget',
          }),
          breadcrumb(origin(request), [
            { name: 'Home', path: DEFECT_PATHS.home },
            { name: 'Shop', path: DEFECT_PATHS.breadcrumbSilent },
            { name: 'Widget', path: DEFECT_PATHS.product },
          ]),
        ],
      }),

    [DEFECT_PATHS.remoteContext]: (request) =>
      htmlPage({
        title: 'Post',
        jsonLd: [
          // Valid JSON, and unresolvable: `03` refuses to fetch remote contexts,
          // because a crawl that depends on a third-party server being reachable
          // is not reproducible. The entities in this block are simply lost.
          JSON.stringify({
            '@context': 'https://example.invalid/vocabulary.jsonld',
            '@type': 'Thing',
            name: 'An entity whose vocabulary we cannot resolve',
          }),
          // Referenced by nothing, and never a `graph.orphan-node` — an Article
          // nobody points at is what the page is *about*. The obvious version of
          // that rule fired 1,480 times across the corpus and was wrong every
          // time, so the fixture has to hold the case it must stay quiet on.
          JSON.stringify({
            '@context': 'https://schema.org',
            '@type': 'Article',
            '@id': `${origin(request)}${DEFECT_PATHS.remoteContext}#article`,
            headline: 'A post nothing in the graph refers to',
          }),
          breadcrumb(origin(request), [
            { name: 'Home', path: DEFECT_PATHS.home },
            { name: 'Section', path: DEFECT_PATHS.brokenCrumb },
            { name: 'Post', path: DEFECT_PATHS.remoteContext },
          ]),
        ],
      }),

    [DEFECT_PATHS.brokenCrumb]: { status: 404, body: 'not found' },

    // Byte-identical, which is all `indexing.duplicate-content` claims to find.
    // Neither declares a canonical, or the pair would have an answer already.
    ...Object.fromEntries(
      DEFECT_PATHS.twins.map((path) => [
        path,
        htmlPage({ title: 'One Page, Two URLs', body: filler('twin', 60) }),
      ]),
    ),

    [DEFECT_PATHS.canonicalToRedirect]: (request) =>
      htmlPage({
        title: 'Canonical Source',
        canonical: `${origin(request)}${DEFECT_PATHS.redirecting}`,
      }),

    [DEFECT_PATHS.redirecting]: {
      status: 301,
      headers: { location: DEFECT_PATHS.redirectDestination },
    },
    [DEFECT_PATHS.redirectDestination]: htmlPage({ title: 'Landing' }),

    [DEFECT_PATHS.chainStart]: (request) =>
      htmlPage({
        title: 'Chain Start',
        canonical: `${origin(request)}${DEFECT_PATHS.chainMiddle}`,
      }),
    [DEFECT_PATHS.chainMiddle]: (request) =>
      htmlPage({
        title: 'Chain Middle',
        canonical: `${origin(request)}${DEFECT_PATHS.chainEnd}`,
      }),
    [DEFECT_PATHS.chainEnd]: (request) =>
      htmlPage({
        title: 'Chain End',
        canonical: `${origin(request)}${DEFECT_PATHS.chainEnd}`,
      }),

    // Both sides must clear 50 words or the ratio means nothing — the rule that
    // stopped this firing on 48 colour-swatch pages with 17 visible words each.
    [DEFECT_PATHS.hiddenText]: htmlPage({
      title: 'Hidden',
      body: filler('shown', 60),
      hidden: filler('concealed', 150),
    }),

    // Under the floor on both sides, and above `indexing.thin-sitemap-entry`'s
    // 25 words on the visible one, so the only thing keeping this quiet is the
    // rule this fixture is here to hold in place.
    [DEFECT_PATHS.sparseHidden]: htmlPage({
      title: 'Swatch',
      body: filler('swatch', 30),
      hidden: filler('swatchnote', 40),
    }),

    [DEFECT_PATHS.bareHead]: htmlPage({ title: null, lang: false }),
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
