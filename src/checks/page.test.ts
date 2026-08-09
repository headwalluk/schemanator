/**
 * Tests for group `page`.
 *
 * Two things here are decisions rather than assertions, and both came from the
 * corpus: `page.heading-sequence` is *not built*, and `page.h1-multiple` is an
 * opportunity rather than a warning. The tests record both so neither is
 * quietly reversed.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { PageRecord } from '../store/workdir.ts';
import type { PageFacts } from '../extract/page-facts.ts';
import { ALL_CHECKS, runChecks } from './run.ts';

function facts(
  overrides: Partial<PageFacts> & { images?: Partial<PageFacts['images']> } = {},
): PageFacts {
  return {
    title: 'A page',
    meta_description: null,
    heading_levels: [1, 2, 2],
    robots: { index: true, follow: true, raw: null },
    hreflang: [],
    html_lang: 'en-GB',
    landmarks: { has_main: true, has_article: false },
    text: {
      dom_words: 400,
      extractable_words: 300,
      main_words: 280,
      aside_words: 0,
      hidden_words: 0,
    },
    content_simhash: 'abcdef0123456789',
    ...overrides,
    images: { total: 4, missing_alt: 0, suspect_alt: [], ...(overrides.images ?? {}) },
  };
}

let sequence = 0;
function page(pageFacts: PageFacts): PageRecord {
  sequence += 1;
  return {
    page_id: `p${sequence}`,
    url: `https://example.com/p${sequence}`,
    canonical_url: `https://example.com/p${sequence}`,
    declared_canonical: null,
    source: 'sitemap:https://example.com/s.xml',
    http_status: 200,
    redirect_chain: [],
    content_type: 'text/html',
    fetched_at: '2026-08-09T00:00:00Z',
    content_sha256: `sha-${sequence}`,
    bytes: 20_000,
    html_purged: false,
    microdata_types: [],
    extraction: {
      json_ld_blocks: 0,
      json_ld_failed: 0,
      microdata_items: 0,
      rdfa_items: 0,
      nodes: 0,
    },
    page_facts: pageFacts,
    errors: [],
  };
}

const only = (pages: PageRecord[], check: string) =>
  runChecks({ nodes: [], pages, partialCoverage: false }).findings.filter((f) => f.check === check);

// --- titles and headings -----------------------------------------------------

test('a missing title is an error', () => {
  const findings = only([page(facts({ title: null }))], 'page.title-missing');
  assert.equal(findings.length, 1);
  assert.equal(findings[0]?.severity, 'error');
});

test('a missing h1 is a warning, reported once for the site', () => {
  const findings = only(
    [page(facts({ heading_levels: [2, 3] })), page(facts({ heading_levels: [2] }))],
    'page.h1-missing',
  );
  assert.equal(findings.length, 1, 'one finding, not one per page');
  assert.equal(findings[0]?.pages_affected, 2);
});

/**
 * Several `h1`s is an **opportunity**, and the wording must not call it broken.
 *
 * The one-h1 rule is HTML4 and is still repeated as though it applied. HTML5
 * sectioning permits several and Google has said so. 205 of 1,831 corpus pages
 * have more than one, 144 of them on a single site — reporting that as a defect
 * would be wrong on the facts and useless in practice.
 */
test('multiple h1 is an opportunity that says it is valid HTML', () => {
  const findings = only([page(facts({ heading_levels: [1, 1, 2] }))], 'page.h1-multiple');
  assert.equal(findings.length, 1);
  assert.equal(findings[0]?.severity, 'opportunity');
  assert.match(findings[0]?.summary ?? '', /valid HTML/);
  assert.notEqual(findings[0]?.tradeoff, null, 'it must name the trade-off, not assert a fix');
});

/**
 * `page.heading-sequence` is deliberately **not built**.
 *
 * 549 of 1,831 corpus pages skip a heading level — 29%. At that incidence it is
 * normal practice, not a defect, and a slightly malformed outline does not stop
 * a machine consuming the page. It fails `07`'s admission test.
 */
test('skipped heading levels are not a check', () => {
  assert.equal(
    ALL_CHECKS.some((check) => check.id === 'page.heading-sequence'),
    false,
    'if this is being added, re-read why it was removed: 29% of the corpus trips it',
  );
  // A page skipping h2 -> h4 produces nothing at all.
  const findings = runChecks({
    nodes: [],
    pages: [page(facts({ heading_levels: [1, 2, 4, 6] }))],
    partialCoverage: false,
  }).findings.filter((finding) => finding.check.startsWith('page.'));
  assert.deepEqual(findings, []);
});

// --- images ------------------------------------------------------------------

test('images with no alt attribute are counted across the site', () => {
  const findings = only(
    [
      page(facts({ images: { total: 10, missing_alt: 3, suspect_alt: [] } })),
      page(facts({ images: { total: 10, missing_alt: 2, suspect_alt: [] } })),
    ],
    'page.image-alt-missing',
  );

  assert.equal(findings.length, 1);
  assert.match(findings[0]?.title ?? '', /5 image/);
  assert.equal(findings[0]?.pages_affected, 2);
  // An explicitly empty alt is the correct way to mark decoration, and the
  // finding has to say so or it reads as "add alt text to everything".
  assert.match(findings[0]?.summary ?? '', /decorative/);
});

test('useless alt text is reported with the values seen', () => {
  const findings = only(
    [page(facts({ images: { total: 3, missing_alt: 0, suspect_alt: ['1000005782', 'IMG'] } }))],
    'page.image-alt-useless',
  );
  assert.equal(findings.length, 1);
  assert.match(findings[0]?.summary ?? '', /1000005782/);
});

// --- language and duplicate titles -------------------------------------------

test('a missing lang is an opportunity', () => {
  const findings = only([page(facts({ html_lang: null }))], 'page.lang-missing');
  assert.equal(findings.length, 1);
  assert.equal(findings[0]?.severity, 'opportunity');
});

test('duplicate titles report the titles, not a list of URLs', () => {
  const findings = only(
    [
      page(facts({ title: 'Shop' })),
      page(facts({ title: 'Shop' })),
      page(facts({ title: 'About' })),
    ],
    'page.title-duplicate',
  );

  assert.equal(findings.length, 1);
  assert.equal(findings[0]?.pages_affected, 2, 'only the colliding pages');
  // The shared title is what an operator acts on. A list of URLs says which
  // pages collide without saying what they collide on.
  assert.match(findings[0]?.observed[0]?.value ?? '', /"Shop" — 2 pages/);
});

test('distinct titles are silent', () => {
  assert.deepEqual(
    only([page(facts({ title: 'One' })), page(facts({ title: 'Two' }))], 'page.title-duplicate'),
    [],
  );
});
