import { test } from 'node:test';
import assert from 'node:assert/strict';

import { fetchRobots, RobotsUnavailableError, summarisePolicy } from './robots.ts';
import { MIN_DELAY_MS, PoliteFetcher } from '../net/fetcher.ts';
import { startTestServer } from '../../test/helpers/server.ts';

const fetcher = (): PoliteFetcher => new PoliteFetcher({ delayMs: MIN_DELAY_MS, maxRetries: 0 });

const plain = (body: string) => ({ headers: { 'content-type': 'text/plain' }, body });

test('parses Disallow rules and applies them to our user-agent', async () => {
  const server = await startTestServer({
    '/robots.txt': plain('User-agent: *\nDisallow: /admin/\nDisallow: /cart\n'),
  });
  try {
    const policy = await fetchRobots(fetcher(), server.origin);

    assert.equal(policy.source, 'fetched');
    assert.equal(policy.httpStatus, 200);
    assert.equal(policy.isAllowed(server.url('/about')), true);
    assert.equal(policy.isAllowed(server.url('/admin/settings')), false);
    assert.equal(policy.isAllowed(server.url('/cart')), false);
  } finally {
    await server.close();
  }
});

test('honours a group targeting schemanator specifically', async () => {
  const server = await startTestServer({
    '/robots.txt': plain(
      'User-agent: *\nDisallow:\n\nUser-agent: schemanator\nDisallow: /private/\n',
    ),
  });
  try {
    const policy = await fetchRobots(fetcher(), server.origin);
    assert.equal(policy.isAllowed(server.url('/private/x')), false);
    assert.equal(policy.isAllowed(server.url('/public/x')), true);
  } finally {
    await server.close();
  }
});

test('collects and canonicalises Sitemap directives', async () => {
  // The port is only known once the server is listening, so the directives are
  // built per-request from the Host header.
  const server = await startTestServer({
    '/robots.txt': (request) => {
      const origin = `http://${request.headers.host}`;
      return plain(
        [
          'User-agent: *',
          'Disallow:',
          `Sitemap: ${origin}/sitemap_index.xml`,
          `Sitemap: ${origin}/news-sitemap.xml?utm_source=robots`,
          'Sitemap: not a url',
          '',
        ].join('\n'),
      );
    },
  });
  try {
    const policy = await fetchRobots(fetcher(), server.origin);

    assert.deepEqual(policy.sitemaps, [
      server.url('/sitemap_index.xml'),
      // The tracking parameter is stripped by canonicalisation.
      server.url('/news-sitemap.xml'),
    ]);
    assert.equal(policy.errors.length, 1);
    assert.match(policy.errors[0] ?? '', /unusable Sitemap directive/);
  } finally {
    await server.close();
  }
});

test('reads Crawl-delay in seconds and reports it in milliseconds', async () => {
  const server = await startTestServer({
    '/robots.txt': plain('User-agent: *\nCrawl-delay: 10\n'),
  });
  try {
    const policy = await fetchRobots(fetcher(), server.origin);
    assert.equal(policy.crawlDelayMs, 10_000);
  } finally {
    await server.close();
  }
});

test('reports no Crawl-delay when none is declared', async () => {
  const server = await startTestServer({ '/robots.txt': plain('User-agent: *\nDisallow:\n') });
  try {
    const policy = await fetchRobots(fetcher(), server.origin);
    assert.equal(policy.crawlDelayMs, null);
  } finally {
    await server.close();
  }
});

test('a 404 means no restrictions', async () => {
  const server = await startTestServer({});
  try {
    const policy = await fetchRobots(fetcher(), server.origin);

    assert.equal(policy.source, 'absent');
    assert.equal(policy.httpStatus, 404);
    assert.equal(policy.isAllowed(server.url('/anything')), true);
    assert.deepEqual(policy.sitemaps, []);
  } finally {
    await server.close();
  }
});

test('a 403 also means no restrictions', async () => {
  const server = await startTestServer({ '/robots.txt': { status: 403, body: 'forbidden' } });
  try {
    const policy = await fetchRobots(fetcher(), server.origin);
    assert.equal(policy.source, 'absent');
    assert.equal(policy.isAllowed(server.url('/anything')), true);
  } finally {
    await server.close();
  }
});

