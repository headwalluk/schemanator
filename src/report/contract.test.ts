/**
 * `report.json` is a published contract, so its shape is pinned here.
 *
 * `docs/reports.md` and `docs/agents.md` both tell consumers to pin against
 * `report_schema` and promise it "bumps on any breaking change". Nothing
 * enforced that promise: a field could be renamed, or quietly dropped, and every
 * test would still pass because the renderers were changed alongside it. The
 * agent reading the JSON is the one that finds out.
 *
 * This is the same class of guarantee as `exit-codes.test.ts`. **A consumer
 * branches on the shape without reading the prose**, so a silent change is acted
 * on rather than noticed.
 *
 * ## What counts as breaking, and therefore needs `REPORT_SCHEMA` bumped
 *
 *   - Removing or renaming any key asserted below.
 *   - Changing a value's type, or the meaning of an existing key.
 *   - Making a guaranteed key optional.
 *
 * **Adding** a key is not breaking, and does not need a bump — a consumer that
 * ignores unknown fields is unaffected. Add it to the lists below so the
 * addition is deliberate rather than incidental.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Finding } from '../checks/run.ts';
import type { CrawlSummary } from '../crawl/run.ts';
import type { ExtractionRunSummary } from '../extract/run.ts';
import type { PageRecord } from '../store/workdir.ts';
import { buildReport, REPORT_SCHEMA, type Report } from './build.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const CRAWL: CrawlSummary = {
  start_url: 'https://example.com/',
  site_origin: 'https://example.com',
  site_slug: 'example.com',
  work_dir: null,
  dry_run: false,
  robots: {},
  sitemaps: [],
  sitemap_errors: [],
  dropped_entries: [],
  host_divergence: [],
  urls_discovered: 2,
  urls_disallowed: 0,
  urls_queued: 2,
  truncated: null,
  sample_strategy: 'spread',
  seeded_from: 'sitemap',
  fetched_this_run: 2,
  fetched: 2,
  failed: 0,
  skipped: 0,
  aborted: null,
  started_at: '2026-08-09T00:00:00Z',
  finished_at: '2026-08-09T00:00:10Z',
};

const EXTRACTION: ExtractionRunSummary = {
  pages_extracted: 2,
  pages_skipped: 0,
  json_ld_blocks: 2,
  json_ld_failed: 0,
  nodes: 4,
  pages_with_microdata: 0,
  declared_canonicals: 2,
  started_at: '2026-08-09T00:00:10Z',
  finished_at: '2026-08-09T00:00:11Z',
};

const PAGE: PageRecord = {
  page_id: 'a',
  url: 'https://example.com/a',
  canonical_url: 'https://example.com/a',
  declared_canonical: null,
  source: 'sitemap:https://example.com/sitemap.xml',
  http_status: 200,
  redirect_chain: [],
  content_type: 'text/html',
  fetched_at: '2026-08-09T00:00:00Z',
  content_sha256: 'x',
  bytes: 1,
  html_purged: false,
  microdata_types: [],
  extraction: { json_ld_blocks: 1, json_ld_failed: 0, microdata_items: 0, rdfa_items: 0, nodes: 2 },
  errors: [],
};

const FINDING: Finding = {
  finding_id: 'abc123abc123',
  check: 'entity.contradiction',
  severity: 'error',
  origin: 'check',
  title: 'url has 2 different values under one @id',
  subject: { kind: 'entity', id: 'https://example.com/#org', property: 'http://schema.org/url' },
  summary: 'Two values.',
  expected: 'One url value.',
  observed: [
    {
      value: 'https://example.com/',
      observation_count: 1,
      page_count: 1,
      provenance: [
        { page_id: 'a', url: 'https://example.com/a', syntax: 'json-ld', block: 0, pointer: '/1' },
      ],
    },
  ],
  pages_affected: 1,
  coverage_qualified: false,
  remediation: 'Emit one value.',
  tradeoff: null,
  // `page_ids` is deliberately absent. It exists so aggregation can union page
  // sets, and `runChecks` deletes it before the report is built — so a fixture
  // carrying it would imply a contract field that never reaches a consumer.
};

function report(): Report {
  return buildReport({
    version: '9.9.9',
    runId: 'run-1',
    crawl: CRAWL,
    extraction: EXTRACTION,
    pages: [PAGE],
    entities: 1,
    findings: [FINDING],
    silenced: { 'entity.partiality': 3 },
    checksRun: ['entity.contradiction'],
    checksDisabled: [],
  });
}

const BUMP = 'If this change is deliberate, bump REPORT_SCHEMA and update docs/reports.md.';

test('the top-level shape is exactly what consumers are promised', () => {
  assert.deepEqual(Object.keys(report()).sort(), [
    'coverage', 'findings', 'graph', 'run', 'schemanator', 'summary',
  ], BUMP);
});

test('each section holds exactly its documented keys', () => {
  const built = report();

  assert.deepEqual(Object.keys(built.schemanator).sort(), ['report_schema', 'version'], BUMP);
  assert.deepEqual(Object.keys(built.run).sort(), [
    'finished_at', 'run_id', 'site_origin', 'site_slug', 'started_at',
  ], BUMP);
  assert.deepEqual(Object.keys(built.coverage).sort(), [
    'caveat', 'complete', 'pages_extracted', 'pages_fetched', 'sample_strategy',
    'truncated', 'urls_discovered', 'urls_queued',
  ], BUMP);
  assert.deepEqual(Object.keys(built.graph).sort(), [
    'entities', 'json_ld_blocks', 'malformed_blocks', 'nodes', 'pages_with_data',
  ], BUMP);
  assert.deepEqual(Object.keys(built.summary).sort(), [
    'by_check', 'by_severity', 'checks_disabled', 'checks_run', 'silenced',
  ], BUMP);
});

test('a finding carries every guaranteed key', () => {
  const finding = report().findings[0];
  assert.notEqual(finding, undefined);

  for (const key of [
    'finding_id', 'check', 'severity', 'origin', 'title', 'subject', 'summary',
    'expected', 'observed', 'pages_affected', 'coverage_qualified', 'remediation', 'tradeoff',
  ]) {
    assert.equal(key in (finding as object), true, `findings[].${key} is missing. ${BUMP}`);
  }

  assert.deepEqual(Object.keys(finding?.subject ?? {}).sort(), ['id', 'kind', 'property']);
  assert.deepEqual(Object.keys(finding?.observed[0] ?? {}).sort(), [
    'observation_count', 'page_count', 'provenance', 'value',
  ], BUMP);
  assert.deepEqual(Object.keys(finding?.observed[0]?.provenance[0] ?? {}).sort(), [
    'block', 'page_id', 'pointer', 'syntax', 'url',
  ], BUMP);
});

test('the report is serialisable and survives a round trip', () => {
  // A Set or a Map reaching the report would stringify to {} and lose the data
  // silently — `page_ids` is a Set upstream, which is exactly this hazard.
  const built = report();
  const roundTripped = JSON.parse(JSON.stringify(built)) as Report;
  assert.deepEqual(roundTripped, built, 'the report contains something JSON cannot represent');
});

test('report_schema in the emitted JSON matches the constant', () => {
  assert.equal(report().schemanator.report_schema, REPORT_SCHEMA);
  assert.equal(Number.isInteger(REPORT_SCHEMA), true);
});

test('docs quote the schema version that is actually emitted', () => {
  // docs/reports.md shows a worked example. A stale number there is worse than
  // no number: it is the value a consumer will hard-code.
  const reports = fs.readFileSync(path.join(ROOT, 'docs', 'reports.md'), 'utf8');
  const quoted = [...reports.matchAll(/"report_schema":\s*(\d+)/g)].map((match) => Number(match[1]));

  assert.equal(quoted.length > 0, true, 'docs/reports.md no longer shows report_schema');
  for (const value of quoted) {
    assert.equal(value, REPORT_SCHEMA, `docs/reports.md shows report_schema ${value}`);
  }
});
