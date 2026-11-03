import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { PageRecord, StoredLink } from '../store/workdir.ts';
import { runChecks } from './run.ts';
import { loadTrackingParameters, parseTrackingParameters } from '../url/tracking-parameters.ts';
import { trackingKeys } from './tracking.ts';

const CHECK = 'url.tracking-parameter';

function page(path: string, source = 'sitemap:https://shop.example/s.xml'): PageRecord {
  const url = `https://shop.example${path}`;
  return {
    page_id: path,
    url,
    canonical_url: url,
    declared_canonical: url,
    source,
    http_status: 200,
    redirect_chain: [],
    content_type: 'text/html',
    fetched_at: '2026-11-02T00:00:00Z',
    content_sha256: path,
    bytes: 100,
    html_purged: false,
    microdata_types: [],
    page_facts: null,
    extraction: null,
    errors: [],
  };
}

function link(from: string, to: string, internal = true): StoredLink {
  return { from, to, anchor: 'x', internal, rel: null, in_chrome: false };
}

const findingsFor = (pages: PageRecord[], links: StoredLink[]) =>
  runChecks({ nodes: [], pages, links, partialCoverage: true }).findings.filter(
    (finding) => finding.check === CHECK,
  );

// --- the rules file ----------------------------------------------------------

const valid = (parameters: unknown[]): string => JSON.stringify({ schema_version: 1, parameters });
const entry = (overrides: Record<string, unknown> = {}) => ({
  name: 'gclid',
  match: 'exact',
  operator: 'Google Ads',
  source: 'https://support.google.com/google-ads/answer/3095550',
  ...overrides,
});

test('the shipped rules file parses and covers the parameters seen in the field', () => {
  const rules = loadTrackingParameters();
  const names = rules.parameters.map((parameter) => parameter.name);
  for (const name of ['srsltid', 'utm_', 'gclid', 'fbclid']) {
    assert.equal(names.includes(name), true, `${name} is missing`);
  }
});

test('a malformed rules file throws, naming the file and the entry', () => {
  const cases: [string, RegExp][] = [
    ['{', /t\.json: not valid JSON/],
    [JSON.stringify({ parameters: [] }), /missing "schema_version"/],
    [valid([]), /"parameters" is empty/],
    [valid([entry({ name: 'GCLID' })]), /parameters\[0\] "name" must be lowercase/],
    [valid([entry({ match: 'regex' })]), /parameters\[0\] needs "match" of exact \| prefix/],
    [valid([entry({ source: 'somebody said so' })]), /parameters\[0\] must cite its "source"/],
    [valid([entry(), entry()]), /parameters\[1\] repeats "gclid"/],
  ];
  for (const [json, message] of cases) {
    assert.throws(() => parseTrackingParameters(json, 't.json'), message, json);
  }
});

test('tracking keys match by exact name or by prefix, ignoring case and other parameters', () => {
  const rules = loadTrackingParameters();
  assert.deepEqual(trackingKeys('https://a.example/?srsltid=x&add-to-cart=4', rules), ['srsltid']);
  assert.deepEqual(trackingKeys('https://a.example/?UTM_Source=mail&utm_medium=email', rules), [
    'utm_source',
    'utm_medium',
  ]);
  // Near-misses: a prefix match must not reach a parameter that merely contains it.
  assert.deepEqual(trackingKeys('https://a.example/?page=2&ref=nav&my_utm_x=1', rules), []);
  assert.deepEqual(trackingKeys('not a url', rules), []);
});

// --- the check ---------------------------------------------------------------

test('links built from a tagged request URL are reported as pointing back at their page', () => {
  const category = page('/category/printers/');
  const findings = findingsFor(
    [category],
    [
      link(category.page_id, 'https://shop.example/category/printers/page/2/?srsltid=abc'),
      link(category.page_id, 'https://shop.example/category/printers/?srsltid=abc&add-to-cart=7'),
      // The same URL twice ("2" and "→") is one URL, not two.
      link(category.page_id, 'https://shop.example/category/printers/page/2/?srsltid=abc'),
    ],
  );

  assert.equal(findings.length, 1);
  assert.equal(findings[0]?.severity, 'warning');
  assert.equal(findings[0]?.pages_affected, 1);
  assert.equal(findings[0]?.coverage_qualified, false, 'a presence claim needs no coverage caveat');
  assert.deepEqual(
    findings[0]?.observed[0]?.detail,
    '2 link URL(s) with srsltid — all back to this page',
  );
  assert.match(findings[0]?.summary ?? '', /point back at the page itself/);
  assert.doesNotMatch(findings[0]?.summary ?? '', /pasted/);
  assert.doesNotMatch(findings[0]?.remediation ?? '', /edit the content/);
});

test('a tagged link to another page is reported as pasted, and listed first', () => {
  const category = page('/category/printers/');
  const post = page('/blog/matt-paper/');
  const findings = findingsFor(
    [category, post],
    [
      link(category.page_id, 'https://shop.example/category/printers/?srsltid=abc&add-to-cart=1'),
      link(category.page_id, 'https://shop.example/category/printers/?srsltid=abc&add-to-cart=2'),
      link(post.page_id, 'https://shop.example/icc-profiles/?srsltid=def'),
    ],
  );

  assert.deepEqual(
    findings[0]?.observed.map((row) => [row.value, row.detail]),
    [
      [post.canonical_url, '1 link URL(s) with srsltid — all to other pages'],
      [category.canonical_url, '2 link URL(s) with srsltid — all back to this page'],
    ],
  );
  assert.match(findings[0]?.summary ?? '', /On 1 page\(s\) they point at other pages/);
  assert.match(findings[0]?.remediation ?? '', /edit the content/);
});

test('hop pages, external links and untagged links are not reported', () => {
  // The hop page exists only because a tagged link led to it: not a second instance.
  const hop = page('/category/printers/page/2/?srsltid=abc', 'link-hop:/category/printers/');
  const home = page('/');
  const findings = findingsFor(
    [hop, home],
    [
      link(hop.page_id, 'https://shop.example/category/printers/?srsltid=abc'),
      link(home.page_id, 'https://partner.example/?utm_source=shop', false),
      link(home.page_id, 'https://shop.example/category/printers/?add-to-cart=1&page=2'),
    ],
  );
  assert.deepEqual(findings, []);
});
