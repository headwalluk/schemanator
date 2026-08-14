import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { Finding } from '../checks/run.ts';
import type { Report } from './build.ts';
import { renderMarkdown } from './markdown.ts';

function report(overrides: Partial<Report> = {}): Report {
  return {
    schemanator: { version: '0.1.0', report_schema: 1 },
    run: {
      run_id: '20260801T120000Z',
      site_slug: 'example.com',
      site_origin: 'https://example.com',
      started_at: '2026-08-01T12:00:00Z',
      finished_at: '2026-08-01T12:05:00Z',
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
    graph: {
      nodes: 766,
      entities: 198,
      pages_with_data: 47,
      json_ld_blocks: 60,
      malformed_blocks: 0,
    },
    summary: {
      by_severity: {},
      by_check: {},
      silenced: {},
      checks_run: ['entity.contradiction'],
      checks_disabled: [],
    },
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
    subject: {
      kind: 'entity',
      id: 'https://example.com/#organization',
      property: 'http://schema.org/url',
    },
    summary: 'The same @id carries 2 different values.',
    expected: 'One url value.',
    observed: [
      {
        value: JSON.stringify([JSON.stringify({ '@id': 'https://example.com/about/' })]),
        observation_count: 120,
        page_count: 120,
        provenance: [
          {
            page_id: 'about-1',
            url: 'https://example.com/about/',
            syntax: 'json-ld',
            block: 0,
            pointer: '/5',
          },
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

test('renders a clean report when nothing was found', () => {
  const output = renderMarkdown(report());
  assert.match(output, /# schemanator — https:\/\/example\.com/);
  assert.match(output, /None\. Every check ran and found nothing to report\./);
});

test('the coverage caveat comes before any finding', () => {
  const output = renderMarkdown(
    report({
      coverage: { ...report().coverage, complete: false, caveat: '60 of 8341 URLs were audited.' },
      findings: [finding()],
    }),
  );

  // The single most misleading thing about a partial report, so it leads.
  assert.match(output, /Partial coverage/);
  assert.equal(output.indexOf('Partial coverage') < output.indexOf('## Errors'), true);
});

test('no caveat appears when coverage is complete', () => {
  assert.equal(renderMarkdown(report()).includes('Partial coverage'), false);
});

test('findings are grouped by severity with correct English plurals', () => {
  const output = renderMarkdown(
    report({
      findings: [
        finding({ severity: 'error' }),
        finding({ finding_id: 'b', severity: 'opportunity' }),
        finding({ finding_id: 'c', severity: 'opportunity' }),
      ],
    }),
  );

  assert.match(output, /## Errors \(1\)/);
  assert.match(output, /## Opportunities \(2\)/);
  assert.equal(output.includes('Opportunitys'), false);
  // Errors first: the reader's attention is the scarce resource.
  assert.equal(output.indexOf('## Errors') < output.indexOf('## Opportunities'), true);
});

test('provenance is rendered so a finding can be traced to source', () => {
  const output = renderMarkdown(report({ findings: [finding()] }));
  assert.match(output, /https:\/\/example\.com\/about\//);
  assert.match(output, /`json-ld` block 0, pointer `\/5`/);
});

test('an @id-typed value is unwrapped for display', () => {
  const output = renderMarkdown(report({ findings: [finding()] }));
  // Not the raw JSON-encoded set the check produced.
  assert.match(output, /`https:\/\/example\.com\/about\/` — on 120 page\(s\)/);
  assert.equal(output.includes('\\"@id\\"'), false);
});

test('the identifier is delimited and the annotation is not', () => {
  // A reader copying a row out of a report should get something they can paste
  // into a search box. When the annotation was inside the backticks they got
  // `https://example.com/a — 23 KB, 400 words`, which is not a URL.
  const output = renderMarkdown(
    report({
      findings: [
        finding({
          observed: [
            {
              value: 'https://example.com/a',
              detail: '23 KB, 400 words',
              observation_count: 1,
              page_count: 1,
              provenance: [],
            },
          ],
        }),
      ],
    }),
  );
  assert.match(output, /`https:\/\/example\.com\/a` — 23 KB, 400 words — on 1 page\(s\)/);
});

test('a value that is not page-scoped makes no claim about pages', () => {
  // A crawler token or a type name has a page count of zero, and "on 0 page(s)"
  // reads as a broken tool rather than as a fact.
  const output = renderMarkdown(
    report({
      findings: [
        finding({
          observed: [
            {
              value: 'GPTBot',
              detail: 'OpenAI, training',
              observation_count: 1,
              page_count: 0,
              provenance: [],
            },
          ],
        }),
      ],
    }),
  );
  assert.match(output, /`GPTBot` — OpenAI, training\n/);
  assert.equal(output.includes('0 page'), false);
});

test('silenced counts are shown, so silence reads as a decision', () => {
  const output = renderMarkdown(
    report({ summary: { ...report().summary, silenced: { 'entity.partiality': 1847 } } }),
  );
  assert.match(output, /Considered and not reported/);
  assert.match(output, /entity\.partiality` — 1847 instance/);
});

test('a trade-off is surfaced rather than presented as a fix', () => {
  const output = renderMarkdown(
    report({
      findings: [
        finding({
          severity: 'opportunity',
          tradeoff: 'Content-matching versus entity consistency.',
        }),
      ],
    }),
  );
  assert.match(output, /\*\*Trade-off:\*\* Content-matching versus entity consistency\./);
});

test('a coverage-qualified finding says so', () => {
  const output = renderMarkdown(report({ findings: [finding({ coverage_qualified: true })] }));
  assert.match(output, /Qualified by coverage/);
});

test('the finding id is shown, so two runs can be compared by eye', () => {
  assert.match(renderMarkdown(report({ findings: [finding()] })), /`abc123def456`/);
});

test('output survives being pasted into a chat window', () => {
  const output = renderMarkdown(report({ findings: [finding()] }));
  // No ANSI colour, no box drawing. The escape below is the thing being
  // asserted against, so `no-control-regex` has nothing useful to say here.
  // eslint-disable-next-line no-control-regex
  assert.equal(/\[/.test(output), false);
  assert.equal(/[┌┐└┘│─├┤]/.test(output), false);
});
