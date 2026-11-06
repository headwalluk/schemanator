import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { ExternalScript, PageFacts } from '../extract/page-facts.ts';
import type { Report } from '../report/build.ts';
import { diffReports } from '../report/diff.ts';
import type { PageRecord } from '../store/workdir.ts';
import { fileSharingHost, loadFileSharingHosts, parseFileSharingHosts } from './file-sharing.ts';
import { runChecks } from './run.ts';

const CHECK = 'url.file-sharing-script';

function facts(scripts: ExternalScript[] | undefined): PageFacts {
  return {
    title: 'A page',
    meta_description: null,
    heading_levels: [1],
    robots: { index: true, follow: true, raw: null },
    hreflang: [],
    html_lang: 'en-GB',
    landmarks: { has_main: true, has_article: false },
    images: { total: 0, missing_alt: 0, suspect_alt: [] },
    text: {
      dom_words: 400,
      extractable_words: 300,
      main_words: 280,
      aside_words: 0,
      hidden_words: 0,
    },
    content_simhash: null,
    ...(scripts === undefined ? {} : { external_scripts: scripts }),
  };
}

function page(path: string, scripts: ExternalScript[] | undefined): PageRecord {
  const url = `https://therapy.example${path}`;
  return {
    page_id: path,
    url,
    canonical_url: url,
    declared_canonical: null,
    source: 'sitemap:https://therapy.example/s.xml',
    http_status: 200,
    redirect_chain: [],
    content_type: 'text/html',
    fetched_at: '2026-11-06T00:00:00Z',
    content_sha256: path,
    bytes: 20_000,
    html_purged: false,
    microdata_types: [],
    extraction: null,
    page_facts: facts(scripts),
    errors: [],
  };
}

const script = (src: string, id: string | null = null): ExternalScript => ({
  host: new URL(src).hostname,
  src,
  id,
});

const findingsFor = (pages: PageRecord[]) =>
  runChecks({ nodes: [], pages, partialCoverage: false }).findings.filter(
    (finding) => finding.check === CHECK,
  );

const DROPBOX = 'https://dl.dropboxusercontent.com/s/abc123/loader.js';

// --- the rules file ----------------------------------------------------------

const valid = (hosts: unknown[]): string => JSON.stringify({ schema_version: 1, hosts });
const entry = (overrides: Record<string, unknown> = {}) => ({
  host: 'dl.dropbox.com',
  match: 'exact',
  service: 'Dropbox',
  why: 'Direct download of a shared file',
  ...overrides,
});

test('the shipped rules file parses and covers the host seen in the field', () => {
  assert.equal(
    fileSharingHost('dl.dropboxusercontent.com', loadFileSharingHosts())?.service,
    'Dropbox',
  );
});

test('the rules file is refused when an entry could never match, naming the entry', () => {
  for (const [hosts, message] of [
    [[], /"hosts" is empty/],
    [[entry({ host: 'https://dl.dropbox.com' })], /hosts\[0\] "host" must be a bare lowercase/],
    [[entry({ host: 'DL.Dropbox.com' })], /hosts\[0\] "host" must be a bare lowercase/],
    [[entry({ host: '.dropbox.com' })], /hosts\[0\] "host" must be a bare lowercase/],
    [[entry(), entry()], /hosts\[1\] repeats "dl.dropbox.com"/],
    [[entry({ match: 'prefix' })], /hosts\[0\] needs "match" of exact \| suffix/],
    [[entry({ service: '' })], /hosts\[0\] needs a "service"/],
    [[entry({ why: undefined })], /hosts\[0\] needs a "why"/],
  ] as const) {
    assert.throws(() => parseFileSharingHosts(valid([...hosts]), 'hosts.json'), message);
  }
  assert.throws(
    () => parseFileSharingHosts('{', 'hosts.json'),
    /^Error: hosts\.json: not valid JSON/,
  );
});

test('suffix matches the host and its subdomains, never a lookalike; exact matches only itself', () => {
  const rules = parseFileSharingHosts(
    valid([
      entry({ host: 'dropboxusercontent.com', match: 'suffix' }),
      entry({ host: 'dl.dropbox.com', match: 'exact' }),
    ]),
  );

  assert.equal(fileSharingHost('dropboxusercontent.com', rules)?.host, 'dropboxusercontent.com');
  assert.equal(
    fileSharingHost('uc1a2b.dl.dropboxusercontent.com', rules)?.host,
    'dropboxusercontent.com',
  );
  assert.equal(fileSharingHost('notdropboxusercontent.com', rules), null);
  assert.equal(fileSharingHost('dl.dropbox.com', rules)?.host, 'dl.dropbox.com');
  assert.equal(fileSharingHost('x.dl.dropbox.com', rules), null);
});

// --- the check ---------------------------------------------------------------

