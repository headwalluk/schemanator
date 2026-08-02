import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { ExtractedNode } from '../extract/types.ts';
import type { PageRecord } from '../store/workdir.ts';
import { runChecks } from './run.ts';

const S = (name: string): string => `http://schema.org/${name}`;

let sequence = 0;
function node(options: {
  id: string;
  page: string;
  types?: string[];
  props?: Record<string, unknown[]>;
  blank?: boolean;
}): ExtractedNode {
  sequence += 1;
  return {
    node_id: options.id,
    raw_id: null,
    is_blank: options.blank ?? options.id.startsWith('_:'),
    page_id: options.page,
    types: options.types ?? [S('Organization')],
    props: options.props ?? {},
    source: { syntax: 'json-ld', block: 0, pointer: `/${sequence}` },
  };
}

function page(id: string, overrides: Partial<PageRecord> = {}): PageRecord {
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
    extraction: { json_ld_blocks: 1, json_ld_failed: 0, microdata_items: 0, rdfa_items: 0, nodes: 1 },
    errors: [],
    ...overrides,
  };
}

/**
 * `coverage.missing-expected-entity` is a *site-level absence* check, so it
 * fires on every fixture here: a two-node graph has no logo and no `sameAs` by
 * construction. Leaving it enabled would mean every test below asserting "and
 * nothing else fired" had to carry it, which buries the thing each test is
 * actually about.
 *
 * It is disabled for the shared helper and tested on its own, further down,
 * where the absence is the point rather than an artefact of the fixture.
 */
const run = (
  nodes: ExtractedNode[],
  pages: PageRecord[] = [page('a'), page('b')],
  disabled: readonly string[] = ['coverage.missing-expected-entity'],
) => runChecks({ nodes, pages, partialCoverage: false, disabled });

const value = (text: string) => [{ '@value': text }];
const ref = (id: string) => [{ '@id': id }];

// --- entity.contradiction ----------------------------------------------------

test('flags a functional property with two values under one @id', () => {
  const { findings } = run([
    node({ id: 'https://example.com/#org', page: 'a', props: { [S('telephone')]: value('+44 1') } }),
    node({ id: 'https://example.com/#org', page: 'b', props: { [S('telephone')]: value('+44 2') } }),
  ]);

  assert.equal(findings.length, 1);
  assert.equal(findings[0]?.check, 'entity.contradiction');
  assert.equal(findings[0]?.severity, 'error');
  assert.equal(findings[0]?.pages_affected, 2);
});

test('stays silent on a legitimately plural property', () => {
  const { findings, silenced } = run([
    node({ id: 'https://example.com/#org', page: 'a', props: { [S('sameAs')]: ref('https://x.example') } }),
    node({ id: 'https://example.com/#org', page: 'b', props: { [S('sameAs')]: ref('https://y.example') } }),
  ]);

  assert.deepEqual(findings, []);
  assert.equal(silenced['entity.multi-valued-divergence'], 1);
});

test('set order is never a finding', () => {
  // `[A,B]` versus `[B,A]` is the same statement — `00`, class 4.
  //
  // Note this fixture *does* carry two values for `name` on a single page, so
  // `entity.multi-value` fires on it and is correct to: that check is the
  // within-one-observation case, and it is a different question from whether
  // the two observations contradict each other. Scoped to the check under test.
  const { findings } = run([
    node({
      id: 'https://example.com/#org',
      page: 'a',
      props: { [S('name')]: [{ '@value': 'A' }, { '@value': 'B' }] },
    }),
    node({
      id: 'https://example.com/#org',
      page: 'b',
      props: { [S('name')]: [{ '@value': 'B' }, { '@value': 'A' }] },
    }),
  ]);
  assert.deepEqual(
    findings.filter((finding) => finding.check === 'entity.contradiction'),
    [],
  );
});

test('partiality is counted, never reported', () => {
  const { findings, silenced } = run([
    node({ id: 'https://example.com/#org', page: 'a', props: { [S('telephone')]: value('+44 1') } }),
    node({ id: 'https://example.com/#org', page: 'b', props: { [S('name')]: value('Acme') } }),
  ]);

  assert.deepEqual(findings, []);
  assert.equal(silenced['entity.partiality'], 2);
});

