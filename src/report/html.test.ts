import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { Finding } from '../checks/run.ts';
import type { Report } from './build.ts';
import { renderHtml } from './html.ts';

function report(overrides: Partial<Report> = {}): Report {
  return {
    schemanator: { version: '1.0.1', report_schema: 1 },
    run: {
      run_id: '20260802T120000Z',
      site_slug: 'example.com',
      site_origin: 'https://example.com',
      started_at: '2026-08-02T12:00:00Z',
      finished_at: '2026-08-02T12:05:00Z',
    },
    coverage: {
      complete: true,
      urls_discovered: 47,
      urls_queued: 47,
      pages_fetched: 47,
      pages_extracted: 47,
      truncated: null,
      sample_strategy: 'spread',
      caveat: null,
    },
    graph: { nodes: 766, entities: 198, pages_with_data: 47, json_ld_blocks: 60, malformed_blocks: 0 },
    summary: { by_severity: {}, by_check: {}, silenced: {}, checks_run: ['entity.contradiction'], checks_disabled: [] },
    findings: [],
    ...overrides,
  };
}

function finding(overrides: Partial<Finding> = {}): Finding {
  return {
    finding_id: 'abc123def456',
    check: 'entity.contradiction',
    severity: 'error',
    origin: 'check',
    title: 'url has 2 different values under one @id',
    subject: { kind: 'entity', id: 'https://example.com/#organization', property: 'http://schema.org/url' },
    summary: 'The same @id carries 2 different values.',
    expected: 'One url value.',
    observed: [
      {
        value: JSON.stringify([JSON.stringify({ '@id': 'https://example.com/about/' })]),
        observation_count: 120,
        page_count: 120,
        provenance: [
          { page_id: 'about-1', url: 'https://example.com/about/', syntax: 'json-ld', block: 0, pointer: '/5' },
        ],
      },
    ],
    pages_affected: 150,
    coverage_qualified: false,
    remediation: 'Emit a single url.',
    tradeoff: null,
    ...overrides,
  };
}

// --- self-contained ----------------------------------------------------------

