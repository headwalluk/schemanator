import { test } from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';

import { discoverSitemaps, isSameSiteHost, parseSitemap, WELL_KNOWN_SITEMAP_PATHS } from './sitemaps.ts';
import { MIN_DELAY_MS, PoliteFetcher } from '../net/fetcher.ts';
import { startTestServer, type Route } from '../../test/helpers/server.ts';

const fetcher = (): PoliteFetcher => new PoliteFetcher({ delayMs: MIN_DELAY_MS, maxRetries: 0 });

const xml = (body: string): Route => ({ headers: { 'content-type': 'application/xml' }, body });

const urlset = (locs: string[]): string =>
  `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${locs.map((loc) => `  <url><loc>${loc}</loc><lastmod>2026-07-01</lastmod></url>`).join('\n')}
</urlset>`;

const sitemapindex = (locs: string[]): string =>
  `<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${locs.map((loc) => `  <sitemap><loc>${loc}</loc></sitemap>`).join('\n')}
</sitemapindex>`;

// --- parseSitemap unit tests -------------------------------------------------

test('parseSitemap reads a urlset', () => {
  const parsed = parseSitemap(Buffer.from(urlset(['https://example.com/a', 'https://example.com/b'])));
  assert.equal(parsed.format, 'urlset');
  assert.deepEqual(
    parsed.urls.map((entry) => entry.raw),
    ['https://example.com/a', 'https://example.com/b'],
  );
  assert.equal(parsed.urls[0]?.lastmod, '2026-07-01');
});

test('parseSitemap reads a urlset with a single entry', () => {
  // fast-xml-parser would collapse this to an object without isArray configured.
  const parsed = parseSitemap(Buffer.from(urlset(['https://example.com/only'])));
  assert.equal(parsed.urls.length, 1);
});

test('parseSitemap reads a sitemapindex', () => {
  const parsed = parseSitemap(Buffer.from(sitemapindex(['https://example.com/s1.xml'])));
  assert.equal(parsed.format, 'sitemapindex');
  assert.deepEqual(parsed.children, ['https://example.com/s1.xml']);
  assert.deepEqual(parsed.urls, []);
});

test('parseSitemap strips namespace prefixes', () => {
  const parsed = parseSitemap(
    Buffer.from(`<?xml version="1.0"?>
<sm:urlset xmlns:sm="http://www.sitemaps.org/schemas/sitemap/0.9">
  <sm:url><sm:loc>https://example.com/a</sm:loc></sm:url>
</sm:urlset>`),
  );
  assert.deepEqual(
    parsed.urls.map((entry) => entry.raw),
    ['https://example.com/a'],
  );
});

test('parseSitemap ignores image and video extension elements', () => {
  const parsed = parseSitemap(
    Buffer.from(`<?xml version="1.0"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"
        xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">
  <url>
    <loc>https://example.com/product</loc>
    <image:image><image:loc>https://example.com/photo.jpg</image:loc></image:image>
  </url>
</urlset>`),
  );
  assert.deepEqual(
    parsed.urls.map((entry) => entry.raw),
    ['https://example.com/product'],
  );
});

test('parseSitemap reads a plain-text sitemap', () => {
  const parsed = parseSitemap(
    Buffer.from('https://example.com/a\n# a comment\n\nhttps://example.com/b\n'),
  );
  assert.equal(parsed.format, 'text');
  assert.deepEqual(
    parsed.urls.map((entry) => entry.raw),
    ['https://example.com/a', 'https://example.com/b'],
  );
});

test('parseSitemap reads RSS', () => {
  const parsed = parseSitemap(
    Buffer.from(`<?xml version="1.0"?>
<rss version="2.0"><channel>
  <item><link>https://example.com/post-1</link><pubDate>Mon, 01 Jun 2026 00:00:00 GMT</pubDate></item>
  <item><link>https://example.com/post-2</link></item>
</channel></rss>`),
  );
  assert.equal(parsed.format, 'rss');
  assert.deepEqual(
    parsed.urls.map((entry) => entry.raw),
    ['https://example.com/post-1', 'https://example.com/post-2'],
  );
});

