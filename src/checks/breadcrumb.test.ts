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
  types: string[];
  props?: Record<string, unknown[]>;
}): ExtractedNode {
  sequence += 1;
  return {
    node_id: options.id,
    raw_id: null,
    is_blank: options.id.startsWith('_:'),
    page_id: options.page,
    types: options.types,
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
 * Build a `BreadcrumbList` plus its `ListItem`s.
 *
 * `item: null` means the crumb carries no `item` at all, which is what the
 * final crumb does on 1,544 of the corpus's 1,545 such crumbs.
 */
function trail(options: {
  page: string;
  id?: string;
  crumbs: { name: string; item: string | null }[];
}): ExtractedNode[] {
  const listId = options.id ?? `_:${options.page}/json-ld/0/0`;
  // Derived from the list, not the page: two trails on one page must not share
  // crumb ids, or the second silently overwrites the first in the node index.
  const itemIds = options.crumbs.map((_, index) => `${listId}/il/${index}`);

  return [
    node({
      id: listId,
      page: options.page,
      types: [S('BreadcrumbList')],
      props: { [S('itemListElement')]: itemIds.map((id) => ({ '@id': id })) },
    }),
    ...options.crumbs.map((crumb, index) =>
      node({
        id: itemIds[index] ?? '',
        page: options.page,
        types: [S('ListItem')],
        props: {
          [S('position')]: [{ '@value': index + 1 }],
          [S('name')]: [{ '@value': crumb.name }],
          ...(crumb.item === null ? {} : { [S('item')]: [{ '@value': crumb.item }] }),
        },
      }),
    ),
  ];
}

const CHECKS_UNDER_TEST = new Set([
  'breadcrumb.cycle',
  'breadcrumb.multiple-parents',
  'breadcrumb.broken-trail-item',
  'breadcrumb.inconsistent-depth',
  'breadcrumb.missing',
]);

function run(nodes: ExtractedNode[], pages: PageRecord[], partialCoverage = false) {
  const { findings } = runChecks({ nodes, pages, partialCoverage });
  return findings.filter((finding) => CHECKS_UNDER_TEST.has(finding.check));
}

// --- the pattern that must never be a finding --------------------------------

test('a final crumb with no item is normal, not a broken trail', () => {
  // 1,544 of the 1,545 crumbs in the corpus that omit `item` are the final one:
  // it is the current page, so it needs no link. Flagging this would fire on 18
  // of 18 sites carrying breadcrumbs.
  const nodes = [
    ...trail({
      page: 'a',
      crumbs: [
        { name: 'Home', item: 'https://example.com/' },
        { name: 'About', item: null },
      ],
    }),
  ];
  assert.deepEqual(run(nodes, [page('a')]), []);
});

test('a well-formed trail produces nothing at all', () => {
  const nodes = [
    ...trail({
      page: 'shop/thing',
      crumbs: [
        { name: 'Home', item: 'https://example.com/' },
        { name: 'Shop', item: 'https://example.com/shop/' },
        { name: 'Thing', item: null },
      ],
    }),
    ...trail({
      page: 'shop/other',
      crumbs: [
        { name: 'Home', item: 'https://example.com/' },
        { name: 'Shop', item: 'https://example.com/shop/' },
        { name: 'Other', item: null },
      ],
    }),
  ];
  const pages = [page('shop/thing'), page('shop/other'), page('shop/')];
  assert.deepEqual(run(nodes, pages), []);
});

// --- breadcrumb.cycle --------------------------------------------------------

test('a trail that visits the same page twice is an error', () => {
  // One corpus site emits `/ > /blog/ > /blog/ > <post>` on 24 pages.
  const nodes = trail({
    page: 'post',
    crumbs: [
      { name: 'Home', item: 'https://example.com/' },
      { name: 'Blog', item: 'https://example.com/blog/' },
      { name: 'Blog', item: 'https://example.com/blog/' },
      { name: 'Post', item: null },
    ],
  });

  const findings = run(nodes, [page('post'), page('blog/')]);
  assert.equal(findings.length, 1);
  assert.equal(findings[0]?.check, 'breadcrumb.cycle');
  assert.equal(findings[0]?.severity, 'error');
});

test('a cycle suppresses the depth finding it causes', () => {
  // Rule 5: the repeated crumb *is* why the page sits at two depths. Reporting
  // both bills the operator twice for one fix.
  const nodes = trail({
    page: 'post',
    crumbs: [
      { name: 'Home', item: 'https://example.com/' },
      { name: 'Blog', item: 'https://example.com/blog/' },
      { name: 'Blog', item: 'https://example.com/blog/' },
      { name: 'Post', item: null },
    ],
  });

  const findings = run(nodes, [page('post'), page('blog/')]);
  assert.equal(
    findings.filter((finding) => finding.check === 'breadcrumb.inconsistent-depth').length,
    0,
  );
});

test('parents forming a loop across pages is an error', () => {
  const nodes = [
    ...trail({
      page: 'a',
      crumbs: [
        { name: 'B', item: 'https://example.com/b' },
        { name: 'A', item: 'https://example.com/a' },
      ],
    }),
    ...trail({
      page: 'b',
      crumbs: [
        { name: 'A', item: 'https://example.com/a' },
        { name: 'B', item: 'https://example.com/b' },
      ],
    }),
  ];

  const findings = run(nodes, [page('a'), page('b')]);
  const cycles = findings.filter((finding) => finding.check === 'breadcrumb.cycle');
  assert.equal(cycles.length, 1);
  assert.equal(cycles[0]?.severity, 'error');
});

// --- breadcrumb.multiple-parents ---------------------------------------------

test('two trails on one page disagreeing is reported as competing generators', () => {
  // One corpus site: a themed trail rooted at `/` and a second unlabelled one
  // rooted at `/shop`, on 56 pages. Two plugins, one fix.
  const nodes = [
    ...trail({
      page: 'thing',
      id: '_:thing/json-ld/0/0',
      crumbs: [
        { name: 'Home', item: 'https://example.com/' },
        { name: 'Thing', item: null },
      ],
    }),
    ...trail({
      page: 'thing',
      id: '_:thing/json-ld/1/0',
      crumbs: [
        { name: 'Shop', item: 'https://example.com/shop' },
        { name: 'Thing', item: 'https://example.com/thing' },
      ],
    }),
  ];

  const findings = run(nodes, [page('thing')]);
  const parents = findings.filter((finding) => finding.check === 'breadcrumb.multiple-parents');
  assert.equal(parents.length, 1);
  assert.equal(parents[0]?.severity, 'warning');
  assert.match(parents[0]?.title ?? '', /disagree/);
  assert.equal(parents[0]?.pattern, 'competing trails on one page');
});

test('disagreement across pages is reported as a taxonomy problem', () => {
  const nodes = [
    ...trail({
      page: 'x',
      crumbs: [
        { name: 'A', item: 'https://example.com/a' },
        { name: 'Target', item: 'https://example.com/target' },
      ],
    }),
    ...trail({
      page: 'y',
      crumbs: [
        { name: 'B', item: 'https://example.com/b' },
        { name: 'Target', item: 'https://example.com/target' },
      ],
    }),
  ];

  const findings = run(nodes, [page('x'), page('y')]);
  const parents = findings.filter((finding) => finding.check === 'breadcrumb.multiple-parents');
  assert.equal(parents.length, 1);
  assert.equal(parents[0]?.pattern, 'parents disagree across pages');
});

// --- breadcrumb.broken-trail-item --------------------------------------------

test('a crumb pointing at a non-200 page is a warning', () => {
  const nodes = trail({
    page: 'a',
    crumbs: [
      { name: 'Gone', item: 'https://example.com/gone' },
      { name: 'A', item: null },
    ],
  });

  const findings = run(nodes, [page('a'), page('gone', { http_status: 404 })]);
  const broken = findings.filter((finding) => finding.check === 'breadcrumb.broken-trail-item');
  assert.equal(broken.length, 1);
  assert.match(broken[0]?.title ?? '', /404/);
});

test('a crumb pointing at a page the crawl never saw is NOT a finding', () => {
  // The false-positive class the shakedown caught. headwall-hosting.com named
  // four live section pages as "not on the site" — none had a single frontier
  // entry, because a sitemap-driven crawl never discovered them.
  // `coverage.complete` means "we fetched all we found", not "we saw every URL".
  const nodes = trail({
    page: 'a',
    crumbs: [
      { name: 'Guides', item: 'https://example.com/guides/' },
      { name: 'A', item: null },
    ],
  });

  assert.deepEqual(
    run(nodes, [page('a')]).filter((finding) => finding.check === 'breadcrumb.broken-trail-item'),
    [],
  );
});

test('an off-site crumb is never judged', () => {
  const nodes = trail({
    page: 'a',
    crumbs: [
      { name: 'Elsewhere', item: 'https://other.example.org/thing' },
      { name: 'A', item: null },
    ],
  });

  assert.deepEqual(
    run(nodes, [page('a')]).filter((finding) => finding.check === 'breadcrumb.broken-trail-item'),
    [],
  );
});

// --- breadcrumb.inconsistent-depth -------------------------------------------

test('one page at two depths under one parent is an opportunity', () => {
  const nodes = [
    ...trail({
      page: 'x',
      crumbs: [
        { name: 'Root', item: 'https://example.com/root' },
        { name: 'Target', item: 'https://example.com/target' },
      ],
    }),
    ...trail({
      page: 'y',
      crumbs: [
        { name: 'Top', item: 'https://example.com/top' },
        { name: 'Root', item: 'https://example.com/root' },
        { name: 'Target', item: 'https://example.com/target' },
      ],
    }),
  ];

  // Note both `/root` and `/target` genuinely drift here — adding a level above
  // `/root` moves everything below it — so two findings is correct, not a bug.
  const findings = run(nodes, [page('x'), page('y')]);
  const depth = findings.filter((finding) => finding.check === 'breadcrumb.inconsistent-depth');
  const target = depth.find((finding) => finding.subject.id === 'https://example.com/target');

  assert.equal(depth.length, 2);
  assert.notEqual(target, undefined);
  assert.equal(target?.severity, 'opportunity');
  assert.notEqual(target?.tradeoff, null);
  assert.deepEqual(
    target?.observed.map((entry) => entry.value),
    ['depth 2', 'depth 3'],
  );
});

// --- breadcrumb.missing ------------------------------------------------------

test('a page in the tree that publishes no trail is an opportunity', () => {
  const nodes = trail({
    page: 'parent',
    crumbs: [
      { name: 'Home', item: 'https://example.com/' },
      { name: 'Parent', item: null },
    ],
  });
  // `child` is named as a crumb by nobody yet; add a trail that places it.
  const placing = trail({
    page: 'parent',
    id: '_:parent/json-ld/1/0',
    crumbs: [
      { name: 'Parent', item: 'https://example.com/parent' },
      { name: 'Child', item: 'https://example.com/child' },
    ],
  });

  const findings = run([...nodes, ...placing], [page('parent'), page('child'), page('')]);
  const missing = findings.filter((finding) => finding.check === 'breadcrumb.missing');
  assert.equal(missing.length, 1);
  assert.equal(missing[0]?.severity, 'opportunity');
  assert.equal(missing[0]?.coverage_qualified, true);
});

test('breadcrumb.missing is suppressed under partial coverage', () => {
  // Rule 3. Under a truncated crawl the page may simply be one we never fetched.
  const nodes = trail({
    page: 'parent',
    crumbs: [
      { name: 'Parent', item: 'https://example.com/parent' },
      { name: 'Child', item: 'https://example.com/child' },
    ],
  });

  const findings = run([...nodes], [page('parent'), page('child')], true);
  assert.deepEqual(
    findings.filter((finding) => finding.check === 'breadcrumb.missing'),
    [],
  );
});