test('makes no external request of any kind', () => {
  // `05`: one file, so it survives being emailed, attached to a ticket, or
  // opened from an archive years later. Any fetch either fails in those cases
  // or leaks that the file was opened.
  const html = renderHtml(report({ findings: [finding()] }));

  assert.equal(/<link\b/i.test(html), false, 'a <link> element would fetch a stylesheet');
  assert.equal(/<img\b/i.test(html), false, 'an <img> would fetch an image');
  assert.equal(/@import/i.test(html), false, '@import fetches a stylesheet');
  assert.equal(/url\(/i.test(html), false, 'url() in CSS can fetch');
  assert.equal(/\ssrc=/i.test(html), false, 'a src attribute fetches');
});

test('contains no script', () => {
  // A file that arrives by email and runs script is indistinguishable from
  // something a mail client should block, and half of them will.
  const html = renderHtml(report({ findings: [finding()] }));

  assert.equal(/<script/i.test(html), false);
  assert.equal(/\son[a-z]+\s*=/i.test(html), false, 'an inline event handler is script');
  assert.equal(/javascript:/i.test(html), false);
});

test('carries its own styles', () => {
  const html = renderHtml(report());
  assert.match(html, /<style>/);
  assert.match(html, /prefers-color-scheme/, 'an archived report gets opened at odd hours');
  assert.match(html, /@media print/, 'these get printed to PDF and attached to tickets');
});

// --- escaping ----------------------------------------------------------------

test('markup in a finding is escaped, not rendered', () => {
  // Every string in a report is copied out of somebody else's markup. A site
  // publishing `<script>` in a `name` must not get it executed in a report the
  // operator opens.
  const hostile = '<script>alert(1)</script>';
  const html = renderHtml(
    report({
      findings: [
        finding({
          title: hostile,
          summary: hostile,
          expected: hostile,
          remediation: hostile,
          tradeoff: hostile,
          subject: { kind: 'entity', id: hostile },
        }),
      ],
    }),
  );

  assert.equal(html.includes('<script>alert(1)</script>'), false, 'raw script survived into the output');
  assert.match(html, /&lt;script&gt;/, 'it should appear escaped, and visibly');
});

test('markup in an observed value or provenance URL is escaped', () => {
  const html = renderHtml(
    report({
      findings: [
        finding({
          observed: [
            {
              value: '"><script>alert(1)</script>',
              observation_count: 1,
              page_count: 1,
              provenance: [
                {
                  page_id: 'x',
                  url: 'https://example.com/"><script>alert(1)</script>',
                  syntax: 'json-ld',
                  block: 0,
                  pointer: '/0',
                },
              ],
            },
          ],
        }),
      ],
    }),
  );

  assert.equal(html.includes('<script>'), false);
  assert.equal(html.includes('"><script'), false, 'an attribute break would let markup out');
});

test('the site origin is escaped in both the title and the heading', () => {
  const html = renderHtml(report({ run: { ...report().run, site_origin: 'https://x.example/"><script>' } }));
  assert.equal(html.includes('<script>'), false);
});

// --- structure ---------------------------------------------------------------

test('the coverage caveat comes before any finding', () => {
  // The single most misleading thing about a partial report, so it leads.
  const html = renderHtml(
    report({
      coverage: { ...report().coverage, complete: false, caveat: 'Only 20 of 8,341 URLs were audited.' },
      findings: [finding()],
    }),
  );

  const caveatAt = html.indexOf('Partial coverage');
  const findingAt = html.indexOf('class="finding');
  assert.notEqual(caveatAt, -1, 'the caveat is missing');
  assert.equal(caveatAt < findingAt, true, 'the caveat must precede the findings');
});

test('no caveat is rendered when coverage is complete', () => {
  assert.equal(renderHtml(report({ findings: [finding()] })).includes('Partial coverage'), false);
});

test('findings are grouped by severity, errors first', () => {
  const html = renderHtml(
    report({
      findings: [
        finding({ severity: 'opportunity', finding_id: 'opp', title: 'An opportunity' }),
        finding({ severity: 'error', finding_id: 'err', title: 'An error' }),
        finding({ severity: 'warning', finding_id: 'warn', title: 'A warning' }),
      ],
    }),
  );

  const order = ['Errors (1)', 'Warnings (1)', 'Opportunities (1)'].map((heading) => html.indexOf(heading));
  assert.equal(order.every((at) => at !== -1), true, 'a severity heading is missing');
  assert.deepEqual([...order].sort((left, right) => left - right), order, 'severities are out of order');
});

test('severity is conveyed in text, not only in colour', () => {
  // These get printed on mono printers and read by people who cannot
  // distinguish the accent colours.
  const html = renderHtml(report({ findings: [finding({ severity: 'warning' })] }));
  assert.match(html, /class="sev">Warning</);
});

test('a clean report says so rather than rendering an empty section', () => {
  const html = renderHtml(report());
  assert.match(html, /None\. Every check ran and found nothing to report\./);
});

test('silenced counts are shown, so silence can be audited', () => {
  const html = renderHtml(
    report({ summary: { ...report().summary, silenced: { 'entity.partiality': 11 } } }),
  );
  assert.match(html, /Considered and not reported/);
  assert.match(html, /entity\.partiality/);
  assert.match(html, /11 instances/);
});

test('coverage-qualified and trade-off notes are rendered', () => {
  const html = renderHtml(
    report({ findings: [finding({ coverage_qualified: true, tradeoff: 'Content-matching versus consistency.' })] }),
  );
  assert.match(html, /Qualified by coverage/);
  assert.match(html, /Trade-off:/);
});

test('disabled checks are listed, so a quiet report is never quietly quiet', () => {
  const html = renderHtml(
    report({ summary: { ...report().summary, checks_disabled: ['graph.dangling-reference'] } }),
  );
  assert.match(html, /Disabled:/);
  assert.match(html, /graph\.dangling-reference/);
});

test('the document is well-formed enough to open anywhere', () => {
  const html = renderHtml(report({ findings: [finding()] }));

  assert.match(html, /^<!doctype html>/);
  assert.match(html, /<html lang="en">/);
  assert.match(html, /<meta charset="utf-8">/);
  assert.match(html, /<meta name="viewport"/, 'it gets opened on phones');
  assert.match(html, /<meta name="robots" content="noindex, nofollow">/);
  assert.equal(html.trimEnd().endsWith('</html>'), true);

  // Tags opened are tags closed, for the containers that carry the content.
  for (const tag of ['html', 'head', 'body', 'main', 'article', 'ul', 'table']) {
    const open = (html.match(new RegExp(`<${tag}[\\s>]`, 'g')) ?? []).length;
    const close = (html.match(new RegExp(`</${tag}>`, 'g')) ?? []).length;
    assert.equal(open, close, `<${tag}> opened ${open} times, closed ${close}`);
  }
});
