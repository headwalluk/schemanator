import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { ExtractedNode } from '../extract/types.ts';
import type { PageRecord } from '../store/workdir.ts';
import { AGGREGATE_SAMPLE, runChecks, UnknownCheckError } from './run.ts';

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
    // Unique per page: a shared hash would mean these fixtures are
    // byte-identical, which `indexing.duplicate-content` would rightly
    // report and no suite here means to say.
    content_sha256: `sha-${id}`,
    bytes: 1,
    html_purged: false,
    microdata_types: [],
    page_facts: null,
    extraction: {
      json_ld_blocks: 1,
      json_ld_failed: 0,
      microdata_items: 0,
      rdfa_items: 0,
      nodes: 1,
    },
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
 *
 * Group `google` is disabled for the same reason and needs it more. Its rules
 * apply to the types these fixtures are naturally written in — a two-property
 * `LocalBusiness` or `Product` trips several of them by construction — so
 * leaving it on would make every assertion below about the shape of a fixture
 * rather than about the check under test. It has its own suite in
 * `google.test.ts`, which is where those cases belong.
 */
const run = (
  nodes: ExtractedNode[],
  pages: PageRecord[] = [page('a'), page('b')],
  disabled: readonly string[] = ['coverage.missing-expected-entity', 'google'],
) => runChecks({ nodes, pages, partialCoverage: false, disabled });

const value = (text: string) => [{ '@value': text }];
const ref = (id: string) => [{ '@id': id }];

// --- entity.page-scoped-value, and what --disable does with it ---------------

/** Six pages, one @id, and a `url` that is never twice the same. */
const pageScopedFixture = (): { nodes: ExtractedNode[]; pages: PageRecord[] } => {
  const ids = ['a', 'b', 'c', 'd', 'e', 'f'];
  return {
    nodes: ids.map((id) =>
      node({
        id: 'https://example.com/#org',
        page: id,
        // Not example.com: `value.placeholder` reports that host by design, and
        // a second finding here would be about the fixture rather than the check.
        props: { [S('url')]: value(`https://fixture.test/${id}`) },
      }),
    ),
    pages: ids.map((id) => page(id)),
  };
};

test('a functional property with one value per page is page-scoped, not a contradiction', () => {
  // The check had no test at all before 2026-08-22: it fires readily on the
  // corpus, so nothing in the suite ever needed to make it fire on purpose.
  const { nodes, pages } = pageScopedFixture();
  const { findings } = run(nodes, pages);

  assert.deepEqual(
    findings.map((finding) => finding.check),
    ['entity.page-scoped-value'],
  );
});

test('a check raised by another check can be disabled by its own id', () => {
  // The defect, found 2026-08-22 by reading a real report. `entity.page-scoped-value`
  // is raised by `entity.contradiction` and has no entry in ALL_CHECKS, so
  // --disable matched nothing: the id was accepted, echoed back to the operator
  // as "Disabled:", written into report.json, and the finding appeared anyway.
  const { nodes, pages } = pageScopedFixture();
  const { findings, checksRun } = run(nodes, pages, [
    'coverage.missing-expected-entity',
    'google',
    'entity.page-scoped-value',
  ]);

  assert.deepEqual(findings, [], 'the disabled check still reported');
  assert.equal(
    checksRun.includes('entity.page-scoped-value'),
    false,
    'a disabled check is listed as having run',
  );
});

test('disabling the raising check disables what it raises', () => {
  const { nodes, pages } = pageScopedFixture();
  const { findings } = run(nodes, pages, [
    'coverage.missing-expected-entity',
    'google',
    'entity.contradiction',
  ]);

  assert.deepEqual(findings, []);
});

test('a raised check is listed in checks_run, because it ran', () => {
  // `docs/agents.md` promises checks_run "lists what actually ran". A consumer
  // holding an entity.page-scoped-value finding whose id is absent from that
  // list has been told the check did not run.
  const { nodes, pages } = pageScopedFixture();
  const { checksRun } = run(nodes, pages);

  assert.equal(checksRun.includes('entity.page-scoped-value'), true);
  assert.equal(checksRun.includes('entity.contradiction'), true);
});

test('an unknown --disable value is refused rather than ignored', () => {
  // Silently accepting one produced a report that stated a check had been
  // silenced when it had run normally, which the caller cannot detect: the
  // report agrees with them.
  assert.throws(
    () => run([], [page('a')], ['entity.contradction']),
    (error: unknown) => {
      assert.equal(error instanceof UnknownCheckError, true);
      assert.match((error as Error).message, /entity\.contradction/);
      // The hint has to be a real correction to be worth printing.
      assert.match((error as Error).message, /closest: entity\.contradiction/);
      return true;
    },
  );
});