test('parseSitemap reads Atom and picks the alternate link', () => {
  const parsed = parseSitemap(
    Buffer.from(`<?xml version="1.0"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <link rel="edit" href="https://example.com/edit/1"/>
    <link rel="alternate" href="https://example.com/post-1"/>
    <updated>2026-06-01T00:00:00Z</updated>
  </entry>
</feed>`),
  );
  assert.equal(parsed.format, 'atom');
  assert.deepEqual(
    parsed.urls.map((entry) => entry.raw),
    ['https://example.com/post-1'],
  );
});

test('parseSitemap strips a BOM before parsing', () => {
  const parsed = parseSitemap(Buffer.concat([Buffer.from('﻿'), Buffer.from(urlset(['https://example.com/a']))]));
  assert.equal(parsed.format, 'urlset');
});

test('parseSitemap rejects an HTML page served as a sitemap', () => {
  assert.throws(
    () => parseSitemap(Buffer.from('<!DOCTYPE html><html><body>Page not found</body></html>')),
    /HTML document/,
  );
  assert.throws(() => parseSitemap(Buffer.from('<html><body>404</body></html>')), /HTML document/);
});

test('parseSitemap rejects an empty body', () => {
  assert.throws(() => parseSitemap(Buffer.from('   ')), /empty/);
});

test('parseSitemap rejects an unrecognised root element', () => {
  assert.throws(() => parseSitemap(Buffer.from('<?xml version="1.0"?><nonsense/>')), /unrecognised root element/);
});

// --- discoverSitemaps integration tests --------------------------------------

test('probes the well-known paths when robots declares none', async () => {
  const server = await startTestServer({
    '/sitemap.xml': xml(''),
    '/sitemap_index.xml': xml(''),
  });
  try {
    const discovery = await discoverSitemaps(fetcher(), server.origin);

    // Every well-known path is probed.
    for (const path of WELL_KNOWN_SITEMAP_PATHS) {
      assert.equal(server.hits.has(path), true, `expected a probe of ${path}`);
    }
    // Empty bodies and 404s during probing are not reported as errors.
    assert.deepEqual(discovery.errors, []);
  } finally {
    await server.close();
  }
});

test('does not probe when robots declares sitemaps', async () => {
  const server = await startTestServer({
    '/custom-sitemap.xml': (request) => xml(urlset([`http://${request.headers.host}/a`])) as never,
  });
  try {
    const discovery = await discoverSitemaps(fetcher(), server.origin, {
      robotsSitemaps: [server.url('/custom-sitemap.xml')],
    });

    assert.equal(server.hits.has('/sitemap.xml'), false);
    assert.deepEqual(
      discovery.urls.map((entry) => entry.url),
      [server.url('/a')],
    );
    assert.equal(discovery.sitemaps[0]?.source, 'robots');
  } finally {
    await server.close();
  }
});

test('--sitemap suppresses both robots directives and probing', async () => {
  const server = await startTestServer({
    '/named.xml': (request) => xml(urlset([`http://${request.headers.host}/named-page`])) as never,
    '/from-robots.xml': (request) => xml(urlset([`http://${request.headers.host}/robots-page`])) as never,
    '/sitemap.xml': (request) => xml(urlset([`http://${request.headers.host}/probed-page`])) as never,
  });
  try {
    const discovery = await discoverSitemaps(fetcher(), server.origin, {
      cliSitemaps: [server.url('/named.xml')],
      robotsSitemaps: [server.url('/from-robots.xml')],
    });

    assert.deepEqual(
      discovery.urls.map((entry) => entry.url),
      [server.url('/named-page')],
    );
    assert.equal(server.hits.has('/from-robots.xml'), false);
    assert.equal(server.hits.has('/sitemap.xml'), false);
    assert.equal(discovery.sitemaps[0]?.source, 'cli');
  } finally {
    await server.close();
  }
});

