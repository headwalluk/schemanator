import { test } from 'node:test';
import assert from 'node:assert/strict';

import { headersFromMeta, robotsTagNoindex, selectRecordedHeaders } from './response-headers.ts';

test('only the recorded headers are kept, with lowercase names', () => {
  assert.deepEqual(
    selectRecordedHeaders({
      'X-Robots-Tag': 'noindex',
      'strict-transport-security': 'max-age=31536000',
      'content-length': '1234',
      server: 'Apache',
    }),
    { 'x-robots-tag': 'noindex', 'strict-transport-security': 'max-age=31536000' },
  );
});

test('a meta.json without headers reads as none, and a malformed one throws naming the file', () => {
  assert.equal(headersFromMeta({ url: 'https://example.com/' }, 'meta.json'), null);
  assert.deepEqual(headersFromMeta({ headers: { server: 'Apache' } }, 'meta.json'), {
    server: 'Apache',
  });
  assert.throws(() => headersFromMeta([], 'a/meta.json'), /a\/meta\.json: expected a JSON object/);
  assert.throws(
    () => headersFromMeta({ headers: ['server'] }, 'a/meta.json'),
    /a\/meta\.json: "headers" must be an object/,
  );
  assert.throws(
    () => headersFromMeta({ headers: { server: 1 } }, 'a/meta.json'),
    /a\/meta\.json: header "server" must be a string/,
  );
});

test('X-Robots-Tag noindex is read for every crawler, never for one', () => {
  const cases: [string | undefined, boolean][] = [
    ['noindex', true],
    ['NoIndex, nofollow', true],
    ['none', true],
    ['nofollow', false],
    ['googlebot: noindex', false],
    // An argument directive is not a crawler prefix, so what follows stays unscoped.
    ['unavailable_after: 25 Jun 2030 15:00:00 PST, noindex', true],
    ['max-snippet: 20, noindex', true],
    // Two headers arrive comma-joined, losing where one ended. Reading the
    // trailing `noindex` as still scoped under-reports rather than over-reports.
    ['googlebot: nofollow, noindex', false],
    [undefined, false],
  ];
  for (const [value, expected] of cases) {
    assert.equal(robotsTagNoindex(value), expected, `X-Robots-Tag: ${value}`);
  }
});
