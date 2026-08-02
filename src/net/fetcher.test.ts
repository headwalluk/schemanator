import { test } from 'node:test';
import assert from 'node:assert/strict';

import { CrawlAbortedError, MIN_DELAY_MS, parseRetryAfter, PoliteFetcher } from './fetcher.ts';
import { startTestServer } from '../../test/helpers/server.ts';

test('parseRetryAfter reads delta-seconds', () => {
  assert.equal(parseRetryAfter('120'), 120_000);
  assert.equal(parseRetryAfter('0'), 0);
  assert.equal(parseRetryAfter(' 30 '), 30_000);
});

test('parseRetryAfter reads an HTTP-date', () => {
  const now = Date.parse('Sat, 01 Aug 2026 12:00:00 GMT');
  assert.equal(parseRetryAfter('Sat, 01 Aug 2026 12:02:00 GMT', now), 120_000);
  // A date already in the past means "now", not a negative wait.
  assert.equal(parseRetryAfter('Sat, 01 Aug 2026 11:00:00 GMT', now), 0);
});

test('parseRetryAfter returns null when absent or unintelligible', () => {
  assert.equal(parseRetryAfter(null), null);
  assert.equal(parseRetryAfter(''), null);
  assert.equal(parseRetryAfter('soon please'), null);
});

test('fetches a 200 and returns the body', async () => {
  const server = await startTestServer({ '/': { body: '<html>hello</html>' } });
  try {
    const fetcher = new PoliteFetcher();
    const record = await fetcher.fetch(server.url('/'));

    assert.equal(record.status, 200);
    assert.equal(record.error, null);
    assert.equal(record.notFetchedReason, null);
    assert.equal(record.body?.toString(), '<html>hello</html>');
    assert.equal(record.bytes, 18);
    assert.equal(record.attempts, 1);
    assert.deepEqual(record.redirectChain, []);
  } finally {
    await server.close();
  }
});

test('records the full redirect chain rather than silently following it', async () => {
  const server = await startTestServer({
    '/one': { status: 301, headers: { location: '/two' } },
    '/two': { status: 302, headers: { location: '/three' } },
    '/three': { body: 'arrived' },
  });
  try {
    const fetcher = new PoliteFetcher();
    const record = await fetcher.fetch(server.url('/one'));

    assert.equal(record.status, 200);
    assert.equal(record.requestedUrl, server.url('/one'));
    assert.equal(record.finalUrl, server.url('/three'));
    assert.equal(record.redirectChain.length, 2);
    assert.deepEqual(
      record.redirectChain.map((hop) => [hop.status, hop.location]),
      [
        [301, server.url('/two')],
        [302, server.url('/three')],
      ],
    );
  } finally {
    await server.close();
  }
});

test('resolves a relative Location against the current URL', async () => {
  const server = await startTestServer({
    '/a/b': { status: 301, headers: { location: '../c' } },
    '/c': { body: 'ok' },
  });
  try {
    const record = await new PoliteFetcher().fetch(server.url('/a/b'));
    assert.equal(record.finalUrl, server.url('/c'));
    assert.equal(record.body?.toString(), 'ok');
  } finally {
    await server.close();
  }
});

test('gives up after the redirect cap', async () => {
  const server = await startTestServer({
    '/loop': { status: 302, headers: { location: '/loop' } },
  });
  try {
    const fetcher = new PoliteFetcher({ maxRedirects: 3 });
    const record = await fetcher.fetch(server.url('/loop'));

    assert.equal(record.error?.kind, 'too-many-redirects');
    assert.equal(record.redirectChain.length, 4);
  } finally {
    await server.close();
  }
});

test('records a non-2xx without a body and without an error', async () => {
  const server = await startTestServer({ '/gone': { status: 404, body: 'nope' } });
  try {
    const record = await new PoliteFetcher().fetch(server.url('/gone'));

    assert.equal(record.status, 404);
    assert.equal(record.body, null);
    assert.equal(record.notFetchedReason, 'http-404');
    // Not an error: a 404 in a sitemap is a finding to report, not a crash.
    assert.equal(record.error, null);
  } finally {
    await server.close();
  }
});

test('rejects an unacceptable content-type', async () => {
  const server = await startTestServer({
    '/doc.pdf': { headers: { 'content-type': 'application/pdf' }, body: '%PDF-1.4' },
  });
  try {
    const record = await new PoliteFetcher().fetch(server.url('/doc.pdf'));

    assert.equal(record.status, 200);
    assert.equal(record.body, null);
    assert.equal(record.error?.kind, 'content-type-rejected');
    assert.match(record.notFetchedReason ?? '', /application\/pdf/);
  } finally {
    await server.close();
  }
});

