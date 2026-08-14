/**
 * Tests for group `indexing`.
 *
 * The two "does not fire" tests near the end matter most. Both pin false
 * positives the corpus produced on the day these checks were written — 20
 * findings across 6 sites, every one wrong — and both looked entirely
 * reasonable in the code.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { PageRecord } from '../store/workdir.ts';
import { runChecks } from './run.ts';

function page(options: {
  id: string;
  url?: string;
  canonical?: string;
  declared?: string | null;
  status?: number;
  redirects?: string[];
  hash?: string;
  fromSitemap?: boolean;
}): PageRecord {
  const url = options.url ?? `https://example.com/${options.id}`;
  return {
    page_id: options.id,
    url,
    canonical_url: options.canonical ?? url,
    declared_canonical: options.declared ?? null,
    source:
      options.fromSitemap === false ? 'front-page-fallback' : 'sitemap:https://example.com/s.xml',
    http_status: options.status ?? 200,
    redirect_chain: (options.redirects ?? []).map((location) => ({ url, status: 301, location })),
    content_type: 'text/html',
    fetched_at: '2026-08-09T00:00:00Z',
    content_sha256: options.hash ?? options.id,
    bytes: 100,
    html_purged: false,
    microdata_types: [],
    page_facts: null,
    extraction: {
      json_ld_blocks: 0,
      json_ld_failed: 0,
      microdata_items: 0,
      rdfa_items: 0,
      nodes: 0,
    },
    errors: [],
  };
}

const indexing = (pages: PageRecord[]) =>
  runChecks({ nodes: [], pages, partialCoverage: false }).findings.filter((finding) =>
    finding.check.startsWith('indexing.'),
  );

const only = (pages: PageRecord[], check: string) =>
  indexing(pages).filter((finding) => finding.check === check);

// --- sitemap-dead-url --------------------------------------------------------

test('a sitemap URL returning 404 is an error, grouped by status', () => {
  const findings = only(
    [
      page({ id: 'a', status: 404 }),
      page({ id: 'b', status: 404 }),
      page({ id: 'c', status: 500 }),
    ],
    'indexing.sitemap-dead-url',
  );

  assert.equal(findings.length, 2, 'one finding per status, not per URL');
  const notFound = findings.find((finding) => finding.title.includes('404'));
  assert.equal(notFound?.severity, 'error');
  assert.equal(notFound?.pages_affected, 2);
});

test('a dead URL that was never in a sitemap is not this finding', () => {
  // The sitemap making a false claim is the point. A 404 discovered some other
  // way is a different problem.
  assert.deepEqual(
    only([page({ id: 'a', status: 404, fromSitemap: false })], 'indexing.sitemap-dead-url'),
    [],
  );
});

// --- sitemap-redirects / redirect-chain --------------------------------------

test('sitemap URLs that redirect are reported once for the site', () => {
  const findings = only(
    [
      page({ id: 'a', redirects: ['https://example.com/x'], canonical: 'https://example.com/x' }),
      page({ id: 'b', redirects: ['https://example.com/y'], canonical: 'https://example.com/y' }),
    ],
    'indexing.sitemap-redirects',
  );

  assert.equal(findings.length, 1, 'one generator behaviour, one finding');
  assert.equal(findings[0]?.pages_affected, 2);
});

test('only chains of two or more hops are reported', () => {
  const one = only(
    [page({ id: 'a', redirects: ['https://example.com/x'] })],
    'indexing.redirect-chain',
  );
  assert.deepEqual(one, [], 'a single redirect is normal and is not a chain');

  const two = only(
    [page({ id: 'b', redirects: ['https://example.com/x', 'https://example.com/y'] })],
    'indexing.redirect-chain',
  );
  assert.equal(two.length, 1);
  assert.equal(two[0]?.severity, 'opportunity');
});

// --- canonical checks --------------------------------------------------------

test('a canonical pointing at a URL that redirects is reported', () => {
  const findings = only(
    [
      page({ id: 'a', declared: 'https://example.com/old' }),
      page({
        id: 'old',
        url: 'https://example.com/old',
        canonical: 'https://example.com/new',
        redirects: ['https://example.com/new'],
      }),
    ],
    'indexing.canonical-to-redirect',
  );

  assert.equal(findings.length, 1);
  assert.equal(findings[0]?.severity, 'warning');
});

test('a canonical chain is reported', () => {
  const findings = only(
    [
      page({ id: 'a', declared: 'https://example.com/b' }),
      page({ id: 'b', url: 'https://example.com/b', declared: 'https://example.com/c' }),
      page({ id: 'c', url: 'https://example.com/c', declared: 'https://example.com/c' }),
    ],
    'indexing.canonical-chain',
  );

  assert.equal(findings.length, 1);
  assert.match(findings[0]?.observed[0]?.value ?? '', /\/a.*\/b.*\/c/s);
});

test('a self-referencing canonical is not a chain', () => {
  assert.deepEqual(
    only([page({ id: 'a', declared: 'https://example.com/a' })], 'indexing.canonical-chain'),
    [],
  );
});

/**
 * The false positive: six pages on one corpus site were told their canonical
 * redirects when it does not.
 *
 * Several requests land on one destination, so keying the lookup on
 * `canonical_url` collided — `/login/` (served directly) and a membership page
 * that *redirects to* `/login/` both carry `canonical_url = /login/`, and the
 * map kept whichever came last. "Does this URL redirect?" is a question about
 * the URL that was **requested**.
 */