test('a group name is still a valid --disable value', () => {
  assert.doesNotThrow(() => run([], [page('a')], ['coverage', 'google']));
});

// --- entity.contradiction ----------------------------------------------------

test('flags a functional property with two values under one @id', () => {
  const { findings } = run([
    node({
      id: 'https://example.com/#org',
      page: 'a',
      props: { [S('telephone')]: value('+44 1') },
    }),
    node({
      id: 'https://example.com/#org',
      page: 'b',
      props: { [S('telephone')]: value('+44 2') },
    }),
  ]);

  assert.equal(findings.length, 1);
  assert.equal(findings[0]?.check, 'entity.contradiction');
  assert.equal(findings[0]?.severity, 'error');
  assert.equal(findings[0]?.pages_affected, 2);
});

test('stays silent on a legitimately plural property', () => {
  const { findings, silenced } = run([
    node({
      id: 'https://example.com/#org',
      page: 'a',
      props: { [S('sameAs')]: ref('https://x.example') },
    }),
    node({
      id: 'https://example.com/#org',
      page: 'b',
      props: { [S('sameAs')]: ref('https://y.example') },
    }),
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
    node({
      id: 'https://example.com/#org',
      page: 'a',
      props: { [S('telephone')]: value('+44 1') },
    }),
    node({ id: 'https://example.com/#org', page: 'b', props: { [S('name')]: value('Acme') } }),
  ]);

  assert.deepEqual(findings, []);
  assert.equal(silenced['entity.partiality'], 2);
});

test('a blank-node reference is compared by denotation, not by id', () => {
  // Rule 4. Blank ids embed page_id, so comparing them made a byte-identical
  // address look like 150 distinct values across the corpus.
  const { findings } = run([
    node({
      id: '_:a/json-ld/0/1',
      page: 'a',
      types: [S('PostalAddress')],
      props: { [S('postalCode')]: value('RG1') },
    }),
    node({
      id: '_:b/json-ld/0/1',
      page: 'b',
      types: [S('PostalAddress')],
      props: { [S('postalCode')]: value('RG1') },
    }),
    node({
      id: 'https://example.com/#org',
      page: 'a',
      props: { [S('address')]: ref('_:a/json-ld/0/1') },
    }),
    node({
      id: 'https://example.com/#org',
      page: 'b',
      props: { [S('address')]: ref('_:b/json-ld/0/1') },
    }),
  ]);
  assert.deepEqual(findings, []);
});

test('a genuine difference behind blank nodes is still caught', () => {
  const { findings } = run([
    node({
      id: '_:a/x',
      page: 'a',
      types: [S('PostalAddress')],
      props: { [S('postalCode')]: value('RG1') },
    }),
    node({
      id: '_:b/x',
      page: 'b',
      types: [S('PostalAddress')],
      props: { [S('postalCode')]: value('SW1') },
    }),
    node({ id: 'https://example.com/#org', page: 'a', props: { [S('address')]: ref('_:a/x') } }),
    node({ id: 'https://example.com/#org', page: 'b', props: { [S('address')]: ref('_:b/x') } }),
  ]);
  assert.equal(findings.length, 1);
  assert.equal(findings[0]?.check, 'entity.contradiction');
});

test('a single observation cannot contradict itself', () => {
  const { findings } = run([
    node({
      id: 'https://example.com/#org',
      page: 'a',
      props: { [S('telephone')]: value('+44 1') },
    }),
  ]);
  assert.deepEqual(findings, []);
});

// --- entity.type-narrowing / conflict ---------------------------------------

