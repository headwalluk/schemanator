import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { Finding } from '../checks/run.ts';
import type { Report } from './build.ts';
import { diffReports, directionOf } from './diff.ts';
import { renderDiffMarkdown } from './diff-markdown.ts';

function finding(overrides: Partial<Finding> = {}): Finding {
  return {
    finding_id: 'aaa111',
    check: 'entity.contradiction',
    severity: 'error',
    origin: 'check',
    title: 'telephone has 2 different values under one @id',
    subject: {
      kind: 'entity',
      id: 'https://example.com/#org',
      property: 'http://schema.org/telephone',
    },
    summary: 'x',
    expected: 'y',
    observed: [{ value: '+44 1', observation_count: 100, page_count: 100, provenance: [] }],
    pages_affected: 100,
    coverage_qualified: false,
    remediation: null,
    tradeoff: null,
    ...overrides,
  };
}

function report(
  findings: Finding[],
  overrides: Partial<Report['coverage']> = {},
  runId = 'RUN',
): Report {
  return {
    schemanator: { version: '0.1.0', report_schema: 1 },
    run: {
      run_id: runId,
      site_slug: 'example.com',
      site_origin: 'https://example.com',
      started_at: '2026-08-01T00:00:00Z',
      finished_at: '2026-08-01T00:05:00Z',
    },
    coverage: {
      complete: true,
      urls_discovered: 100,
      urls_queued: 100,
      pages_fetched: 100,
      pages_extracted: 100,
      truncated: null,
      sample_strategy: 'spread',
      caveat: null,
      ...overrides,
    },
    graph: { nodes: 1, entities: 1, pages_with_data: 100, json_ld_blocks: 1, malformed_blocks: 0 },
    summary: { by_severity: {}, by_check: {}, silenced: {}, checks_run: [], checks_disabled: [] },
    findings,
  };
}

test('a fixed finding is resolved', () => {
  const diff = diffReports(report([finding()]), report([]));
  assert.equal(diff.summary.resolved, 1);
  assert.equal(diff.summary.appeared, 0);
});

test('a newly introduced finding appears', () => {
  const diff = diffReports(report([]), report([finding()]));
  assert.equal(diff.summary.appeared, 1);
  assert.equal(diff.summary.resolved, 0);
});

test('an untouched finding is unchanged, not resolved-and-new', () => {
  const diff = diffReports(report([finding()]), report([finding()]));
  assert.equal(diff.summary.unchanged, 1);
  assert.equal(diff.summary.resolved, 0);
  assert.equal(diff.summary.appeared, 0);
});

test('a HALF-fixed finding is Changed — the case the whole design exists for', () => {
  // 100 pages down to 5. If ids named the answer rather than the question, this
  // would read as one resolved plus one new, and the loop would report progress
  // and a regression simultaneously for a single improvement.
  const before = report([
    finding({
      pages_affected: 100,
      observed: [{ value: '+44 1', observation_count: 100, page_count: 100, provenance: [] }],
    }),
  ]);
  const after = report([
    finding({
      pages_affected: 5,
      observed: [{ value: '+44 1', observation_count: 5, page_count: 5, provenance: [] }],
    }),
  ]);

  const diff = diffReports(before, after);
  assert.equal(diff.summary.changed, 1);
  assert.equal(diff.summary.resolved, 0);
  assert.equal(diff.summary.appeared, 0);
  assert.equal(directionOf(diff.changed[0]!), 'improved');
});

test('a worsening finding is Changed and reads as worsened', () => {
  const diff = diffReports(
    report([finding({ pages_affected: 5 })]),
    report([finding({ pages_affected: 50 })]),
  );
  assert.equal(directionOf(diff.changed[0]!), 'worsened');
  assert.match(renderDiffMarkdown(diff, 'https://example.com'), /WORSENED/);
});

test('prose changes alone do not count as a change', () => {
  // The signature covers evidence, not wording — otherwise every reworded
  // summary would look like site movement.
  const diff = diffReports(
    report([finding({ summary: 'old wording', remediation: 'old advice' })]),
    report([finding({ summary: 'new wording', remediation: 'new advice' })]),
  );
  assert.equal(diff.summary.unchanged, 1);
  assert.equal(diff.summary.changed, 0);
});

// --- the trap: coverage drift ------------------------------------------------

test('a shrunken crawl warns rather than claiming success', () => {
  // Crawl 100, fix nothing, crawl 40: everything "resolves" because the
  // evidence was not looked at. A loop that congratulates you for shrinking
  // the sample is worse than no loop.
  const diff = diffReports(
    report([finding()], { pages_extracted: 100 }),
    report([], { pages_extracted: 40 }),
  );
  assert.equal(diff.summary.resolved, 1);
  assert.notEqual(diff.coverage_warning, null);
  assert.match(diff.coverage_warning ?? '', /60% fewer/);
});

test('a grown crawl warns that new findings may be newly visible', () => {
  const diff = diffReports(
    report([], { pages_extracted: 100 }),
    report([finding()], { pages_extracted: 200 }),
  );
  assert.match(diff.coverage_warning ?? '', /newly \*visible\*/);
});

test('comparable coverage produces no warning', () => {
  const diff = diffReports(
    report([finding()], { pages_extracted: 100 }),
    report([finding()], { pages_extracted: 98 }),
  );
  assert.equal(diff.coverage_warning, null);
});

test('a changed sample strategy is called out', () => {
  const diff = diffReports(
    report([], { sample_strategy: 'spread' }),
    report([], { sample_strategy: 'document' }),
  );
  assert.match(diff.coverage_warning ?? '', /Sample strategy changed/);
});

test('an empty run makes the diff meaningless and says so', () => {
  const diff = diffReports(report([finding()]), report([], { pages_extracted: 0 }));
  assert.match(diff.coverage_warning ?? '', /means nothing/);
});

// --- rendering ----------------------------------------------------------------

test('the coverage warning leads the document', () => {
  const output = renderDiffMarkdown(
    diffReports(report([finding()], { pages_extracted: 100 }), report([], { pages_extracted: 20 })),
    'https://example.com',
  );
  assert.equal(output.indexOf('Coverage changed') < output.indexOf('## Summary'), true);
});

test('a clean-to-clean diff says so rather than printing empty sections', () => {
  const output = renderDiffMarkdown(diffReports(report([]), report([])), 'https://example.com');
  assert.match(output, /Both runs were clean/);
});

test('no movement is stated plainly', () => {
  const output = renderDiffMarkdown(
    diffReports(report([finding()]), report([finding()])),
    'https://example.com',
  );
  assert.match(output, /Nothing changed\. 1 finding\(s\) still open\./);
});

test('resolved findings are listed with the id that proves it', () => {
  const output = renderDiffMarkdown(
    diffReports(report([finding()]), report([])),
    'https://example.com',
  );
  assert.match(output, /## Resolved \(1\)/);
  assert.match(output, /`aaa111`/);
});