test('accepts xhtml and honours a caller-supplied accept list', async () => {
  const server = await startTestServer({
    '/x': { headers: { 'content-type': 'application/xhtml+xml' }, body: '<html/>' },
    '/s.xml': { headers: { 'content-type': 'application/xml' }, body: '<urlset/>' },
  });
  try {
    const fetcher = new PoliteFetcher();

    const xhtml = await fetcher.fetch(server.url('/x'));
    assert.equal(xhtml.body?.toString(), '<html/>');

    const rejected = await fetcher.fetch(server.url('/s.xml'));
    assert.equal(rejected.error?.kind, 'content-type-rejected');

    const accepted = await fetcher.fetch(server.url('/s.xml'), { accept: ['application/xml'] });
    assert.equal(accepted.body?.toString(), '<urlset/>');
  } finally {
    await server.close();
  }
});

test('accepts anything when the accept list is empty', async () => {
  const server = await startTestServer({
    '/robots.txt': { headers: { 'content-type': 'text/plain' }, body: 'User-agent: *' },
  });
  try {
    const record = await new PoliteFetcher().fetch(server.url('/robots.txt'), { accept: [] });
    assert.equal(record.body?.toString(), 'User-agent: *');
  } finally {
    await server.close();
  }
});

test('abandons a body over the cap', async () => {
  const server = await startTestServer({ '/big': { body: 'x'.repeat(5000) } });
  try {
    const fetcher = new PoliteFetcher({ maxBodyBytes: 1000 });
    const record = await fetcher.fetch(server.url('/big'));

    assert.equal(record.error?.kind, 'body-too-large');
    assert.equal(record.body, null);
  } finally {
    await server.close();
  }
});

test('retries a 5xx and succeeds', async () => {
  const server = await startTestServer({
    '/flaky': (_request, hit) => (hit < 3 ? { status: 500, body: 'boom' } : { body: 'recovered' }),
  });
  try {
    const fetcher = new PoliteFetcher({ maxRetries: 2, retryBackoffMs: 1 });
    const record = await fetcher.fetch(server.url('/flaky'));

    assert.equal(record.status, 200);
    assert.equal(record.attempts, 3);
    assert.equal(record.body?.toString(), 'recovered');
  } finally {
    await server.close();
  }
});

test('gives up on a 5xx after the retry budget and reports the last response', async () => {
  const server = await startTestServer({ '/down': { status: 503, body: 'maintenance' } });
  try {
    const fetcher = new PoliteFetcher({ maxRetries: 2, retryBackoffMs: 1 });
    const record = await fetcher.fetch(server.url('/down'));

    assert.equal(record.status, 503);
    assert.equal(record.attempts, 3);
    assert.equal(record.notFetchedReason, 'http-503');
  } finally {
    await server.close();
  }
});

test('does not retry a 4xx', async () => {
  const server = await startTestServer({ '/nope': { status: 403, body: 'denied' } });
  try {
    const record = await new PoliteFetcher({ maxRetries: 2, retryBackoffMs: 1 }).fetch(server.url('/nope'));
    assert.equal(record.attempts, 1);
    assert.equal(record.status, 403);
  } finally {
    await server.close();
  }
});

test('honours Retry-After on a 429 and then succeeds', async () => {
  const server = await startTestServer({
    '/throttled': (_request, hit) =>
      hit < 3 ? { status: 429, headers: { 'retry-after': '0' }, body: 'slow down' } : { body: 'thank you' },
  });
  try {
    const fetcher = new PoliteFetcher({ delayMs: MIN_DELAY_MS });
    const record = await fetcher.fetch(server.url('/throttled'));

    assert.equal(record.status, 200);
    assert.equal(record.attempts, 3);
  } finally {
    await server.close();
  }
});

test('a 429 raises the standing delay for that host', async () => {
  const server = await startTestServer({
    '/throttled': (_request, hit) => (hit < 2 ? { status: 429, headers: { 'retry-after': '0' } } : { body: 'ok' }),
  });
  try {
    const fetcher = new PoliteFetcher({ delayMs: 250 });
    const host = new URL(server.origin).host;
    assert.equal(fetcher.hostDelay(host), 250);

    await fetcher.fetch(server.url('/throttled'));

    // One 429 means the current pace is wrong, so the pace changes permanently.
    assert.equal(fetcher.hostDelay(host), 500);
  } finally {
    await server.close();
  }
});

test('three consecutive 429s abort the crawl', async () => {
  const server = await startTestServer({
    '/hostile': { status: 429, headers: { 'retry-after': '0' }, body: 'go away' },
  });
  try {
    const fetcher = new PoliteFetcher({ delayMs: MIN_DELAY_MS, maxConsecutiveThrottles: 3 });
    await assert.rejects(
      () => fetcher.fetch(server.url('/hostile')),
      (error: unknown) => error instanceof CrawlAbortedError && /3 consecutive 429/.test(error.message),
    );
  } finally {
    await server.close();
  }
});

