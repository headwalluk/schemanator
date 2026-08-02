import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { PageRecord } from '../store/workdir.ts';
import { runChecks } from './run.ts';

/**
 * These two checks fire on nothing in the 22-site corpus — 1,829 pages with no
 * errors, 8 with `http-404`, 1 with a redirect loop, and zero malformed or
 * unresolvable blocks. So this file is the only evidence they work, and the
 * fixtures are synthetic page records carrying the `ld-block-<n>:` errors that
 * `src/extract/run.ts` writes.
 *
 * The coupling is real and worth stating: if extraction ever changes that
 * prefix or those messages, these checks go silent and only this file will say
 * so.
 */
function page(id: string, errors: string[]): PageRecord {
  return {
    page_id: id,
    url: `https://example.com/${id}`,
    canonical_url: `https://example.com/${id}`,
    declared_canonical: null,
    source: 'sitemap',
    http_status: 200,
    redirect_chain: [],
    content_type: 'text/html',
    fetched_at: '2026-08-01T00:00:00Z',
    content_sha256: 'x',
    bytes: 1,
    html_purged: false,
    microdata_types: [],
    extraction: { json_ld_blocks: 1, json_ld_failed: 1, microdata_items: 0, rdfa_items: 0, nodes: 0 },
    errors,
  };
}

const only = (check: string, pages: PageRecord[]) =>
  runChecks({ nodes: [], pages, partialCoverage: false }).findings.filter(
    (finding) => finding.check === check,
  );

test('a block that is not valid JSON is an error', () => {
  const findings = only('syntax.malformed-json', [
    page('a', ['ld-block-0: Unexpected token } in JSON at position 42 — a trailing comma before a closing brace or bracket is the likely cause']),
  ]);

  assert.equal(findings.length, 1);
  assert.equal(findings[0]?.severity, 'error');
  assert.match(findings[0]?.title ?? '', /not valid JSON/);
  assert.match(findings[0]?.observed[0]?.value ?? '', /trailing comma/);
});

test('valid JSON that will not expand is reported as a different problem', () => {
  // Telling someone their valid JSON is malformed sends them hunting for a
  // syntax error that is not there.
  const findings = only('syntax.malformed-json', [
    page('a', ['ld-block-1: expansion failed: invalid @context entry']),
  ]);

  assert.equal(findings.length, 1);
  assert.match(findings[0]?.title ?? '', /valid JSON but could not be expanded/);
});

test('parse and expansion failures are reported separately', () => {
  const findings = only('syntax.malformed-json', [
    page('a', ['ld-block-0: Unexpected end of JSON input']),
    page('b', ['ld-block-0: expansion failed: invalid @context entry']),
  ]);
  assert.equal(findings.length, 2);
});

test('an unresolvable @context is an error naming the context', () => {
  const findings = only('syntax.unresolvable-context', [
    page('a', [
      'ld-block-0: refusing to fetch remote context https://vocab.example/v1. Only the bundled schema.org context is available; a crawl that depends on a third-party server being reachable is not reproducible.',
    ]),
  ]);

  assert.equal(findings.length, 1);
  assert.equal(findings[0]?.severity, 'error');
  assert.equal(findings[0]?.subject.id, 'https://vocab.example/v1');
});

test('one unresolvable context across many pages is one finding', () => {
  const context =
    'ld-block-0: refusing to fetch remote context https://vocab.example/v1. Only the bundled schema.org context is available; a crawl that depends on a third-party server being reachable is not reproducible.';
  const findings = only(
    'syntax.unresolvable-context',
    ['a', 'b', 'c', 'd'].map((id) => page(id, [context])),
  );

  assert.equal(findings.length, 1);
  assert.equal(findings[0]?.pages_affected, 4);
});

test('an unresolvable context is not also reported as malformed JSON', () => {
  const findings = only('syntax.malformed-json', [
    page('a', [
      'ld-block-0: refusing to fetch remote context https://vocab.example/v1. Only the bundled schema.org context is available; a crawl that depends on a third-party server being reachable is not reproducible.',
    ]),
  ]);
  assert.deepEqual(findings, []);
});

test('crawl errors are not block faults', () => {
  const findings = [
    ...only('syntax.malformed-json', [page('a', ['http-404'])]),
    ...only('syntax.unresolvable-context', [page('a', ['too-many-redirects: exceeded 5 redirects'])]),
  ];
  assert.deepEqual(findings, []);
});

test('a clean site produces nothing', () => {
  const findings = [
    ...only('syntax.malformed-json', [page('a', [])]),
    ...only('syntax.unresolvable-context', [page('a', [])]),
  ];
  assert.deepEqual(findings, []);
});
