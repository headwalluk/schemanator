/**
 * Every list a check shortens must be shortened by a named constant, and must
 * say what it left out.
 *
 * Two failures, one class. The catalogue capped `observed` at 3, 5, 8, 10 and 15
 * across two dozen call sites, every one a bare literal — so there was no
 * decision to review, only whatever the file's author typed that day. And none
 * of them said they had capped anything, so a truncated list was indistinguishable
 * from a complete one. A reader of a real report took the second for the first,
 * disbelieved a correct summary because the evidence beneath it looked too short
 * to support it, and published a wrong diagnosis (`dev-notes/10`, findings 3 and
 * 4). The summary was right the whole time.
 *
 * The prose version of both rules is in `CLAUDE.md` — *no magic numbers* and
 * *named constants carry their evidence* — and prose reads identically whether
 * or not the code follows it. This is the test that makes it true.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { ExtractedNode } from '../extract/types.ts';
import type { PageRecord } from '../store/workdir.ts';
import { OBSERVED_SAMPLE, sampleObserved } from './framework.ts';
import { AGGREGATE_SAMPLE, runChecks } from './run.ts';

const CHECKS_DIR = path.dirname(fileURLToPath(import.meta.url));

/** `.slice(0, 5)` and friends. A named constant in the same position passes. */
const BARE_SLICE = /\.slice\(\s*0,\s*\d/;

/** `coverage_qualified: true`, which is a claim rather than a measurement. */
const HARDCODED_QUALIFIER = /coverage_qualified:\s*true/;

test('no check asserts it was qualified by coverage', () => {
  // The renderers turn this field into a flat statement of fact — "this finding
  // depends on pages that were not all fetched" — so a hardcoded `true` prints
  // that sentence on a crawl that fetched everything it discovered.
  //
  // Four checks did. Three of them return early when coverage is partial, so
  // they could only ever emit on a complete crawl and the sentence was wrong
  // every single time it appeared. Found 2026-08-22 on a 564-page site whose
  // own summary table, six lines above, read "564 of 564 discovered".
  //
  // A source rule rather than only a behavioural one, because the behavioural
  // version can only see checks that a fixture makes fire — and when it was
  // written first, reinstating one of the four left the suite green.
  //
  // The legal values are `false` and `partialCoverage`. Both are answers; a
  // literal `true` is an assertion nobody measured.
  const offenders: string[] = [];

  for (const file of fs.readdirSync(CHECKS_DIR).sort()) {
    if (!file.endsWith('.ts') || file.endsWith('.test.ts')) continue;
    const lines = fs.readFileSync(path.join(CHECKS_DIR, file), 'utf8').split('\n');
    lines.forEach((line, index) => {
      if (/^\s*(\*|\/\/)/.test(line)) return;
      if (HARDCODED_QUALIFIER.test(line)) offenders.push(`${file}:${index + 1}: ${line.trim()}`);
    });
  }

  assert.deepEqual(
    offenders,
    [],
    'coverage_qualified must track partialCoverage or be false — never asserted true',
  );
});

test('no check module truncates a list with a bare number', () => {
  const offenders: string[] = [];

  for (const file of fs.readdirSync(CHECKS_DIR).sort()) {
    if (!file.endsWith('.ts') || file.endsWith('.test.ts')) continue;
    const lines = fs.readFileSync(path.join(CHECKS_DIR, file), 'utf8').split('\n');
    lines.forEach((line, index) => {
      // Comments describe the fault; they are not it.
      if (/^\s*(\*|\/\/)/.test(line)) return;
      if (BARE_SLICE.test(line)) offenders.push(`${file}:${index + 1}: ${line.trim()}`);
    });
  }

  assert.deepEqual(
    offenders,
    [],
    'a cap written as a literal is a decision nobody can review — name it, or take ' +
      'the sample through sampleObserved()',
  );
});

// --- the runtime half --------------------------------------------------------

const S = (name: string): string => `http://schema.org/${name}`;

/**
 * More subjects than any cap, so every list in the report is a truncated one.
 *
 * 40 pages is enough: `OBSERVED_SAMPLE` and `AGGREGATE_SAMPLE` are both 10, and
 * the point is to overflow them rather than to measure anything.
 */
const PAGES = 40;

function fixture(): { nodes: ExtractedNode[]; pages: PageRecord[] } {
  const nodes: ExtractedNode[] = [];
  const pages: PageRecord[] = [];

  for (let index = 0; index < PAGES; index += 1) {
    const pageId = `p${index}`;
    pages.push({
      page_id: pageId,
      url: `https://example.com/${pageId}`,
      canonical_url: `https://example.com/${pageId}`,
      declared_canonical: null,
      source: 'sitemap:https://example.com/sitemap.xml',
      http_status: 200,
      redirect_chain: [],
      content_type: 'text/html',
      fetched_at: '2026-08-14T00:00:00Z',
      content_sha256: `sha-${pageId}`,
      bytes: 1000,
      html_purged: false,
      microdata_types: [],
      page_facts: null,
      extraction: {
        json_ld_blocks: 1,
        json_ld_failed: 0,
        microdata_items: 0,
        rdfa_items: 0,
        nodes: 2,
      },
      errors: [],
    });

    const source = { syntax: 'json-ld' as const, block: 0, pointer: `/${index}` };

    // One sitewide entity that disagrees with itself on every page, and one
    // per-page Product with nothing Google asks for. Between them they overflow
    // both an `observed` list and an aggregate.
    nodes.push({
      node_id: 'https://example.com/#org',
      raw_id: null,
      is_blank: false,
      page_id: pageId,
      types: [S('LocalBusiness')],
      props: { [S('name')]: [{ '@value': `Acme ${index}` }] },
      source,
    });
    nodes.push({
      node_id: `https://example.com/${pageId}#product`,
      raw_id: null,
      is_blank: false,
      page_id: pageId,
      types: [S('Product')],
      props: { [S('name')]: [{ '@value': 'Thing' }] },
      source,
    });
  }

  return { nodes, pages };
}

test('no observed list runs away with the size of the site', () => {
  const { nodes, pages } = fixture();
  const { findings } = runChecks({ nodes, pages, partialCoverage: false });

  const ceiling = Math.max(OBSERVED_SAMPLE, AGGREGATE_SAMPLE);
  const oversized = findings
    .filter((finding) => finding.observed.length > ceiling)
    .map((finding) => `${finding.check}: ${finding.observed.length} rows`);

  assert.deepEqual(
    oversized,
    [],
    `an observed list is unbounded — every row is carried in report.json, so this ` +
      `scales the contract with the site rather than with the problem`,
  );
});

test('a list that was cut says how much it cut', () => {
  const { nodes, pages } = fixture();
  const { findings } = runChecks({ nodes, pages, partialCoverage: false });

  // Something must actually have overflowed, or this test passes by silence —
  // the failure mode every invariant in this repo is written against.
  const truncated = findings.filter((finding) => (finding.omitted_count ?? 0) > 0);
  assert.equal(
    truncated.length > 0,
    true,
    `${PAGES} pages produced no truncated list at all — the fixture has stopped exercising the caps`,
  );

  const wrong: string[] = [];
  for (const finding of findings) {
    const omitted = finding.omitted_count ?? 0;
    if (!Number.isInteger(omitted) || omitted < 0) {
      wrong.push(`${finding.check}: omitted_count is ${omitted}`);
    }
    // Rows were dropped while the list has room left in it: whatever did the
    // cutting was not the cap, and the number cannot be trusted.
    if (omitted > 0 && finding.observed.length < OBSERVED_SAMPLE) {
      wrong.push(
        `${finding.check}: claims ${omitted} omitted but lists only ${finding.observed.length}`,
      );
    }
  }

  assert.deepEqual(wrong, [], 'omitted_count must be the truth about what is missing');
});

test('sampleObserved counts observations it dropped, not just the ones it kept', () => {
  // The property the aggregate depends on. A constituent that answers with its
  // sample undercounts by exactly what it truncated, which is how an aggregate
  // row came to claim 1,000 pages on one observation.
  const rows = Array.from({ length: OBSERVED_SAMPLE + 5 }, (_unused, index) => ({
    value: `row-${index}`,
    observation_count: 2,
    page_count: 2,
    provenance: [],
  }));

  const sampled = sampleObserved(rows);

  assert.equal(sampled.observed.length, OBSERVED_SAMPLE);
  assert.equal(sampled.omitted_count, 5);
  assert.equal(sampled.observation_total, (OBSERVED_SAMPLE + 5) * 2);

  const complete = sampleObserved(rows.slice(0, 3));
  assert.equal(complete.omitted_count, 0, 'a complete list omits nothing');
  assert.equal(complete.observation_total, 6);
});