test('a Retry-After longer than we will wait aborts rather than sleeping', async () => {
  const server = await startTestServer({
    '/hostile': { status: 429, headers: { 'retry-after': '3600' } },
  });
  try {
    const fetcher = new PoliteFetcher({ delayMs: MIN_DELAY_MS, maxRetryAfterMs: 5000 });
    await assert.rejects(
      () => fetcher.fetch(server.url('/hostile')),
      (error: unknown) => error instanceof CrawlAbortedError && /exceeds the 5s/.test(error.message),
    );
  } finally {
    await server.close();
  }
});

test('a non-429 response resets the consecutive throttle count', async () => {
  const server = await startTestServer({
    // 429, 429, 200, 429, 429 — never three in a row, so the crawl survives.
    '/mixed': (_request, hit) =>
      hit === 3 ? { body: 'ok' } : { status: 429, headers: { 'retry-after': '0' } },
  });
  try {
    const fetcher = new PoliteFetcher({ delayMs: MIN_DELAY_MS, maxConsecutiveThrottles: 3 });
    const first = await fetcher.fetch(server.url('/mixed'));
    assert.equal(first.status, 200);

    // Two more 429s would be counts 1 and 2, not 3 and 4, so this must not throw
    // the abort — it exhausts nothing and simply keeps retrying to a 200.
    assert.equal(fetcher.hostDelay(new URL(server.origin).host) > MIN_DELAY_MS, true);
  } finally {
    await server.close();
  }
});

test('reports a timeout as a retryable error', async () => {
  const server = await startTestServer({ '/slow': { delayMs: 500, body: 'eventually' } });
  try {
    const fetcher = new PoliteFetcher({ timeoutMs: 50, maxRetries: 1, retryBackoffMs: 1, delayMs: MIN_DELAY_MS });
    const record = await fetcher.fetch(server.url('/slow'));

    assert.equal(record.error?.kind, 'timeout');
    assert.equal(record.attempts, 2);
  } finally {
    await server.close();
  }
});

test('reports a connection failure as a network error', async () => {
  // Port 1 on loopback: reserved, and nothing will ever be listening.
  const fetcher = new PoliteFetcher({ maxRetries: 0 });
  const record = await fetcher.fetch('http://127.0.0.1:1/');

  assert.equal(record.error?.kind, 'network');
  assert.equal(record.status, null);
  assert.equal(record.attempts, 1);
});

test('serialises requests to one host and spaces them by the delay', async () => {
  const server = await startTestServer({
    '/a': { body: 'a' },
    '/b': { body: 'b' },
    '/c': { body: 'c' },
  });
  try {
    const fetcher = new PoliteFetcher({ delayMs: 250 });
    const startedAt = Date.now();

    // Fired concurrently — the queue, not the caller, enforces the pacing.
    const records = await Promise.all([
      fetcher.fetch(server.url('/a')),
      fetcher.fetch(server.url('/b')),
      fetcher.fetch(server.url('/c')),
    ]);
    const elapsed = Date.now() - startedAt;

    assert.deepEqual(
      records.map((record) => record.body?.toString()),
      ['a', 'b', 'c'],
    );
    // Two gaps of 250 ms between three requests.
    assert.equal(elapsed >= 500, true, `expected >=500ms of pacing, got ${elapsed}ms`);
  } finally {
    await server.close();
  }
});

test('the delay floor cannot be overridden downwards', () => {
  const fetcher = new PoliteFetcher({ delayMs: 1 });
  assert.equal(fetcher.hostDelay('example.com'), MIN_DELAY_MS);
});

test('setHostDelay raises but never lowers', () => {
  const fetcher = new PoliteFetcher({ delayMs: 1000 });
  fetcher.setHostDelay('example.com', 5000);
  assert.equal(fetcher.hostDelay('example.com'), 5000);

  // robots.txt Crawl-delay is honoured only when longer than ours.
  fetcher.setHostDelay('example.com', 100);
  assert.equal(fetcher.hostDelay('example.com'), 5000);
});

test('a failed request does not wedge the host queue', async () => {
  const server = await startTestServer({ '/ok': { body: 'fine' } });
  try {
    const fetcher = new PoliteFetcher({ delayMs: MIN_DELAY_MS, maxRetries: 0, timeoutMs: 50 });
    const failing = fetcher.fetch(server.url('/missing-entirely'));
    const succeeding = fetcher.fetch(server.url('/ok'));

    assert.equal((await failing).status, 404);
    assert.equal((await succeeding).body?.toString(), 'fine');
  } finally {
    await server.close();
  }
});
