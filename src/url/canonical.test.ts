import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  canonicaliseUrl,
  coerceToUrl,
  hostKey,
  looksLikeTarget,
  sameCanonicalUrl,
  tryCanonicaliseUrl,
  UrlCanonicalisationError,
} from './canonical.ts';

interface Case {
  name: string;
  input: string;
  expected: string;
}

const CASES: Case[] = [
  // --- step 1: scheme and host case, IDN ---
  {
    name: 'lowercases scheme and host',
    input: 'HTTPS://EXAMPLE.COM/Path',
    expected: 'https://example.com/Path',
  },
  {
    name: 'preserves path case',
    input: 'https://example.com/CaseSensitive',
    expected: 'https://example.com/CaseSensitive',
  },
  {
    name: 'converts IDN to punycode',
    input: 'https://bücher.example/shop',
    expected: 'https://xn--bcher-kva.example/shop',
  },

  // --- step 2: default ports ---
  {
    name: 'strips :443 from https',
    input: 'https://example.com:443/a',
    expected: 'https://example.com/a',
  },
  {
    name: 'strips :80 from http',
    input: 'http://example.com:80/a',
    expected: 'http://example.com/a',
  },
  {
    name: 'keeps a non-default port',
    input: 'https://example.com:8443/a',
    expected: 'https://example.com:8443/a',
  },
  {
    name: 'keeps :80 on https',
    input: 'https://example.com:80/a',
    expected: 'https://example.com:80/a',
  },

  // --- step 3: dot segments ---
  {
    name: 'resolves dot segments',
    input: 'https://example.com/a/./b/../c',
    expected: 'https://example.com/a/c',
  },
  { name: 'adds the root path', input: 'https://example.com', expected: 'https://example.com/' },

  // --- step 4: percent-encoding ---
  {
    name: 'decodes unreserved percent-encodings',
    input: 'https://example.com/%7Euser',
    expected: 'https://example.com/~user',
  },
  {
    name: 'decodes encoded alphanumerics',
    input: 'https://example.com/%41%42',
    expected: 'https://example.com/AB',
  },
  {
    name: 'uppercases reserved percent-encodings',
    input: 'https://example.com/a%2fb',
    expected: 'https://example.com/a%2Fb',
  },
  {
    name: 'leaves an encoded space encoded',
    input: 'https://example.com/a?q=one%20two',
    expected: 'https://example.com/a?q=one%20two',
  },
  {
    name: 'passes malformed percent-encoding through',
    input: 'https://example.com/%zz',
    expected: 'https://example.com/%zz',
  },

  // --- step 5: fragment ---
  {
    name: 'strips the fragment',
    input: 'https://example.com/a#section',
    expected: 'https://example.com/a',
  },
  {
    name: 'strips a bare fragment marker',
    input: 'https://example.com/a#',
    expected: 'https://example.com/a',
  },

  // --- step 6: tracking parameters ---
  {
    name: 'strips utm_* by prefix',
    input: 'https://example.com/a?utm_source=x&utm_medium=y&id=5',
    expected: 'https://example.com/a?id=5',
  },
  {
    name: 'strips named tracking params',
    input: 'https://example.com/a?fbclid=x&gclid=y&p=1',
    expected: 'https://example.com/a?p=1',
  },
  {
    name: 'strips a percent-encoded tracking key',
    input: 'https://example.com/a?utm%5Fsource=x&p=1',
    expected: 'https://example.com/a?p=1',
  },
  {
    name: 'drops the ? when every param was tracking',
    input: 'https://example.com/a?utm_source=x',
    expected: 'https://example.com/a',
  },
  {
    name: 'drops an empty query',
    input: 'https://example.com/a?',
    expected: 'https://example.com/a',
  },

  // --- step 7: query sorting ---
  {
    name: 'sorts query parameters by key',
    input: 'https://example.com/a?b=2&a=1',
    expected: 'https://example.com/a?a=1&b=2',
  },
  {
    name: 'keeps repeated keys in their original order',
    input: 'https://example.com/a?tag=b&tag=a&x=1',
    expected: 'https://example.com/a?tag=b&tag=a&x=1',
  },
  {
    name: 'keeps a valueless parameter',
    input: 'https://example.com/a?flag',
    expected: 'https://example.com/a?flag',
  },
  {
    name: 'keeps an empty-valued parameter',
    input: 'https://example.com/a?a=',
    expected: 'https://example.com/a?a=',
  },

  // --- deliberate non-normalisation: these divergences ARE the findings ---
  {
    name: 'preserves an absent trailing slash',
    input: 'https://example.com/foo',
    expected: 'https://example.com/foo',
  },
  {
    name: 'preserves a present trailing slash',
    input: 'https://example.com/foo/',
    expected: 'https://example.com/foo/',
  },
  {
    name: 'preserves the www host',
    input: 'https://www.example.com/a',
    expected: 'https://www.example.com/a',
  },
  {
    name: 'preserves the bare host',
    input: 'https://example.com/a',
    expected: 'https://example.com/a',
  },
  { name: 'preserves http', input: 'http://example.com/a', expected: 'http://example.com/a' },

  // --- hygiene ---
  {
    name: 'trims surrounding whitespace',
    input: '  https://example.com/a\n',
    expected: 'https://example.com/a',
  },
  {
    name: 'drops credentials',
    input: 'https://user:pass@example.com/a',
    expected: 'https://example.com/a',
  },
];

for (const testCase of CASES) {
  test(`canonicaliseUrl ${testCase.name}`, () => {
    assert.equal(canonicaliseUrl(testCase.input), testCase.expected);
  });
}