test('a blank-node reference is compared by denotation, not by id', () => {
  // Rule 4. Blank ids embed page_id, so comparing them made a byte-identical
  // address look like 150 distinct values across the corpus.
  const { findings } = run([
    node({ id: '_:a/json-ld/0/1', page: 'a', types: [S('PostalAddress')], props: { [S('postalCode')]: value('RG1') } }),
    node({ id: '_:b/json-ld/0/1', page: 'b', types: [S('PostalAddress')], props: { [S('postalCode')]: value('RG1') } }),
    node({ id: 'https://example.com/#org', page: 'a', props: { [S('address')]: ref('_:a/json-ld/0/1') } }),
    node({ id: 'https://example.com/#org', page: 'b', props: { [S('address')]: ref('_:b/json-ld/0/1') } }),
  ]);
  assert.deepEqual(findings, []);
});

test('a genuine difference behind blank nodes is still caught', () => {
  const { findings } = run([
    node({ id: '_:a/x', page: 'a', types: [S('PostalAddress')], props: { [S('postalCode')]: value('RG1') } }),
    node({ id: '_:b/x', page: 'b', types: [S('PostalAddress')], props: { [S('postalCode')]: value('SW1') } }),
    node({ id: 'https://example.com/#org', page: 'a', props: { [S('address')]: ref('_:a/x') } }),
    node({ id: 'https://example.com/#org', page: 'b', props: { [S('address')]: ref('_:b/x') } }),
  ]);
  assert.equal(findings.length, 1);
  assert.equal(findings[0]?.check, 'entity.contradiction');
});

test('a single observation cannot contradict itself', () => {
  const { findings } = run([
    node({ id: 'https://example.com/#org', page: 'a', props: { [S('telephone')]: value('+44 1') } }),
  ]);
  assert.deepEqual(findings, []);
});

// --- entity.type-narrowing / conflict ---------------------------------------

test('a subclass refinement is an opportunity, not an error', () => {
  const { findings } = run([
    node({ id: 'https://example.com/#o', page: 'a', types: [S('LocalBusiness')], props: { [S('name')]: value('A') } }),
    node({ id: 'https://example.com/#o', page: 'b', types: [S('Organization')], props: { [S('name')]: value('A') } }),
  ]);

  assert.equal(findings.length, 1);
  assert.equal(findings[0]?.check, 'entity.type-narrowing');
  assert.equal(findings[0]?.severity, 'opportunity');
  // It must name the trade-off rather than assert a fix the crawl cannot justify.
  assert.notEqual(findings[0]?.tradeoff, null);
});

test('an extra unrelated type still nests, so it is a refinement', () => {
  // A corpus site: Person vs [Organization, Person]. A naive isSubClassOf
  // test files this as a conflict and raises an error against a sole trader.
  const { findings } = run([
    node({ id: 'https://example.com/#p', page: 'a', types: [S('Person')], props: { [S('name')]: value('P') } }),
    node({
      id: 'https://example.com/#p',
      page: 'b',
      types: [S('Organization'), S('Person')],
      props: { [S('name')]: value('P') },
    }),
  ]);
  assert.equal(findings[0]?.check, 'entity.type-narrowing');
});

test('genuinely unrelated types are an error', () => {
  const { findings } = run([
    node({ id: 'https://example.com/#x', page: 'a', types: [S('Product')], props: { [S('name')]: value('X') } }),
    node({ id: 'https://example.com/#x', page: 'b', types: [S('Person')], props: { [S('name')]: value('X') } }),
  ]);
  const conflict = findings.find((finding) => finding.check === 'entity.type-conflict');
  assert.notEqual(conflict, undefined);
  assert.equal(conflict?.severity, 'error');
});

// --- graph.identity-fracture -------------------------------------------------