test('a script from a file-sharing host is reported once for the site, naming its pages', () => {
  const findings = findingsFor([
    page('/', [script(`${DROPBOX}?ver=1700000001`, 'sitecheck-js')]),
    page('/about/', [script(`${DROPBOX}?ver=1700000002`, 'sitecheck-js')]),
    page('/contact/', []),
  ]);

  assert.equal(findings.length, 1);
  const [finding] = findings;
  assert.equal(finding?.severity, 'warning');
  assert.equal(finding?.subject.id, 'dl.dropboxusercontent.com');
  assert.equal(finding?.pages_affected, 2);
  // A per-request ?ver= is one file, not one per page.
  assert.equal(finding?.observed.length, 1);
  assert.equal(finding?.observed[0]?.page_count, 2);
  assert.equal(finding?.observed[0]?.value, DROPBOX);
  // The renderer adds "on N page(s)" itself.
  assert.equal(finding?.observed[0]?.detail, 'id "sitecheck-js", `ver` differs on every page');
  assert.match(finding?.summary ?? '', /generated per request/);
  assert.match(finding?.summary ?? '', /handle `sitecheck`/);
  assert.match(finding?.remediation ?? '', /`dl\.dropboxusercontent\.com` and `sitecheck`/);
});

test('distinct files on one host are separate rows of one finding', () => {
  const [finding, ...rest] = findingsFor([
    page('/', [script(DROPBOX)]),
    page('/b/', [script('https://dl.dropboxusercontent.com/s/other/second.js')]),
  ]);

  assert.equal(rest.length, 0);
  assert.equal(finding?.observed.length, 2);
  assert.equal(finding?.observed[0]?.detail, undefined);
  assert.doesNotMatch(finding?.summary ?? '', /handle/);
});

test('each file-sharing host is its own finding, with its own id', () => {
  const findings = findingsFor([
    page('/', [script(DROPBOX), script('https://raw.githubusercontent.com/acme/x/main/a.js')]),
  ]);

  assert.deepEqual(
    findings.map((finding) => finding.subject.id),
    ['dl.dropboxusercontent.com', 'raw.githubusercontent.com'],
  );
  assert.notEqual(findings[0]?.finding_id, findings[1]?.finding_id);
});

test('vendor storage, SDK and embed hosts are not reported', () => {
  const findings = findingsFor([
    page('/', [
      script('https://storage.googleapis.com/vendor-assets/s/scripts/sdk.js'),
      script('https://www.dropbox.com/static/api/2/dropins.js', 'dropboxjs'),
      script('https://pastebin.com/embed_js/AbCd1234'),
      script('https://gist.github.com/acme/0123abcd.js'),
      script('https://www.googletagmanager.com/gtag/js?id=G-1'),
    ]),
  ]);

  assert.deepEqual(findings, []);
});

test('facts extracted before external_scripts existed are silence, not an error', () => {
  assert.deepEqual(findingsFor([page('/', undefined)]), []);
});

test('a query string that never varies is not called per-request', () => {
  const [finding] = findingsFor([
    page('/', [script(`${DROPBOX}?ver=2.1`)]),
    page('/b/', [script(`${DROPBOX}?ver=2.1`)]),
  ]);

  assert.equal(finding?.observed[0]?.detail, undefined);
  assert.doesNotMatch(finding?.summary ?? '', /per request/);
});

test('a parameter varying on some pages says how far', () => {
  const [finding] = findingsFor([
    page('/', [script(`${DROPBOX}?ver=1&lang=en`)]),
    page('/b/', [script(`${DROPBOX}?ver=1&lang=en`)]),
    page('/c/', [script(`${DROPBOX}?ver=2&lang=en`)]),
  ]);

  assert.equal(finding?.observed[0]?.detail, '`ver` takes 2 values across 3 pages');
});

/** A report around one run's findings; only `findings` and `coverage` matter to the diff. */
function reportOf(pages: PageRecord[], runId: string): Report {
  return {
    schemanator: { version: '0.0.0', report_schema: 1 },
    run: {
      run_id: runId,
      site_slug: 'therapy.example',
      site_origin: 'https://therapy.example',
      started_at: '2026-11-06T00:00:00Z',
      finished_at: '2026-11-06T00:05:00Z',
      crawl_finished_at: '2026-11-06T00:04:00Z',
    },
    coverage: {
      complete: true,
      urls_discovered: pages.length,
      urls_queued: pages.length,
      pages_fetched: pages.length,
      pages_extracted: pages.length,
      pages_linked: 0,
      truncated: null,
      sample_strategy: 'spread',
      caveat: null,
    },
    graph: { nodes: 0, entities: 0, pages_with_data: 0, json_ld_blocks: 0, malformed_blocks: 0 },
    summary: { by_severity: {}, by_check: {}, silenced: {}, checks_run: [], checks_disabled: [] },
    findings: findingsFor(pages),
  };
}

test('a per-request ver leaves the finding unchanged between runs, not Changed', () => {
  const run = (base: number, runId: string): Report =>
    reportOf(
      [
        page('/', [script(`${DROPBOX}?ver=${base}`, 'sitecheck-js')]),
        page('/b/', [script(`${DROPBOX}?ver=${base + 4}`, 'sitecheck-js')]),
      ],
      runId,
    );

  const diff = diffReports(run(1700000001, 'BEFORE'), run(1700003601, 'AFTER'));

  assert.equal(diff.changed.length, 0);
  assert.equal(diff.unchanged.length, 1);
});
