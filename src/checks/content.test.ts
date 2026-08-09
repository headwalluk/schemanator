/**
 * Tests for group `content`.
 *
 * The two "does not fire" cases pin false positives the corpus produced while
 * these were being written — 91 findings and then 48 more, none of them real.
 * Both looked entirely reasonable as rules.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { PageRecord } from '../store/workdir.ts';
import type { PageFacts } from '../extract/page-facts.ts';
import { runChecks } from './run.ts';

function facts(overrides: {
  dom?: number;
  extractable?: number;
  main?: number;
  aside?: number;
  hidden?: number;
  hasMain?: boolean;
  hasArticle?: boolean;
}): PageFacts {
  return {
    title: 'A page',
    meta_description: null,
    heading_levels: [1],
    robots: { index: true, follow: true, raw: null },
    hreflang: [],
    html_lang: 'en-GB',
    landmarks: {
      has_main: overrides.hasMain ?? true,
      has_article: overrides.hasArticle ?? false,
    },
    images: { total: 0, missing_alt: 0, suspect_alt: [] },
    text: {
      dom_words: overrides.dom ?? 500,
      extractable_words: overrides.extractable ?? 400,
      main_words: overrides.main ?? 380,
      aside_words: overrides.aside ?? 0,
      hidden_words: overrides.hidden ?? 0,
    },
    content_simhash: 'abcdef0123456789',
  };
}

let sequence = 0;
function page(pageFacts: PageFacts | null, bytes = 20_000): PageRecord {
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
    bytes,
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

const content = (pages: PageRecord[], check: string) =>
  runChecks({ nodes: [], pages, partialCoverage: false }).findings.filter(
    (finding) => finding.check === check,
  );

// --- content.not-extractable -------------------------------------------------

test('text outside the landmarks is reported', () => {
  // The case the group exists for: a 2,000-word article whose landmarks hold 32.
  const findings = content(
    [page(facts({ extractable: 2030, main: 32, hasArticle: true }))],
    'content.not-extractable',
  );

  assert.equal(findings.length, 1);
  assert.equal(findings[0]?.severity, 'error');
  assert.match(findings[0]?.observed[0]?.value ?? '', /landmarks hold 32 of 2030/);
});

test('a page whose landmarks hold its content is silent', () => {
  assert.deepEqual(
    content([page(facts({ extractable: 400, main: 380 }))], 'content.not-extractable'),
    [],
  );
});

test('a thin page is not a finding, because thinness is not our business', () => {
  // 2 of 12 words is 17%, under the threshold — and it is a short page, which
  // is the copywriter's call rather than a machine-readability defect.
  assert.deepEqual(
    content([page(facts({ extractable: 12, main: 2 }))], 'content.not-extractable'),
    [],
  );
});

test('a page with no landmark at all is the other check, not this one', () => {
  assert.deepEqual(
    content(
      [page(facts({ extractable: 800, main: 0, hasMain: false, hasArticle: false }))],
      'content.not-extractable',
    ),
    [],
  );
});

// --- content.no-landmark -----------------------------------------------------

test('missing landmarks are reported once for the site, not once per page', () => {
  // A quarter of the corpus qualifies. Per page this would drown the report,
  // and it is one template decision however many pages carry it.
  const pages = Array.from({ length: 40 }, () =>
    page(facts({ extractable: 300, main: 0, hasMain: false, hasArticle: false })),
  );
  const findings = content(pages, 'content.no-landmark');

  assert.equal(findings.length, 1);
  assert.equal(findings[0]?.pages_affected, 40);
  assert.equal(findings[0]?.severity, 'opportunity');
});

// --- content.javascript-only -------------------------------------------------

test('a large response with almost no text is reported', () => {
  const findings = content([page(facts({ dom: 63 }), 52_000)], 'content.javascript-only');
  assert.equal(findings.length, 1);
  assert.equal(findings[0]?.severity, 'error');
  // The limitation is the measurement, and the finding should say so.
  assert.match(findings[0]?.summary ?? '', /does not run JavaScript/);
});

test('a small page with little text is just a small page', () => {
  // A contact page is allowed to be short. Only a *large* response with no text
  // is evidence of client-side rendering.
  assert.deepEqual(content([page(facts({ dom: 63 }), 8_000)], 'content.javascript-only'), []);
});

// --- content.main-in-aside ---------------------------------------------------

test('more text in aside than in main is reported', () => {
  const findings = content([page(facts({ main: 40, aside: 600 }))], 'content.main-in-aside');
  assert.equal(findings.length, 1);
  assert.equal(findings[0]?.severity, 'warning');
});

test('a normal sidebar is not a finding', () => {
  assert.deepEqual(content([page(facts({ main: 800, aside: 90 }))], 'content.main-in-aside'), []);
});

// --- content.hidden-text -----------------------------------------------------

test('a page hiding more substance than it shows is reported', () => {
  const findings = content([page(facts({ extractable: 200, hidden: 400 }))], 'content.hidden-text');
  assert.equal(findings.length, 1);
});

/**
 * The false positive, twice over.
 *
 * First: hidden *navigation* counted as hidden content. A mobile menu marked
 * `aria-hidden` and a sticky top bar are on every page and conceal nothing —
 * counting them fired on 91 corpus pages. `hidden_words` is now computed after
 * chrome is known, so this fixture reflects what extraction produces.
 *
 * Second: 48 colour-swatch pages with 17 visible words tripped "more hidden
 * than visible" simply by being sparse. The claim is that a page's *substance*
 * is concealed, so it has to have substance.
 */
test('a sparse page is not concealing anything', () => {
  assert.deepEqual(
    content([page(facts({ extractable: 17, hidden: 73 }))], 'content.hidden-text'),
    [],
  );
});

// --- shared ------------------------------------------------------------------

test('pages without facts are skipped rather than guessed at', () => {
  // An older crawl has no `page_facts`. Reporting an absence from missing data
  // would be inventing a finding.
  const findings = runChecks({
    nodes: [],
    pages: [page(null), page(null)],
    partialCoverage: false,
  }).findings.filter((finding) => finding.check.startsWith('content.'));

  assert.deepEqual(findings, []);
});

test('a non-200 page is never a content finding', () => {
  const dead = { ...page(facts({ dom: 10 }), 60_000), http_status: 404 };
  assert.deepEqual(content([dead], 'content.javascript-only'), []);
});
