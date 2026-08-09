import { test } from 'node:test';
import assert from 'node:assert/strict';

import { selectSample } from './run.ts';

const ORIGIN = 'https://example.com';

interface Spec {
  sitemap: string;
  count: number;
  prefix: string;
}

/** Build candidates the way a partitioned sitemap index produces them. */
function build(specs: Spec[]): { url: string; source: string; fromSitemap: string }[] {
  return specs.flatMap((spec) =>
    Array.from({ length: spec.count }, (_unused, index) => ({
      url: `${ORIGIN}/${spec.prefix}-${index}`,
      source: `sitemap:${spec.sitemap}`,
      fromSitemap: spec.sitemap,
    })),
  );
}

const countBySitemap = (selected: { fromSitemap: string }[]): Record<string, number> => {
  const counts: Record<string, number> = {};
  for (const candidate of selected)
    counts[candidate.fromSitemap] = (counts[candidate.fromSitemap] ?? 0) + 1;
  return counts;
};

test('returns everything untouched when under the cap', () => {
  const candidates = build([{ sitemap: 'a.xml', count: 5, prefix: 'p' }]);
  assert.deepEqual(selectSample(candidates, 500, 'spread', ORIGIN), candidates);
  assert.deepEqual(selectSample(candidates, 500, 'document', ORIGIN), candidates);
});

test('document order takes the first N and nothing else', () => {
  const candidates = build([
    { sitemap: 'posts.xml', count: 1000, prefix: 'post' },
    { sitemap: 'pages.xml', count: 82, prefix: 'page' },
  ]);
  const selected = selectSample(candidates, 500, 'document', ORIGIN);

  assert.equal(selected.length, 500);
  // The failure this exists to demonstrate: not one page survives.
  assert.deepEqual(countBySitemap(selected), { 'posts.xml': 500 });
});

test('spread reaches every sitemap, including the small ones', () => {
  // The real shape of an 8,340-URL corpus site: eight post sitemaps, one page
  // sitemap of 82, one taxonomy sitemap. Document order never reaches pages.
  const candidates = build([
    ...Array.from({ length: 8 }, (_unused, index) => ({
      sitemap: `posts-${index}.xml`,
      count: 1000,
      prefix: `post${index}`,
    })),
    { sitemap: 'pages.xml', count: 82, prefix: 'page' },
    { sitemap: 'tags.xml', count: 1031, prefix: 'tag' },
  ]);

  const selected = selectSample(candidates, 500, 'spread', ORIGIN);
  const counts = countBySitemap(selected);

  assert.equal(selected.length, 500);
  assert.equal(Object.keys(counts).length, 10, 'every sitemap should be represented');
  assert.equal(counts['pages.xml'], 50, 'the small page sitemap must not be starved');
  assert.equal(counts['tags.xml'], 50);
});

test('spread does not starve a sitemap smaller than its share', () => {
  const candidates = build([
    { sitemap: 'big.xml', count: 1000, prefix: 'big' },
    { sitemap: 'tiny.xml', count: 3, prefix: 'tiny' },
  ]);
  const selected = selectSample(candidates, 100, 'spread', ORIGIN);
  const counts = countBySitemap(selected);

  // The tiny sitemap contributes all it has; the rest of the budget goes to big.
  assert.equal(counts['tiny.xml'], 3);
  assert.equal(counts['big.xml'], 97);
  assert.equal(selected.length, 100);
});

test('spread preserves document order within each sitemap', () => {
  const candidates = build([
    { sitemap: 'a.xml', count: 10, prefix: 'a' },
    { sitemap: 'b.xml', count: 10, prefix: 'b' },
  ]);
  const selected = selectSample(candidates, 6, 'spread', ORIGIN);
  const fromA = selected
    .filter((candidate) => candidate.fromSitemap === 'a.xml')
    .map((candidate) => candidate.url);

  assert.deepEqual(fromA, [`${ORIGIN}/a-0`, `${ORIGIN}/a-1`, `${ORIGIN}/a-2`]);
});

test('the front page is hoisted even when buried in a huge sitemap', () => {
  const candidates = [
    ...build([{ sitemap: 'posts.xml', count: 1000, prefix: 'post' }]),
    { url: `${ORIGIN}/`, source: 'sitemap:pages.xml', fromSitemap: 'pages.xml' },
    ...build([{ sitemap: 'pages.xml', count: 100, prefix: 'page' }]),
  ];

  for (const strategy of ['spread', 'document'] as const) {
    const selected = selectSample(candidates, 10, strategy, ORIGIN);
    assert.equal(
      selected[0]?.url,
      `${ORIGIN}/`,
      `front page should lead under --sample ${strategy}`,
    );
    assert.equal(
      selected.filter((candidate) => candidate.url === `${ORIGIN}/`).length,
      1,
      'and must not be duplicated',
    );
  }
});

test('is deterministic — the same input yields the same sample', () => {
  const candidates = build([
    { sitemap: 'a.xml', count: 300, prefix: 'a' },
    { sitemap: 'b.xml', count: 300, prefix: 'b' },
  ]);
  const first = selectSample(candidates, 97, 'spread', ORIGIN).map((candidate) => candidate.url);
  const second = selectSample(candidates, 97, 'spread', ORIGIN).map((candidate) => candidate.url);

  assert.deepEqual(first, second);
});

test('never returns duplicates', () => {
  const candidates = build([
    { sitemap: 'a.xml', count: 50, prefix: 'a' },
    { sitemap: 'b.xml', count: 50, prefix: 'b' },
  ]);
  const selected = selectSample(candidates, 40, 'spread', ORIGIN);

  assert.equal(new Set(selected.map((candidate) => candidate.url)).size, selected.length);
});

test('handles a single sitemap identically under both strategies', () => {
  const candidates = build([{ sitemap: 'only.xml', count: 100, prefix: 'p' }]);

  assert.deepEqual(
    selectSample(candidates, 20, 'spread', ORIGIN).map((candidate) => candidate.url),
    selectSample(candidates, 20, 'document', ORIGIN).map((candidate) => candidate.url),
  );
});