test('recurses a sitemap index', async () => {
  const server = await startTestServer({
    '/sitemap_index.xml': (request) =>
      xml(
        sitemapindex([`http://${request.headers.host}/posts.xml`, `http://${request.headers.host}/pages.xml`]),
      ) as never,
    '/posts.xml': (request) =>
      xml(urlset([`http://${request.headers.host}/post-1`, `http://${request.headers.host}/post-2`])) as never,
    '/pages.xml': (request) => xml(urlset([`http://${request.headers.host}/about`])) as never,
  });
  try {
    const discovery = await discoverSitemaps(fetcher(), server.origin, {
      robotsSitemaps: [server.url('/sitemap_index.xml')],
    });

    assert.deepEqual(
      discovery.urls.map((entry) => entry.url),
      [server.url('/post-1'), server.url('/post-2'), server.url('/about')],
    );
    assert.equal(discovery.sitemaps.length, 3);
    assert.equal(discovery.sitemaps[0]?.format, 'sitemapindex');
    assert.equal(discovery.sitemaps[0]?.childCount, 2);
  } finally {
    await server.close();
  }
});

test('stops recursing at the depth limit', async () => {
  const server = await startTestServer({
    '/l0.xml': (request) => xml(sitemapindex([`http://${request.headers.host}/l1.xml`])) as never,
    '/l1.xml': (request) => xml(sitemapindex([`http://${request.headers.host}/l2.xml`])) as never,
    '/l2.xml': (request) => xml(urlset([`http://${request.headers.host}/deep`])) as never,
  });
  try {
    const discovery = await discoverSitemaps(fetcher(), server.origin, {
      robotsSitemaps: [server.url('/l0.xml')],
      maxDepth: 1,
    });

    assert.equal(server.hits.has('/l2.xml'), false);
    assert.deepEqual(discovery.urls, []);
    assert.match(discovery.errors.join(' '), /depth limit \(1\) reached/);
  } finally {
    await server.close();
  }
});

test('survives a sitemap index cycle', async () => {
  const server = await startTestServer({
    '/a.xml': (request) => xml(sitemapindex([`http://${request.headers.host}/b.xml`])) as never,
    '/b.xml': (request) => xml(sitemapindex([`http://${request.headers.host}/a.xml`])) as never,
  });
  try {
    const discovery = await discoverSitemaps(fetcher(), server.origin, {
      robotsSitemaps: [server.url('/a.xml')],
      maxDepth: 10,
    });

    assert.equal(discovery.sitemaps.length, 2);
    assert.equal(server.hits.get('/a.xml'), 1);
  } finally {
    await server.close();
  }
});

test('decompresses a gzipped sitemap by magic bytes', async () => {
  const server = await startTestServer({
    '/sitemap.xml.gz': (request) => ({
      // Deliberately mislabelled: the extension says gzip, the Content-Type
      // says XML. Real hosts do exactly this. The magic bytes are the truth.
      headers: { 'content-type': 'application/xml' },
      body: zlib.gzipSync(Buffer.from(urlset([`http://${request.headers.host}/zipped-page`]))),
    }),
  });
  try {
    const discovery = await discoverSitemaps(fetcher(), server.origin, {
      robotsSitemaps: [server.url('/sitemap.xml.gz')],
    });

    assert.equal(discovery.sitemaps[0]?.gzipped, true);
    assert.deepEqual(
      discovery.urls.map((entry) => entry.url),
      [server.url('/zipped-page')],
    );
  } finally {
    await server.close();
  }
});

test('deduplicates URLs across sitemaps, keeping document order', async () => {
  const server = await startTestServer({
    '/index.xml': (request) =>
      xml(sitemapindex([`http://${request.headers.host}/one.xml`, `http://${request.headers.host}/two.xml`])) as never,
    '/one.xml': (request) =>
      xml(urlset([`http://${request.headers.host}/b`, `http://${request.headers.host}/a`])) as never,
    // /a repeats, and once with a tracking parameter that canonicalises away.
    '/two.xml': (request) =>
      xml(
        urlset([`http://${request.headers.host}/a?utm_source=x`, `http://${request.headers.host}/c`]),
      ) as never,
  });
  try {
    const discovery = await discoverSitemaps(fetcher(), server.origin, {
      robotsSitemaps: [server.url('/index.xml')],
    });

    assert.deepEqual(
      discovery.urls.map((entry) => entry.url),
      [server.url('/b'), server.url('/a'), server.url('/c')],
    );
  } finally {
    await server.close();
  }
});