test('two @ids for one entity are flagged when name and url agree', () => {
  const { findings } = run([
    node({
      id: 'https://example.com/#organization',
      page: 'a',
      props: { [S('name')]: value('Acme Ltd'), [S('url')]: ref('https://example.com') },
    }),
    node({
      id: 'https://example.com/',
      page: 'b',
      props: { [S('name')]: value('Acme Ltd'), [S('url')]: ref('https://example.com') },
    }),
  ]);

  const fracture = findings.find((finding) => finding.check === 'graph.identity-fracture');
  assert.notEqual(fracture, undefined);
  assert.equal(fracture?.severity, 'error');
  assert.equal(fracture?.observed.length, 2);
});

test('a shared name alone is never enough', () => {
  // "Support" is a plausible name for several distinct entities on one site.
  const { findings } = run([
    node({ id: 'https://example.com/#a', page: 'a', props: { [S('name')]: value('Support') } }),
    node({ id: 'https://example.com/#b', page: 'b', props: { [S('name')]: value('Support') } }),
  ]);
  assert.equal(findings.some((finding) => finding.check === 'graph.identity-fracture'), false);
});

test('a shared name across conflicting types is not a fracture', () => {
  const { findings } = run([
    node({
      id: 'https://example.com/#a',
      page: 'a',
      types: [S('Product')],
      props: { [S('name')]: value('Atlas'), [S('url')]: ref('https://example.com') },
    }),
    node({
      id: 'https://example.com/#b',
      page: 'b',
      types: [S('Person')],
      props: { [S('name')]: value('Atlas'), [S('url')]: ref('https://example.com') },
    }),
  ]);
  assert.equal(findings.some((finding) => finding.check === 'graph.identity-fracture'), false);
});

// --- graph.dangling-reference ------------------------------------------------

test('a dangling entity reference is a warning', () => {
  const { findings } = run([
    node({ id: 'https://example.com/#site', page: 'a', props: { [S('publisher')]: ref('https://example.com/#ghost') } }),
  ]);
  const dangling = findings.find((finding) => finding.check === 'graph.dangling-reference');
  assert.equal(dangling?.subject.id, 'https://example.com/#ghost');
});

test('a URL-valued property is never a dangling reference', () => {
  // The shakedown's biggest false positive: 38 warnings on one site, every one
  // a `target` pointing at a WordPress #respond comment anchor.
  const { findings } = run([
    node({
      id: 'https://example.com/#action',
      page: 'a',
      types: [S('CommentAction')],
      props: { [S('target')]: ref('https://example.com/post/#respond') },
    }),
  ]);
  assert.equal(findings.some((finding) => finding.check === 'graph.dangling-reference'), false);
});

test('a defined reference is not dangling', () => {
  const { findings } = run([
    node({ id: 'https://example.com/#site', page: 'a', props: { [S('publisher')]: ref('https://example.com/#org') } }),
    node({ id: 'https://example.com/#org', page: 'a', props: { [S('name')]: value('Acme') } }),
  ]);
  assert.equal(findings.some((finding) => finding.check === 'graph.dangling-reference'), false);
});

// --- url.canonical-mismatch --------------------------------------------------

test('a declared canonical differing only in percent-encoding case is not a finding', () => {
  const { findings } = run(
    [],
    [
      page('a', {
        canonical_url: 'https://example.com/a%EF%B8%8F/',
        declared_canonical: 'https://example.com/a%ef%b8%8f/',
      }),
    ],
  );
  assert.equal(findings.some((finding) => finding.check === 'url.canonical-mismatch'), false);
});

test('a genuinely different declared canonical is a warning', () => {
  const { findings } = run(
    [],
    [page('a', { canonical_url: 'https://example.com/a', declared_canonical: 'https://www.example.com/a' })],
  );
  assert.equal(findings.find((finding) => finding.check === 'url.canonical-mismatch')?.severity, 'warning');
});

// --- engine ------------------------------------------------------------------

test('a disabled check does not run', () => {
  const nodes = [
    node({ id: 'https://example.com/#org', page: 'a', props: { [S('telephone')]: value('+44 1') } }),
    node({ id: 'https://example.com/#org', page: 'b', props: { [S('telephone')]: value('+44 2') } }),
  ];
  const result = runChecks({
    nodes,
    pages: [page('a'), page('b')],
    partialCoverage: false,
    disabled: ['entity.contradiction', 'coverage.missing-expected-entity'],
  });
  assert.deepEqual(result.findings, []);
  assert.equal(result.checksRun.includes('entity.contradiction'), false);
});

