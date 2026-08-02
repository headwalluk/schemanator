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
  rawId?: string | null;
}): ExtractedNode {
  sequence += 1;
  return {
    node_id: options.id,
    raw_id: options.rawId ?? null,
    is_blank: options.id.startsWith('_:'),
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

const only = (check: string, nodes: ExtractedNode[], pages: PageRecord[], partial = false) =>
  runChecks({ nodes, pages, partialCoverage: partial }).findings.filter(
    (finding) => finding.check === check,
  );

// --- entity.multi-value ------------------------------------------------------

test('two values for a functional property on one page is a warning', () => {
  const findings = only(
    'entity.multi-value',
    [
      node({
        id: 'https://example.com/#org',
        page: 'a',
        props: { [S('telephone')]: [{ '@value': '+44 1' }, { '@value': '+44 2' }] },
      }),
    ],
    [page('a')],
  );
  assert.equal(findings.length, 1);
  assert.equal(findings[0]?.severity, 'warning');
});

test('a genuinely plural property is never multi-value', () => {
  const findings = only(
    'entity.multi-value',
    [
      node({
        id: 'https://example.com/#org',
        page: 'a',
        props: { [S('sameAs')]: [{ '@id': 'https://x.example' }, { '@id': 'https://y.example' }] },
      }),
    ],
    [page('a')],
  );
  assert.deepEqual(findings, []);
});

test('the same value repeated is one value, not two', () => {
  // Rule 6: compare what a value denotes, not how it is spelled.
  const findings = only(
    'entity.multi-value',
    [
      node({
        id: 'https://example.com/#org',
        page: 'a',
        props: { [S('telephone')]: [{ '@value': '+44 1' }, { '@value': '+44 1' }] },
      }),
    ],
    [page('a')],
  );
  assert.deepEqual(findings, []);
});

// --- graph.relative-id -------------------------------------------------------

test('a fragment-only @id is a warning', () => {
  const findings = only(
    'graph.relative-id',
    [
      node({ id: 'https://example.com/a#organization', page: 'a', rawId: '#organization', props: { [S('name')]: [{ '@value': 'Acme' }] } }),
      node({ id: 'https://example.com/b#organization', page: 'b', rawId: '#organization', props: { [S('name')]: [{ '@value': 'Acme' }] } }),
    ],
    [page('a'), page('b')],
  );
  assert.equal(findings.length, 1);
  assert.equal(findings[0]?.severity, 'warning');
  assert.equal(findings[0]?.pages_affected, 2);
});

test('a root-relative @id is NOT a finding', () => {
  // The corpus's only 56 relative ids are all `/shop` on one site. A
  // root-relative path resolves to the same absolute IRI on every page, so
  // nothing fractures and there is nothing to fix.
  const findings = only(
    'graph.relative-id',
    [
      node({ id: 'https://example.com/shop', page: 'a', rawId: '/shop', props: { [S('name')]: [{ '@value': 'Shop' }] } }),
      node({ id: 'https://example.com/shop', page: 'b', rawId: '/shop', props: { [S('name')]: [{ '@value': 'Shop' }] } }),
    ],
    [page('a'), page('b')],
  );
  assert.deepEqual(findings, []);
});

// --- graph.orphan-node -------------------------------------------------------

test('an unreferenced PostalAddress is an orphan', () => {
  const findings = only(
    'graph.orphan-node',
    [
      node({
        id: '_:a/json-ld/0/0/address/0',
        page: 'a',
        types: [S('PostalAddress')],
        props: { [S('postalCode')]: [{ '@value': 'RG1' }] },
      }),
    ],
    [page('a')],
  );
  assert.equal(findings.length, 1);
  assert.equal(findings[0]?.severity, 'opportunity');
});

test('a page subject is never an orphan', () => {
  // The naive rule fired 1,480 times across the corpus, every one of them a
  // page subject: Article, NewsArticle, Product, Event. Nothing links to them
  // because they are what the page is about.
  const subjects = [S('Article'), S('NewsArticle'), S('Product'), S('Event'), S('Service')];
  for (const type of subjects) {
    const findings = only(
      'graph.orphan-node',
      [node({ id: `https://example.com/a#thing`, page: 'a', types: [type], props: { [S('name')]: [{ '@value': 'X' }] } })],
      [page('a')],
    );
    assert.deepEqual(findings, [], `${type} was reported as an orphan`);
  }
});

test('a BreadcrumbList is a page-root type, never an orphan', () => {
  const findings = only(
    'graph.orphan-node',
    [
      node({
        id: 'https://example.com/a#breadcrumb',
        page: 'a',
        types: [S('BreadcrumbList')],
        props: { [S('itemListElement')]: [{ '@id': '_:x' }] },
      }),
    ],
    [page('a')],
  );
  assert.deepEqual(findings, []);
});

test('a node referenced only through a url-valued property is not an orphan', () => {
  // `graph.referenced` excludes url-valued properties by design, which made
  // every potentialAction.target EntryPoint look orphaned — 150 on one site.
  const findings = only(
    'graph.orphan-node',
    [
      node({
        id: 'https://example.com/a#action',
        page: 'a',
        types: [S('SearchAction')],
        props: { [S('target')]: [{ '@id': '_:a/entrypoint' }] },
      }),
      node({
        id: '_:a/entrypoint',
        page: 'a',
        types: [S('EntryPoint')],
        props: { [S('urlTemplate')]: [{ '@value': 'https://example.com/?s={q}' }] },
      }),
    ],
    [page('a')],
  );
  assert.deepEqual(findings, []);
});

test('a nested address referenced from another page is not an orphan', () => {
  // The node index is deduplicated by @id, so building the reference set from
  // it saw only one page's parent and reported every other page's nested
  // address as unreferenced — 6 sites in the shakedown.
  const nodes = ['a', 'b', 'c'].flatMap((pageId) => [
    node({
      id: 'https://example.com/#org',
      page: pageId,
      props: { [S('address')]: [{ '@id': `_:${pageId}/address` }], [S('name')]: [{ '@value': 'Acme' }] },
    }),
    node({
      id: `_:${pageId}/address`,
      page: pageId,
      types: [S('PostalAddress')],
      props: { [S('postalCode')]: [{ '@value': 'RG1' }] },
    }),
  ]);

  assert.deepEqual(only('graph.orphan-node', nodes, [page('a'), page('b'), page('c')]), []);
});

// --- graph.blank-node-entity -------------------------------------------------

test('a substantial entity with no @id is reported once per type', () => {
  // One corpus site publishes 150 blank Person nodes; another 117 blank
  // Organizations under two spellings of one name.
  const nodes = ['a', 'b', 'c'].map((pageId) =>
    node({
      id: `_:${pageId}/person`,
      page: pageId,
      types: [S('Person')],
      props: { [S('name')]: [{ '@value': 'Jo Bloggs' }] },
    }),
  );

  const findings = only('graph.blank-node-entity', nodes, [page('a'), page('b'), page('c')]);
  assert.equal(findings.length, 1);
  assert.equal(findings[0]?.pages_affected, 3);
  assert.match(findings[0]?.title ?? '', /3 Person/);
});

test('a blank structured value is not a substantial entity', () => {
  const findings = only(
    'graph.blank-node-entity',
    [
      node({
        id: '_:a/address',
        page: 'a',
        types: [S('PostalAddress')],
        props: { [S('postalCode')]: [{ '@value': 'RG1' }] },
      }),
    ],
    [page('a')],
  );
  assert.deepEqual(findings, []);
});

// --- url.trailing-slash-drift ------------------------------------------------

test('both spellings of one path is an opportunity', () => {
  const findings = only(
    'url.trailing-slash-drift',
    [
      node({
        id: 'https://example.com/a#org',
        page: 'a',
        props: { [S('sameAs')]: [{ '@id': 'https://example.com/shop' }, { '@id': 'https://example.com/shop/' }] },
      }),
    ],
    [page('a')],
  );
  assert.equal(findings.length, 1);
  assert.equal(findings[0]?.severity, 'opportunity');
});

test('the root path is not trailing-slash drift', () => {
  const findings = only(
    'url.trailing-slash-drift',
    [
      node({
        id: 'https://example.com/a#org',
        page: 'a',
        props: { [S('url')]: [{ '@id': 'https://example.com/' }] },
      }),
    ],
    [page('a')],
  );
  assert.deepEqual(findings, []);
});

// --- coverage.type-gap -------------------------------------------------------

function section(count: number, withType: number): { nodes: ExtractedNode[]; pages: PageRecord[] } {
  const nodes: ExtractedNode[] = [];
  const pages: PageRecord[] = [];
  for (let index = 0; index < count; index += 1) {
    const id = `shop/item-${index}`;
    pages.push(page(id));
    if (index < withType) {
      nodes.push(
        node({ id: `https://example.com/${id}#product`, page: id, types: [S('Product')], props: { [S('name')]: [{ '@value': `Item ${index}` }] } }),
      );
    }
  }
  return { nodes, pages };
}

test('a minority of a section missing the usual type is an opportunity', () => {
  const { nodes, pages } = section(20, 18);
  const findings = only('coverage.type-gap', nodes, pages);
  assert.equal(findings.length, 1);
  assert.equal(findings[0]?.pages_affected, 2);
});

test('a section smaller than the minimum group size is never a gap', () => {
  const { nodes, pages } = section(9, 8);
  assert.deepEqual(only('coverage.type-gap', nodes, pages), []);
});

test("a section's own index page is not a member of the section", () => {
  // `/shop/` is not a product, and `/vulnerability-writeups/` is not a
  // writeup. Both were reported as gaps in the first shakedown.
  const { nodes, pages } = section(20, 20);
  const findings = only('coverage.type-gap', nodes, [...pages, page('shop/')]);
  assert.deepEqual(findings, []);
});

test('structural and action types are never reported as gaps', () => {
  // "1 of 25 pages carry no Thing", "2 of 32 carry no CommentAction".
  for (const type of [S('Thing'), S('WebPage'), S('CommentAction'), S('ReadAction')]) {
    const nodes: ExtractedNode[] = [];
    const pages: PageRecord[] = [];
    for (let index = 0; index < 20; index += 1) {
      const id = `shop/item-${index}`;
      pages.push(page(id));
      if (index < 18) nodes.push(node({ id: `https://example.com/${id}#n`, page: id, types: [type], props: { [S('name')]: [{ '@value': 'x' }] } }));
    }
    assert.deepEqual(only('coverage.type-gap', nodes, pages), [], `${type} was reported as a gap`);
  }
});

test('type-gap is suppressed under partial coverage', () => {
  const { nodes, pages } = section(20, 18);
  assert.deepEqual(only('coverage.type-gap', nodes, pages, true), []);
});

// --- coverage.missing-expected-entity ----------------------------------------

test('a site with no Organization at all is an opportunity', () => {
  const findings = only(
    'coverage.missing-expected-entity',
    [node({ id: 'https://example.com/a#page', page: 'a', types: [S('WebPage')], props: { [S('name')]: [{ '@value': 'A' }] } })],
    [page('a')],
  );
  assert.equal(findings.length, 1);
  assert.match(findings[0]?.summary ?? '', /no Organization/);
});

test('a well-described site produces nothing', () => {
  const findings = only(
    'coverage.missing-expected-entity',
    [
      node({
        id: 'https://example.com/#org',
        page: 'a',
        props: {
          [S('name')]: [{ '@value': 'Acme' }],
          [S('logo')]: [{ '@id': 'https://example.com/logo.png' }],
          [S('sameAs')]: [{ '@id': 'https://social.example/acme' }],
        },
      }),
    ],
    [page('a')],
  );
  assert.deepEqual(findings, []);
});

test('missing-expected-entity is suppressed under partial coverage', () => {
  const findings = only(
    'coverage.missing-expected-entity',
    [node({ id: 'https://example.com/a#page', page: 'a', types: [S('WebPage')], props: { [S('name')]: [{ '@value': 'A' }] } })],
    [page('a')],
    true,
  );
  assert.deepEqual(findings, []);
});

// --- coverage.competing-syntax: types come from THIS site --------------------

test('the microdata types reported are the ones found on this site', () => {
  // Until 1.1.0 the summary named WPHeader, SiteNavigationElement and Blog —
  // types measured on two other sites — as an illustration of what microdata
  // usually is. An agent consuming the report repeated them as fact about a
  // site where nothing had checked.
  const withMicrodata = (id: string, types: string[]): PageRecord =>
    page(id, {
      microdata_types: types,
      extraction: { json_ld_blocks: 1, json_ld_failed: 0, microdata_items: types.length, rdfa_items: 0, nodes: 1 },
    });

  const findings = only(
    'coverage.competing-syntax',
    [node({ id: 'https://example.com/a#page', page: 'a', types: [S('WebPage')], props: { [S('name')]: [{ '@value': 'A' }] } })],
    [withMicrodata('a', ['WPFooter', 'Recipe']), withMicrodata('b', ['Recipe'])],
  );

  assert.equal(findings.length, 1);
  const summary = findings[0]?.summary ?? '';

  // What was actually found, with per-page counts.
  assert.match(summary, /Recipe \(2 pages\)/);
  assert.match(summary, /WPFooter \(1 page\)/);

  // And nothing borrowed from another site's markup.
  for (const borrowed of ['SiteNavigationElement', 'WPHeader', 'Blog']) {
    assert.equal(summary.includes(borrowed), false, `summary cites ${borrowed}, which is not on this site`);
  }
});

test('a type present in both syntaxes is distinguished from one that is not', () => {
  const findings = only(
    'coverage.competing-syntax',
    [node({ id: 'https://example.com/a#page', page: 'a', types: [S('WebPage')], props: { [S('name')]: [{ '@value': 'A' }] } })],
    [
      page('a', {
        microdata_types: ['WebPage', 'WPFooter'],
        extraction: { json_ld_blocks: 1, json_ld_failed: 0, microdata_items: 2, rdfa_items: 0, nodes: 1 },
      }),
    ],
  );

  const observed = findings[0]?.observed.map((entry) => entry.value) ?? [];
  assert.equal(observed.includes('WebPage — also in the JSON-LD'), true);
  assert.equal(observed.includes('WPFooter — not in the JSON-LD'), true);
});

test('a crawl predating type recording says so rather than guessing', () => {
  const findings = only(
    'coverage.competing-syntax',
    [node({ id: 'https://example.com/a#page', page: 'a', types: [S('WebPage')], props: { [S('name')]: [{ '@value': 'A' }] } })],
    [
      page('a', {
        microdata_types: [],
        extraction: { json_ld_blocks: 1, json_ld_failed: 0, microdata_items: 4, rdfa_items: 0, nodes: 1 },
      }),
    ],
  );

  assert.match(findings[0]?.summary ?? '', /types are not known/);
  assert.match(findings[0]?.summary ?? '', /analyse/);
});