test('drops cross-host entries and records why', async () => {
  const server = await startTestServer({
    '/sitemap.xml': (request) =>
      xml(
        urlset([`http://${request.headers.host}/mine`, 'https://someone-else.example/theirs']),
      ) as never,
  });
  try {
    const discovery = await discoverSitemaps(fetcher(), server.origin, {
      robotsSitemaps: [server.url('/sitemap.xml')],
    });

    assert.deepEqual(
      discovery.urls.map((entry) => entry.url),
      [server.url('/mine')],
    );
    assert.equal(discovery.dropped.length, 1);
    assert.equal(discovery.dropped[0]?.rawUrl, 'https://someone-else.example/theirs');
    assert.match(discovery.dropped[0]?.reason ?? '', /cross-host/);
  } finally {
    await server.close();
  }
});

test('isSameSiteHost forgives only the www prefix', () => {
  assert.equal(isSameSiteHost('www.example.com', 'example.com'), true);
  assert.equal(isSameSiteHost('example.com', 'www.example.com'), true);
  assert.equal(isSameSiteHost('WWW.Example.com', 'example.com'), true);
  assert.equal(isSameSiteHost('example.com', 'example.com'), true);

  // Everything else genuinely can be someone else's server.
  assert.equal(isSameSiteHost('shop.example.com', 'example.com'), false);
  assert.equal(isSameSiteHost('example.com', 'example.co.uk'), false);
  assert.equal(isSameSiteHost('example.com', 'notexample.com'), false);
  assert.equal(isSameSiteHost('www.example.com', 'www.other.com'), false);
  // Ports are part of host identity.
  assert.equal(isSameSiteHost('example.com:8443', 'example.com'), false);
});

test('keeps www/bare host variants but records the divergence', async () => {
  // A shape taken from a real corpus site: robots.txt served at the bare
  // host declares a sitemap whose entries are all on www. Dropping those left
  // us auditing the front page alone.
  //
  // Entry URLs are never fetched during discovery, only canonicalised and
  // filtered, so they need no DNS. They do need to *parse*: `www.127.0.0.1` is
  // an invalid host per WHATWG (five labels ending in a number is neither a
  // valid IPv4 address nor a valid domain), hence `localhost` here.
  const server = await startTestServer({
    '/sitemap.xml': (request) => {
      const port = (request.headers.host ?? '').split(':')[1];
      return xml(urlset([`http://www.localhost:${port}/`, `http://www.localhost:${port}/about`])) as never;
    },
  });
  try {
    const port = new URL(server.origin).port;
    const discovery = await discoverSitemaps(fetcher(), `http://localhost:${port}`, {
      robotsSitemaps: [server.url('/sitemap.xml')],
    });

    assert.deepEqual(discovery.dropped, [], 'a www variant is not a cross-host drop');
    assert.equal(discovery.urls.length, 2, 'both www URLs should be kept');
    assert.equal(discovery.hostDivergence.length, 2);
    assert.equal(discovery.hostDivergence[0]?.entryHost, `www.localhost:${port}`);
    assert.equal(discovery.hostDivergence[0]?.crawlHost, `localhost:${port}`);
  } finally {
    await server.close();
  }
});