test('canonicaliseUrl is idempotent across every case', () => {
  for (const testCase of CASES) {
    const once = canonicaliseUrl(testCase.input);
    assert.equal(canonicaliseUrl(once), once, `not idempotent: ${testCase.input}`);
  }
});

test('canonicaliseUrl rejects a non-HTTP scheme', () => {
  assert.throws(() => canonicaliseUrl('mailto:someone@example.com'), UrlCanonicalisationError);
  assert.throws(() => canonicaliseUrl('ftp://example.com/a'), UrlCanonicalisationError);
  assert.throws(() => canonicaliseUrl('javascript:alert(1)'), UrlCanonicalisationError);
});

test('canonicaliseUrl rejects unparseable input', () => {
  assert.throws(() => canonicaliseUrl(''), UrlCanonicalisationError);
  assert.throws(() => canonicaliseUrl('   '), UrlCanonicalisationError);
  assert.throws(() => canonicaliseUrl('/relative/only'), UrlCanonicalisationError);
});

test('canonicaliseUrl resolves against a base when given one', () => {
  assert.equal(
    canonicaliseUrl('/blog/foo', { base: 'https://example.com/x/y' }),
    'https://example.com/blog/foo',
  );
  assert.equal(
    canonicaliseUrl('sitemap.xml', { base: 'https://example.com/nested/robots.txt' }),
    'https://example.com/nested/sitemap.xml',
  );
});

test('canonicaliseUrl honours --no-sort-query', () => {
  assert.equal(
    canonicaliseUrl('https://example.com/a?b=2&a=1', { sortQuery: false }),
    'https://example.com/a?b=2&a=1',
  );
});

test('canonicaliseUrl honours a custom tracking list', () => {
  assert.equal(
    canonicaliseUrl('https://example.com/a?ref=x&utm_source=y', {
      trackingParams: ['ref'],
      trackingPrefixes: [],
    }),
    'https://example.com/a?utm_source=y',
  );
});

test('tryCanonicaliseUrl reports failure instead of throwing', () => {
  const good = tryCanonicaliseUrl('https://example.com/a');
  assert.equal(good.ok, true);
  assert.equal(good.ok && good.url, 'https://example.com/a');

  const bad = tryCanonicaliseUrl('mailto:x@y.com');
  assert.equal(bad.ok, false);
  assert.match(bad.ok ? '' : bad.reason, /unsupported scheme/);
});

test('sameCanonicalUrl treats the reportable divergences as different pages', () => {
  // Each of these pairs is a finding, not something to silently merge.
  assert.equal(sameCanonicalUrl('https://example.com/foo', 'https://example.com/foo/'), false);
  assert.equal(sameCanonicalUrl('https://example.com/a', 'https://www.example.com/a'), false);
  assert.equal(sameCanonicalUrl('http://example.com/a', 'https://example.com/a'), false);
});

test('sameCanonicalUrl treats the noise as the same page', () => {
  assert.equal(sameCanonicalUrl('https://EXAMPLE.com/a#top', 'https://example.com:443/a'), true);
  assert.equal(
    sameCanonicalUrl('https://example.com/a?utm_source=x', 'https://example.com/a'),
    true,
  );
  assert.equal(sameCanonicalUrl('https://example.com/b/../a', 'https://example.com/a'), true);
});

test('sameCanonicalUrl is false when either side is uncanonicalisable', () => {
  assert.equal(sameCanonicalUrl('mailto:x@y.com', 'mailto:x@y.com'), false);
});

test('hostKey includes a non-default port', () => {
  assert.equal(hostKey('https://example.com/a'), 'example.com');
  assert.equal(hostKey('https://example.com:8443/a'), 'example.com:8443');
});

// --- CLI-boundary coercion (deliberately NOT part of canonicalisation) -------

test('coerceToUrl adds https to a bare hostname', () => {
  assert.equal(coerceToUrl('example.com'), 'https://example.com');
  assert.equal(coerceToUrl('example.co.uk/path'), 'https://example.co.uk/path');
  assert.equal(coerceToUrl('  example.com  '), 'https://example.com');
});

test('coerceToUrl leaves an existing scheme alone', () => {
  assert.equal(coerceToUrl('https://example.com'), 'https://example.com');
  assert.equal(coerceToUrl('http://example.com'), 'http://example.com');
  // Including schemes we will reject downstream — rejection is not our job here.
  assert.equal(coerceToUrl('ftp://example.com'), 'ftp://example.com');
});

test('coerceToUrl handles the protocol-relative form', () => {
  assert.equal(coerceToUrl('//example.com/a'), 'https://example.com/a');
});

test('coerceToUrl rejects empty input', () => {
  assert.throws(() => coerceToUrl('   '), UrlCanonicalisationError);
});

test('coercion does not leak into canonicalisation', () => {
  // The strictness that makes http/https a reportable divergence must survive.
  assert.throws(() => canonicaliseUrl('example.com'), UrlCanonicalisationError);
  assert.equal(sameCanonicalUrl('http://example.com/', 'https://example.com/'), false);
});

test('looksLikeTarget separates hostnames from subcommands', () => {
  assert.equal(looksLikeTarget('example.com'), true);
  assert.equal(looksLikeTarget('https://example.com'), true);
  assert.equal(looksLikeTarget('crawl.com'), true);

  assert.equal(looksLikeTarget('crawl'), false);
  assert.equal(looksLikeTarget('report'), false);
  assert.equal(looksLikeTarget('localhost'), false);
});