test('a canonical is not "redirecting" because something else redirects to it', () => {
  const findings = only(
    [
      // The real page, served directly at /login/.
      page({
        id: 'login',
        url: 'https://example.com/login',
        declared: 'https://example.com/login',
      }),
      // A gated page that redirects *to* /login/, so shares its canonical_url.
      page({
        id: 'profile',
        url: 'https://example.com/profile',
        canonical: 'https://example.com/login',
        declared: 'https://example.com/login',
        redirects: ['https://example.com/login'],
      }),
      // A third page declaring /login/ as its canonical. This must stay silent.
      page({ id: 'other', declared: 'https://example.com/login' }),
    ],
    'indexing.canonical-to-redirect',
  );

  assert.deepEqual(findings, []);
});

// --- duplicate-content -------------------------------------------------------

test('two distinct URLs serving identical bytes are reported', () => {
  const findings = only(
    [page({ id: 'a', hash: 'same' }), page({ id: 'b', hash: 'same' })],
    'indexing.duplicate-content',
  );

  assert.equal(findings.length, 1);
  assert.equal(findings[0]?.pages_affected, 2);
  // The limit has to be stated, or the finding over-claims.
  assert.match(findings[0]?.summary ?? '', /only exact duplicates/);
});

/**
 * The other false positive: five corpus sites reported "duplicate content"
 * that was nothing of the kind.
 *
 * `/basket/`, `/checkout/` and `/shop/` all redirect to `/plugins/`, so every
 * record shares one `canonical_url` and one body hash. That is one page reached
 * three ways — already reported by `indexing.sitemap-redirects` — and billing
 * it again here charged the operator twice for one defect.
 */
test('URLs that redirect to one page are not duplicate content', () => {
  const findings = only(
    [
      page({ id: 'plugins', url: 'https://example.com/plugins', hash: 'same' }),
      page({
        id: 'basket',
        url: 'https://example.com/basket',
        canonical: 'https://example.com/plugins',
        hash: 'same',
        redirects: ['https://example.com/plugins'],
      }),
      page({
        id: 'shop',
        url: 'https://example.com/shop',
        canonical: 'https://example.com/plugins',
        hash: 'same',
        redirects: ['https://example.com/plugins'],
      }),
    ],
    'indexing.duplicate-content',
  );

  assert.deepEqual(findings, []);
});

test('a non-200 is never duplicate content', () => {
  // Every 404 on a site shares one body. Reporting that would bury the report.
  assert.deepEqual(
    only(
      [page({ id: 'a', status: 404, hash: 'same' }), page({ id: 'b', status: 404, hash: 'same' })],
      'indexing.duplicate-content',
    ),
    [],
  );
});

// --- requests folded into a page they redirected to --------------------------

const withAlias = (options: { url: string; redirects: string[]; source?: string }): PageRecord => ({
  ...page({ id: 'target' }),
  url: 'https://example.com/target',
  canonical_url: 'https://example.com/target',
  aliases: [
    {
      url: options.url,
      source: options.source ?? 'sitemap:https://example.com/s.xml',
      http_status: 200,
      redirect_chain: options.redirects.map((location) => ({
        url: options.url,
        status: 301,
        location,
      })),
      fetched_at: '2026-08-14T00:00:00Z',
    },
  ],
});

test('a redirect folded into its destination is still reported', () => {
  // The regression this pair exists to stop. Once a redirecting URL stopped
  // being its own page record, a check reading `redirect_chain` off page
  // records alone saw nothing — and reported nothing, on a site where the
  // sitemap really does advertise a URL that redirects.
  const findings = only(
    [withAlias({ url: 'https://example.com/old', redirects: ['https://example.com/target'] })],
    'indexing.sitemap-redirects',
  );

  assert.equal(findings.length, 1);
  assert.equal(findings[0]?.observed[0]?.value, 'https://example.com/old');
  assert.match(
    findings[0]?.observed[0]?.detail ?? '',
    /redirects to https:\/\/example\.com\/target/,
  );
  // One page, however many URLs point at it — the page is stored once now.
  assert.equal(findings[0]?.pages_affected, 1);
});

test('a folded request keeps the hops it made', () => {
  const findings = only(
    [
      withAlias({
        url: 'https://example.com/old',
        redirects: ['https://example.com/mid', 'https://example.com/target'],
      }),
    ],
    'indexing.redirect-chain',
  );

  assert.equal(findings.length, 1);
  assert.match(findings[0]?.observed[0]?.detail ?? '', /mid.*target/s);
});