test('a subclass refinement is an opportunity, not an error', () => {
  const { findings } = run([
    node({
      id: 'https://example.com/#o',
      page: 'a',
      types: [S('LocalBusiness')],
      props: { [S('name')]: value('A') },
    }),
    node({
      id: 'https://example.com/#o',
      page: 'b',
      types: [S('Organization')],
      props: { [S('name')]: value('A') },
    }),
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
    node({
      id: 'https://example.com/#p',
      page: 'a',
      types: [S('Person')],
      props: { [S('name')]: value('P') },
    }),
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
    node({
      id: 'https://example.com/#x',
      page: 'a',
      types: [S('Product')],
      props: { [S('name')]: value('X') },
    }),
    node({
      id: 'https://example.com/#x',
      page: 'b',
      types: [S('Person')],
      props: { [S('name')]: value('X') },
    }),
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
  assert.equal(
    findings.some((finding) => finding.check === 'graph.identity-fracture'),
    false,
  );
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
  assert.equal(
    findings.some((finding) => finding.check === 'graph.identity-fracture'),
    false,
  );
});

// --- graph.dangling-reference ------------------------------------------------

test('a dangling entity reference is a warning', () => {
  const { findings } = run([
    node({
      id: 'https://example.com/#site',
      page: 'a',
      props: { [S('publisher')]: ref('https://example.com/#ghost') },
    }),
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
  assert.equal(
    findings.some((finding) => finding.check === 'graph.dangling-reference'),
    false,
  );
});

test('a defined reference is not dangling', () => {
  const { findings } = run([
    node({
      id: 'https://example.com/#site',
      page: 'a',
      props: { [S('publisher')]: ref('https://example.com/#org') },
    }),
    node({ id: 'https://example.com/#org', page: 'a', props: { [S('name')]: value('Acme') } }),
  ]);
  assert.equal(
    findings.some((finding) => finding.check === 'graph.dangling-reference'),
    false,
  );
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
  assert.equal(
    findings.some((finding) => finding.check === 'url.canonical-mismatch'),
    false,
  );
});

test('a genuinely different declared canonical is a warning', () => {
  const { findings } = run(
    [],
    [
      page('a', {
        canonical_url: 'https://example.com/a',
        declared_canonical: 'https://www.example.com/a',
      }),
    ],
  );
  assert.equal(
    findings.find((finding) => finding.check === 'url.canonical-mismatch')?.severity,
    'warning',
  );
});

// --- engine ------------------------------------------------------------------

test('a disabled check does not run', () => {
  const nodes = [
    node({
      id: 'https://example.com/#org',
      page: 'a',
      props: { [S('telephone')]: value('+44 1') },
    }),
    node({
      id: 'https://example.com/#org',
      page: 'b',
      props: { [S('telephone')]: value('+44 2') },
    }),
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
  const result = runChecks({
    nodes: [],
    pages: [],
    partialCoverage: false,
    disabled: ['coverage'],
  });
  assert.equal(
    result.checksRun.some((check) => check.startsWith('coverage.')),
    false,
  );
});

test('findings are ordered errors first', () => {
  const { findings } = run([
    node({
      id: 'https://example.com/#o',
      page: 'a',
      types: [S('LocalBusiness')],
      props: { [S('name')]: value('A') },
    }),
    node({
      id: 'https://example.com/#o',
      page: 'b',
      types: [S('Organization')],
      props: { [S('name')]: value('A') },
    }),
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
    nodes: [
      node({
        id: 'https://example.com/#s',
        page: 'a',
        props: { [S('publisher')]: ref('https://example.com/#ghost') },
      }),
    ],
    pages: [page('a')],
    partialCoverage: true,
  });
  assert.equal(
    result.findings.find((finding) => finding.check === 'graph.dangling-reference')
      ?.coverage_qualified,
    true,
  );
});

// --- value.placeholder --------------------------------------------------------

test('a placeholder value is an error', () => {
  const { findings } = run([
    node({
      id: 'https://example.com/#org',
      page: 'a',
      props: { [S('name')]: value('My Website') },
    }),
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
      props: {
        [S('name')]: value('Classic Lorem Ipsum'),
        [S('description')]: value('Free tool for creating ipsum text.'),
      },
    }),
  ]);
  assert.equal(
    findings.some((finding) => finding.check === 'value.placeholder'),
    false,
  );
});

test('placeholder matching ignores case and surrounding whitespace', () => {
  const { findings } = run([
    node({
      id: 'https://example.com/#o',
      page: 'a',
      props: { [S('name')]: value('  MY WEBSITE  ') },
    }),
  ]);
  assert.equal(
    findings.some((finding) => finding.check === 'value.placeholder'),
    true,
  );
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
    node({
      id: 'https://example.com/#o',
      page: 'a',
      props: { [S('streetAddress')]: value('   ') },
    }),
  ]);
  assert.equal(
    findings.some((finding) => finding.check === 'value.empty'),
    true,
  );
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
    [
      node({
        id: 'https://example.com/#o',
        page: 'a',
        props: { [S('sameAs')]: ref('http://example.com') },
      }),
    ],
    [page('a', { canonical_url: 'https://example.com/a' })],
  );
  assert.equal(
    findings.find((finding) => finding.check === 'url.insecure-self-reference')?.severity,
    'warning',
  );
});

test('an http reference to somebody else is not our business', () => {
  const { findings } = run(
    [
      node({
        id: 'https://example.com/#o',
        page: 'a',
        props: { [S('sameAs')]: ref('http://elsewhere.example/x') },
      }),
    ],
    [page('a', { canonical_url: 'https://example.com/a' })],
  );
  assert.equal(
    findings.some((finding) => finding.check === 'url.insecure-self-reference'),
    false,
  );
});