test('a 500 refuses the crawl outright', async () => {
  const server = await startTestServer({ '/robots.txt': { status: 500, body: 'boom' } });
  try {
    await assert.rejects(
      () => fetchRobots(fetcher(), server.origin),
      (error: unknown) => error instanceof RobotsUnavailableError && /HTTP 500/.test(error.message),
    );
  } finally {
    await server.close();
  }
});

test('a 503 refuses the crawl outright', async () => {
  const server = await startTestServer({ '/robots.txt': { status: 503 } });
  try {
    await assert.rejects(
      () => fetchRobots(fetcher(), server.origin),
      (error: unknown) => error instanceof RobotsUnavailableError && /HTTP 503/.test(error.message),
    );
  } finally {
    await server.close();
  }
});

test('a connection failure refuses the crawl outright', async () => {
  await assert.rejects(
    () => fetchRobots(fetcher(), 'http://127.0.0.1:1'),
    (error: unknown) => error instanceof RobotsUnavailableError && /network/.test(error.message),
  );
});

test('a timeout refuses the crawl outright', async () => {
  const server = await startTestServer({
    '/robots.txt': { delayMs: 500, ...plain('User-agent: *') },
  });
  try {
    const slow = new PoliteFetcher({ delayMs: MIN_DELAY_MS, maxRetries: 0, timeoutMs: 50 });
    await assert.rejects(
      () => fetchRobots(slow, server.origin),
      (error: unknown) => error instanceof RobotsUnavailableError && /timeout/.test(error.message),
    );
  } finally {
    await server.close();
  }
});

test('an empty robots.txt is valid and fully permissive', async () => {
  const server = await startTestServer({ '/robots.txt': plain('') });
  try {
    const policy = await fetchRobots(fetcher(), server.origin);
    assert.equal(policy.isAllowed(server.url('/anything')), true);
    assert.deepEqual(policy.sitemaps, []);
  } finally {
    await server.close();
  }
});

test('robots.txt served as text/html is still parsed', async () => {
  const server = await startTestServer({
    '/robots.txt': {
      headers: { 'content-type': 'text/html' },
      body: 'User-agent: *\nDisallow: /x\n',
    },
  });
  try {
    const policy = await fetchRobots(fetcher(), server.origin);
    assert.equal(policy.isAllowed(server.url('/x')), false);
  } finally {
    await server.close();
  }
});

test('adopts the redirected host as the site origin', async () => {
  const target = await startTestServer({
    '/robots.txt': plain('User-agent: *\nDisallow: /nope\n'),
  });
  const source = await startTestServer({
    '/robots.txt': { status: 301, headers: { location: `${target.origin}/robots.txt` } },
  });
  try {
    const policy = await fetchRobots(fetcher(), source.origin);

    assert.equal(policy.siteOrigin, target.origin);
    assert.equal(policy.redirectChain.length, 1);
    assert.equal(policy.isAllowed(target.url('/nope')), false);
    assert.match(policy.errors.join(' '), /adopting .* as the site origin/);
  } finally {
    await source.close();
    await target.close();
  }
});

test('rules for a different host do not apply', async () => {
  const server = await startTestServer({
    '/robots.txt': plain('User-agent: *\nDisallow: /admin/\n'),
  });
  try {
    const policy = await fetchRobots(fetcher(), server.origin);
    // Absence of an applicable rule is permission, not prohibition.
    assert.equal(policy.isAllowed('https://elsewhere.example/admin/x'), true);
  } finally {
    await server.close();
  }
});

test('summarisePolicy produces the shape written to robots.parsed.json', async () => {
  const server = await startTestServer({
    '/robots.txt': plain('User-agent: *\nCrawl-delay: 5\nDisallow: /x\n'),
  });
  try {
    const summary = summarisePolicy(await fetchRobots(fetcher(), server.origin));

    assert.equal(summary['source'], 'fetched');
    assert.equal(summary['crawl_delay_ms'], 5000);
    assert.equal(summary['user_agent_matched'], 'schemanator');
    // Must survive a round-trip to disk.
    assert.doesNotThrow(() => JSON.parse(JSON.stringify(summary)));
  } finally {
    await server.close();
  }
});