test('a whole group can be disabled at once', () => {
  const result = runChecks({ nodes: [], pages: [], partialCoverage: false, disabled: ['coverage'] });
  assert.equal(result.checksRun.some((check) => check.startsWith('coverage.')), false);
});

test('findings are ordered errors first', () => {
  const { findings } = run([
    node({ id: 'https://example.com/#o', page: 'a', types: [S('LocalBusiness')], props: { [S('name')]: value('A') } }),
    node({ id: 'https://example.com/#o', page: 'b', types: [S('Organization')], props: { [S('name')]: value('A') } }),
    node({ id: 'https://example.com/#p', page: 'a', props: { [S('telephone')]: value('1') } }),
    node({ id: 'https://example.com/#p', page: 'b', props: { [S('telephone')]: value('2') } }),
  ]);
  assert.equal(findings[0]?.severity, 'error');
});

test('finding ids are stable across runs and independent of the values found', () => {
  const first = run([
    node({ id: 'https://example.com/#o', page: 'a', props: { [S('telephone')]: value('+44 1') } }),
    node({ id: 'https://example.com/#o', page: 'b', props: { [S('telephone')]: value('+44 2') } }),
  ]);
  // Same question, different answer: a half-fixed contradiction is the SAME
  // finding still open, which is what makes a cross-run diff a set operation.
  const second = run([
    node({ id: 'https://example.com/#o', page: 'a', props: { [S('telephone')]: value('+44 1') } }),
    node({ id: 'https://example.com/#o', page: 'b', props: { [S('telephone')]: value('+44 3') } }),
  ]);
  assert.equal(first.findings[0]?.finding_id, second.findings[0]?.finding_id);
});

test('absence findings are marked coverage-qualified under a partial crawl', () => {
  const result = runChecks({
    nodes: [node({ id: 'https://example.com/#s', page: 'a', props: { [S('publisher')]: ref('https://example.com/#ghost') } })],
    pages: [page('a')],
    partialCoverage: true,
  });
  assert.equal(result.findings.find((finding) => finding.check === 'graph.dangling-reference')?.coverage_qualified, true);
});

// --- value.placeholder --------------------------------------------------------

test('a placeholder value is an error', () => {
  const { findings } = run([
    node({ id: 'https://example.com/#org', page: 'a', props: { [S('name')]: value('My Website') } }),
  ]);
  const hit = findings.find((finding) => finding.check === 'value.placeholder');
  assert.equal(hit?.severity, 'error');
  assert.match(hit?.summary ?? '', /never filled in/);
});

test('placeholders match the whole value, never a substring', () => {
  // power-plugins.com sells a lorem ipsum generator. Substring matching would
  // tell them their own product name is a placeholder.
  const { findings } = run([
    node({
      id: 'https://example.com/#p',
      page: 'a',
      types: [S('Product')],
      props: { [S('name')]: value('Classic Lorem Ipsum'), [S('description')]: value('Free tool for creating ipsum text.') },
    }),
  ]);
  assert.equal(findings.some((finding) => finding.check === 'value.placeholder'), false);
});

test('placeholder matching ignores case and surrounding whitespace', () => {
  const { findings } = run([
    node({ id: 'https://example.com/#o', page: 'a', props: { [S('name')]: value('  MY WEBSITE  ') } }),
  ]);
  assert.equal(findings.some((finding) => finding.check === 'value.placeholder'), true);
});

// --- value.empty --------------------------------------------------------------

test('an empty string value is an error, and says why', () => {
  const { findings } = run([
    node({ id: 'https://example.com/#o', page: 'a', props: { [S('name')]: value('') } }),
  ]);
  const hit = findings.find((finding) => finding.check === 'value.empty');
  assert.equal(hit?.severity, 'error');
  // The distinction that makes it worth an error rather than a shrug.
  assert.match(hit?.summary ?? '', /absence says nothing/);
});