test('an http site is not told off for using http', () => {
  const { findings } = run(
    [
      node({
        id: 'http://example.com/#o',
        page: 'a',
        props: { [S('sameAs')]: ref('http://example.com') },
      }),
    ],
    [page('a', { canonical_url: 'http://example.com/a' })],
  );
  assert.equal(
    findings.some((finding) => finding.check === 'url.insecure-self-reference'),
    false,
  );
});

// --- url.foreign-media-host ---------------------------------------------------

test('media on an unrelated host is a warning', () => {
  const { findings } = run(
    [
      node({
        id: 'https://example.com/#p',
        page: 'a',
        props: { [S('image')]: ref('https://oldagency.example/x.png') },
      }),
    ],
    [page('a', { canonical_url: 'https://example.com/a' })],
  );
  const hit = findings.find((finding) => finding.check === 'url.foreign-media-host');
  assert.equal(hit?.severity, 'warning');
  // We do not fetch off-site media, and the report must not imply we did.
  assert.match(hit?.summary ?? '', /does not fetch off-site media/);
});

test('a CDN subdomain of the site is benign', () => {
  const { findings } = run(
    [
      node({
        id: 'https://example.com/#p',
        page: 'a',
        props: { [S('image')]: ref('https://cdn.example.com/x.png') },
      }),
    ],
    [page('a', { canonical_url: 'https://example.com/a' })],
  );
  assert.equal(
    findings.some((finding) => finding.check === 'url.foreign-media-host'),
    false,
  );
});

test('gravatar is benign', () => {
  // On 7 of 22 corpus sites. Without this the check fires on most of WordPress.
  const { findings } = run(
    [
      node({
        id: 'https://example.com/#p',
        page: 'a',
        props: { [S('image')]: ref('https://secure.gravatar.com/avatar/abc') },
      }),
    ],
    [page('a', { canonical_url: 'https://example.com/a' })],
  );
  assert.equal(
    findings.some((finding) => finding.check === 'url.foreign-media-host'),
    false,
  );
});

test('a per-customer CDN subdomain is benign', () => {
  const { findings } = run(
    [
      node({
        id: 'https://example.com/#p',
        page: 'a',
        props: { [S('image')]: ref('https://d123.cloudfront.net/x.png') },
      }),
    ],
    [page('a', { canonical_url: 'https://example.com/a' })],
  );
  assert.equal(
    findings.some((finding) => finding.check === 'url.foreign-media-host'),
    false,
  );
});

test('sameAs pointing elsewhere is the entire point of sameAs', () => {
  const { findings } = run(
    [
      node({
        id: 'https://example.com/#o',
        page: 'a',
        props: { [S('sameAs')]: ref('https://linkedin.com/company/x') },
      }),
    ],
    [page('a', { canonical_url: 'https://example.com/a' })],
  );
  assert.equal(
    findings.some((finding) => finding.check === 'url.foreign-media-host'),
    false,
  );
});

test('an aggregate does not inherit advice written for one subject', () => {
  // A three-property `value.empty` aggregate read "3 properties are published
  // as empty strings" above "Fill in postalCode" — somebody following that
  // fixes one of three. The wording is kept and scoped.
  const { findings } = run([
    node({
      id: 'https://example.com/#addr',
      page: 'a',
      types: [S('PostalAddress')],
      props: {
        [S('postalCode')]: value(''),
        [S('streetAddress')]: value(''),
        [S('addressLocality')]: value(''),
      },
    }),
  ]);

  const empty = findings.find((finding) => finding.check === 'value.empty');
  assert.equal(empty?.instance_count, 3, 'three properties collapsed into one finding');
  assert.match(empty?.remediation ?? '', /Apply this to each of the 3 subjects/);
  // The explanation is kept, but framed as an example rather than the whole job.
  assert.match(empty?.summary ?? '', /Taking the first as an example/);
});