test('a genuinely different host is still dropped', async () => {
  const server = await startTestServer({
    '/sitemap.xml': (request) => {
      const port = (request.headers.host ?? '').split(':')[1];
      return xml(
        urlset([`http://localhost:${port}/mine`, `http://shop.localhost:${port}/theirs`]),
      ) as never;
    },
  });
  try {
    const port = new URL(server.origin).port;
    const discovery = await discoverSitemaps(fetcher(), `http://localhost:${port}`, {
      robotsSitemaps: [server.url('/sitemap.xml')],
    });

    // A sibling subdomain is not the www variant and can be someone else's.
    assert.equal(discovery.urls.length, 1);
    assert.equal(discovery.dropped.length, 1);
    assert.match(discovery.dropped[0]?.reason ?? '', /cross-host/);
    assert.deepEqual(discovery.hostDivergence, []);
  } finally {
    await server.close();
  }
});

test('drops unusable entry URLs and records why', async () => {
  const server = await startTestServer({
    '/sitemap.xml': (request) =>
      xml(urlset([`http://${request.headers.host}/fine`, 'mailto:someone@example.com'])) as never,
  });
  try {
    const discovery = await discoverSitemaps(fetcher(), server.origin, {
      robotsSitemaps: [server.url('/sitemap.xml')],
    });

    assert.equal(discovery.urls.length, 1);
    assert.match(discovery.dropped[0]?.reason ?? '', /unsupported scheme/);
  } finally {
    await server.close();
  }
});

test('a declared sitemap returning 404 is an error, a failed probe is not', async () => {
  const declared = await startTestServer({});
  try {
    const withRobots = await discoverSitemaps(fetcher(), declared.origin, {
      robotsSitemaps: [declared.url('/declared-but-missing.xml')],
    });
    assert.match(withRobots.errors.join(' '), /HTTP 404/);

    const probed = await discoverSitemaps(fetcher(), declared.origin);
    assert.deepEqual(probed.errors, []);
  } finally {
    await declared.close();
  }
});

test('records a redirected sitemap rather than hiding it', async () => {
  const server = await startTestServer({
    '/old.xml': { status: 301, headers: { location: '/new.xml' } },
    '/new.xml': (request) => xml(urlset([`http://${request.headers.host}/page`])) as never,
  });
  try {
    const discovery = await discoverSitemaps(fetcher(), server.origin, {
      robotsSitemaps: [server.url('/old.xml')],
    });

    assert.equal(discovery.sitemaps[0]?.redirected, true);
    assert.equal(discovery.sitemaps[0]?.finalUrl, server.url('/new.xml'));
    assert.equal(discovery.urls.length, 1);
  } finally {
    await server.close();
  }
});

test('one broken sitemap does not abort the others', async () => {
  const server = await startTestServer({
    '/index.xml': (request) =>
      xml(
        sitemapindex([`http://${request.headers.host}/broken.xml`, `http://${request.headers.host}/good.xml`]),
      ) as never,
    '/broken.xml': xml('<urlset><url><loc>unclosed'),
    '/good.xml': (request) => xml(urlset([`http://${request.headers.host}/survivor`])) as never,
  });
  try {
    const discovery = await discoverSitemaps(fetcher(), server.origin, {
      robotsSitemaps: [server.url('/index.xml')],
    });

    assert.deepEqual(
      discovery.urls.map((entry) => entry.url),
      [server.url('/survivor')],
    );
    assert.equal(discovery.errors.length >= 1, true);
  } finally {
    await server.close();
  }
});

test('honours the sitemap document cap', async () => {
  const server = await startTestServer({
    '/index.xml': (request) =>
      xml(
        sitemapindex(
          Array.from({ length: 10 }, (_unused, index) => `http://${request.headers.host}/s${index}.xml`),
        ),
      ) as never,
    ...Object.fromEntries(
      Array.from({ length: 10 }, (_unused, index) => [
        `/s${index}.xml`,
        (request: { headers: { host?: string } }) => xml(urlset([`http://${request.headers.host}/p${index}`])),
      ]),
    ),
  });
  try {
    const discovery = await discoverSitemaps(fetcher(), server.origin, {
      robotsSitemaps: [server.url('/index.xml')],
      maxSitemaps: 4,
    });

    assert.equal(discovery.sitemaps.length, 4);
    assert.match(discovery.errors.join(' '), /stopped after 4 sitemaps/);
  } finally {
    await server.close();
  }
});