test('a canonical pointing at a folded URL still counts as pointing at a redirect', () => {
  // `indexing.canonical-to-redirect` asks whether requesting the canonical
  // target redirects. That is a question about a request, and the request now
  // lives on the alias rather than on a record of its own.
  const target = withAlias({
    url: 'https://example.com/old',
    redirects: ['https://example.com/target'],
  });
  const findings = only(
    [target, page({ id: 'other', declared: 'https://example.com/old' })],
    'indexing.canonical-to-redirect',
  );

  assert.equal(findings.length, 1);
  assert.equal(findings[0]?.pages_affected, 1);
});

// --- indexing.sitemap-duplicate-url / indexing.sitemap-overlap ---------------

const PRODUCTS = 'https://example.com/product-sitemap.xml';
const PAGES = 'https://example.com/page-sitemap.xml';

const duplicate = (url: string, fromSitemap: string, firstSitemap: string) => ({
  url,
  rawUrl: url,
  fromSitemap,
  firstSitemap,
});

const withDuplicates = (duplicates: ReturnType<typeof duplicate>[] | null) =>
  runChecks({
    nodes: [],
    pages: [page({ id: 'a' })],
    partialCoverage: false,
    sitemapDuplicates: duplicates,
  }).findings;

test('a URL listed twice in one sitemap is reported once, against that file', () => {
  const findings = withDuplicates([
    duplicate('https://example.com/hosting/', PRODUCTS, PRODUCTS),
    duplicate('https://example.com/hosting/', PRODUCTS, PRODUCTS),
  ]).filter((finding) => finding.check === 'indexing.sitemap-duplicate-url');

  assert.equal(findings.length, 1);
  assert.equal(findings[0]?.subject.id, PRODUCTS);
  assert.equal(findings[0]?.observed[0]?.value, 'https://example.com/hosting/');
  // Two repeats plus the original listing.
  assert.equal(findings[0]?.observed[0]?.detail, 'listed 3 times');
});

test('a repeat within a file is not also reported as an overlap between files', () => {
  // The two checks read one record and must not both fire on one situation —
  // which is the fault the milestone that produced them was written about.
  const findings = withDuplicates([
    duplicate('https://example.com/hosting/', PRODUCTS, PRODUCTS),
  ]).filter((finding) => finding.check === 'indexing.sitemap-overlap');

  assert.deepEqual(findings, []);
});

test('a URL in two sitemaps is reported against the pair', () => {
  const findings = withDuplicates([
    duplicate('https://example.com/hosting/', PRODUCTS, PAGES),
    duplicate('https://example.com/email/', PRODUCTS, PAGES),
  ]).filter((finding) => finding.check === 'indexing.sitemap-overlap');

  assert.equal(findings.length, 1, 'one finding per pair of files, not per URL');
  assert.equal(findings[0]?.observed.length, 2);
  assert.match(findings[0]?.title ?? '', /2 URL\(s\) appear in two sitemaps/);
});

test('which file the crawl read first is not a fact about the site', () => {
  // The pair is unordered. Keying on (first, second) would report one situation
  // as two findings whenever discovery happened to interleave the two files.
  const findings = withDuplicates([
    duplicate('https://example.com/a/', PRODUCTS, PAGES),
    duplicate('https://example.com/b/', PAGES, PRODUCTS),
  ]).filter((finding) => finding.check === 'indexing.sitemap-overlap');

  assert.equal(findings.length, 1);
  assert.equal(findings[0]?.observed.length, 2);
});

test('neither check claims pages are affected by a repetition', () => {
  // The URL is crawled once however many times it is listed. Billing pages to
  // it would inflate every count downstream for a fact about a file.
  const findings = withDuplicates([
    duplicate('https://example.com/hosting/', PRODUCTS, PRODUCTS),
    duplicate('https://example.com/email/', PRODUCTS, PAGES),
  ]).filter((finding) => finding.check.startsWith('indexing.sitemap-'));

  assert.equal(findings.length, 2);
  for (const finding of findings) assert.equal(finding.pages_affected, 0);
});

test('a crawl that never measured duplicates reports none, and says nothing', () => {
  // The trap this nullable exists for: `null` is "not measured", and every
  // crawl before 1.12.0 is one. Reading it as "none found" would produce a
  // confident clean result from a measurement nobody took — and unlike the
  // microdata case, re-running `analyse` cannot fill it in, because
  // deduplication happens during discovery.
  assert.deepEqual(
    withDuplicates(null).filter((finding) => finding.check.startsWith('indexing.sitemap-')),
    [],
  );
});

test('a measured site with no repeats is silent, not empty-handed', () => {
  assert.deepEqual(
    withDuplicates([]).filter((finding) => finding.check.startsWith('indexing.sitemap-')),
    [],
  );
});