test('whitespace-only counts as empty', () => {
  const { findings } = run([
    node({ id: 'https://example.com/#o', page: 'a', props: { [S('streetAddress')]: value('   ') } }),
  ]);
  assert.equal(findings.some((finding) => finding.check === 'value.empty'), true);
});

test('empty values are grouped by property, not per page', () => {
  const { findings } = run([
    node({ id: 'https://example.com/#a', page: 'a', props: { [S('name')]: value('') } }),
    node({ id: 'https://example.com/#b', page: 'b', props: { [S('name')]: value('') } }),
  ]);
  assert.equal(findings.filter((finding) => finding.check === 'value.empty').length, 1);
});

// --- url.insecure-self-reference ---------------------------------------------

test('an http self-reference on an https site is a warning', () => {
  const { findings } = run(
    [node({ id: 'https://example.com/#o', page: 'a', props: { [S('sameAs')]: ref('http://example.com') } })],
    [page('a', { canonical_url: 'https://example.com/a' })],
  );
  assert.equal(findings.find((finding) => finding.check === 'url.insecure-self-reference')?.severity, 'warning');
});

test('an http reference to somebody else is not our business', () => {
  const { findings } = run(
    [node({ id: 'https://example.com/#o', page: 'a', props: { [S('sameAs')]: ref('http://elsewhere.example/x') } })],
    [page('a', { canonical_url: 'https://example.com/a' })],
  );
  assert.equal(findings.some((finding) => finding.check === 'url.insecure-self-reference'), false);
});

test('an http site is not told off for using http', () => {
  const { findings } = run(
    [node({ id: 'http://example.com/#o', page: 'a', props: { [S('sameAs')]: ref('http://example.com') } })],
    [page('a', { canonical_url: 'http://example.com/a' })],
  );
  assert.equal(findings.some((finding) => finding.check === 'url.insecure-self-reference'), false);
});

// --- url.foreign-media-host ---------------------------------------------------

test('media on an unrelated host is a warning', () => {
  const { findings } = run(
    [node({ id: 'https://example.com/#p', page: 'a', props: { [S('image')]: ref('https://oldagency.example/x.png') } })],
    [page('a', { canonical_url: 'https://example.com/a' })],
  );
  const hit = findings.find((finding) => finding.check === 'url.foreign-media-host');
  assert.equal(hit?.severity, 'warning');
  // We do not fetch off-site media, and the report must not imply we did.
  assert.match(hit?.summary ?? '', /does not fetch off-site media/);
});

test('a CDN subdomain of the site is benign', () => {
  const { findings } = run(
    [node({ id: 'https://example.com/#p', page: 'a', props: { [S('image')]: ref('https://cdn.example.com/x.png') } })],
    [page('a', { canonical_url: 'https://example.com/a' })],
  );
  assert.equal(findings.some((finding) => finding.check === 'url.foreign-media-host'), false);
});

test('gravatar is benign', () => {
  // On 7 of 22 corpus sites. Without this the check fires on most of WordPress.
  const { findings } = run(
    [node({ id: 'https://example.com/#p', page: 'a', props: { [S('image')]: ref('https://secure.gravatar.com/avatar/abc') } })],
    [page('a', { canonical_url: 'https://example.com/a' })],
  );
  assert.equal(findings.some((finding) => finding.check === 'url.foreign-media-host'), false);
});

test('a per-customer CDN subdomain is benign', () => {
  const { findings } = run(
    [node({ id: 'https://example.com/#p', page: 'a', props: { [S('image')]: ref('https://d123.cloudfront.net/x.png') } })],
    [page('a', { canonical_url: 'https://example.com/a' })],
  );
  assert.equal(findings.some((finding) => finding.check === 'url.foreign-media-host'), false);
});

test('sameAs pointing elsewhere is the entire point of sameAs', () => {
  const { findings } = run(
    [node({ id: 'https://example.com/#o', page: 'a', props: { [S('sameAs')]: ref('https://linkedin.com/company/x') } })],
    [page('a', { canonical_url: 'https://example.com/a' })],
  );
  assert.equal(findings.some((finding) => finding.check === 'url.foreign-media-host'), false);
});