test('an aggregate that lists ten of its subjects does not claim to list them all', () => {
  // Two sentences overstated their evidence in the same finding: the summary
  // said "the individual subjects are listed below" and the remediation said
  // "each of the 154 subjects listed above", where ten were listed. Both read
  // perfectly on the five-subject aggregates they were written against.
  //
  // Assertable, unlike most prose-scope faults, because the claim is about a
  // number the code already knows.
  // One subject per empty property, as the three-property case above does —
  // `value.empty` collapses by property, so fourteen properties is fourteen
  // constituents.
  const props: Record<string, unknown[]> = {};
  for (let index = 0; index < AGGREGATE_SAMPLE + 4; index += 1) {
    props[S(`property${index}`)] = value('');
  }
  const { findings } = run([
    node({ id: 'https://example.com/#addr', page: 'a', types: [S('PostalAddress')], props }),
  ]);

  const empty = findings.find((finding) => finding.check === 'value.empty');
  assert.equal(empty?.instance_count, AGGREGATE_SAMPLE + 4);
  assert.equal(empty?.observed.length, AGGREGATE_SAMPLE);
  assert.equal(empty?.omitted_count, 4, 'the four it dropped must be counted');
  assert.match(empty?.summary ?? '', new RegExp(`${AGGREGATE_SAMPLE} of them are listed below`));
  assert.doesNotMatch(empty?.remediation ?? '', /listed above/);
});

test('an aggregate keeps every trade-off, not the first one it saw', () => {
  // `...first` spreads the leading constituent's fields, which was harmless
  // while one check shared one trade-off and became wrong once trade-offs were
  // attached to properties. An Offer aggregate led by a property with none
  // would drop the warning that a stale priceValidUntil invalidates the offer —
  // advice vanishing because of the order a Map iterated in.
  const product = node({
    id: 'https://example.com/#p',
    page: 'a',
    types: [S('Product')],
    props: {
      [S('name')]: value('X'),
      [S('image')]: ref('https://example.com/i.jpg'),
      [S('offers')]: ref('https://example.com/#o'),
      [S('review')]: ref('https://example.com/#r'),
    },
  });
  // An Offer missing all three recommended fields: availability and
  // priceCurrency carry no trade-off, priceValidUntil carries one.
  const offer = node({
    id: 'https://example.com/#o',
    page: 'a',
    types: [S('Offer')],
    props: { [S('price')]: value('1') },
  });
  const review = node({
    id: 'https://example.com/#r',
    page: 'a',
    types: [S('Review')],
    props: {
      [S('author')]: ref('https://example.com/#person'),
      [S('reviewRating')]: ref('https://example.com/#rating'),
      [S('datePublished')]: value('2026-01-01'),
    },
  });

  // The helper disables `google` by default; this is the one test that wants it.
  const { findings } = run(
    [product, offer, review],
    [page('a'), page('b')],
    ['coverage.missing-expected-entity'],
  );
  const aggregate = findings.find(
    (finding) => finding.check === 'google.missing-recommended' && finding.instance_count === 3,
  );

  assert.notEqual(aggregate, undefined, 'three Offer recommendations should collapse');
  assert.match(
    aggregate?.tradeoff ?? '',
    /worse than no date/,
    'the one constituent with a trade-off must not lose it to the two without',
  );
});

// --- how an aggregate composes its title -------------------------------------

test('every aggregate_title reads correctly after a count', () => {
  // `aggregate()` renders `${count} ${aggregate_title}`, so the phrase has to be
  // a lowercase plural. `link.noindex-only-inbound` was neither, and a real
  // report headed a finding "6 Sitemap page reachable only from noindex pages".
  //
  // Read from source rather than from findings, for the reason the
  // coverage-qualifier rule is: a runtime test only sees checks that a fixture
  // makes fire, and this one fires on almost nothing.
  //
  // The plural test is a heuristic — *some* word near the front must end in `s`
  // — because these are compound phrases whose head noun is rarely first
  // ("node types are published", "JSON-LD contexts could not be resolved"). An
  // irregular plural would trip it; none exists today, and a false failure here
  // costs one comment rather than a wrong report.
  const dir = path.dirname(fileURLToPath(import.meta.url));
  const wrong: string[] = [];

  for (const file of fs.readdirSync(dir).sort()) {
    if (!file.endsWith('.ts') || file.endsWith('.test.ts')) continue;
    const source = fs.readFileSync(path.join(dir, file), 'utf8');
    for (const match of source.matchAll(/aggregate_title: '([^']+)'/g)) {
      const phrase = match[1] ?? '';
      // Sentence case only. `JSON-LD contexts could not be resolved` opens with
      // a capital because it is an acronym, and "3 JSON-LD contexts" reads
      // perfectly — the rule is about a phrase that was written as a sentence,
      // not about any capital letter.
      if (/^[A-Z][a-z]/.test(phrase)) {
        wrong.push(`${file}: "${phrase}" is sentence-cased; it follows a number`);
      }
      if (
        !phrase
          .split(/\s+/)
          .slice(0, 3)
          .some((word) => /s$/i.test(word))
      ) {
        wrong.push(`${file}: "${phrase}" reads as singular after a count`);
      }
    }
  }

  assert.deepEqual(wrong, [], 'an aggregate title is rendered as `<count> <title>`');
});
