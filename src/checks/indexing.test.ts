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
