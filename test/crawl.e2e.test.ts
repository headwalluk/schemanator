/**
 * End-to-end crawl against the local fixture corpus.
 *
 * These are the tests that would otherwise tempt someone to point the crawler
 * at a real site. That is what the fixture corpus is for.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { runAnalysis } from '../src/analyse.ts';
import { runCrawl } from '../src/crawl/run.ts';
import { MIN_DELAY_MS } from '../src/net/fetcher.ts';
import { pageIdFor, type PageRecord } from '../src/store/workdir.ts';
import {
  FIXTURE_ALIAS_PATHS,
  FIXTURE_EXCLUDED_PATHS,
  FIXTURE_FETCHABLE_PATHS,
  startFixtureSite,
  startThrottlingSite,
} from './fixtures/site.ts';

async function tempWorkRoot(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'schemanator-test-'));
}

async function readManifest(workDir: string): Promise<PageRecord[]> {
  const raw = await fs.readFile(path.join(workDir, 'pages.jsonl'), 'utf8');
  return raw
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as PageRecord);
}

const quiet = { delayMs: MIN_DELAY_MS };

test('dry run seeds the URL list and fetches no pages', async () => {
  const site = await startFixtureSite();
  const workRoot = await tempWorkRoot();
  try {
    const summary = await runCrawl({
      startUrl: site.origin,
      workRoot,
      delayMs: MIN_DELAY_MS,
      dryRun: true,
    });

    assert.equal(summary.dry_run, true);
    // Everything robots.txt allows, which is more than what will turn out to be
    // fetchable: /gone is a 404 and /brochure.pdf is a PDF, and neither is
    // knowable until we ask. The disallowed and cross-host entries are gone.
    assert.equal(
      summary.urls_queued,
      FIXTURE_FETCHABLE_PATHS.length + FIXTURE_ALIAS_PATHS.length + 2,
    );

    // robots.txt and the sitemaps were fetched — there is no other way to
    // produce the list — but not one page was.
    assert.equal(site.hits.has('/robots.txt'), true);
    assert.equal(site.hits.has('/sitemap_index.xml'), true);
    for (const page of ['/', '/about', '/contact', '/blog/post-one']) {
      assert.equal(site.hits.has(page), false, `dry run must not fetch ${page}`);
    }

    // And nothing was written to disk.
    assert.deepEqual(await fs.readdir(workRoot), []);
    assert.equal(summary.work_dir, null);

    // The URL list travels as data in the summary, not as log output, so it
    // can go to stdout while logs go to stderr.
    assert.equal(
      summary.queued_urls?.some((url) => url.includes('/about')),
      true,
    );
    assert.equal(summary.queued_urls?.length, summary.urls_queued);
  } finally {
    await site.close();
    await fs.rm(workRoot, { recursive: true, force: true });
  }
});

test('a full crawl stores every fetchable page and records the rest', async () => {
  const site = await startFixtureSite();
  const workRoot = await tempWorkRoot();
  try {
    const summary = await runCrawl({ startUrl: site.origin, workRoot, ...quiet });
    const workDir = summary.work_dir;
    assert.notEqual(workDir, null);
    if (workDir === null) return;

    // --- seeding -------------------------------------------------------
    assert.equal(summary.seeded_from, 'sitemap');
    assert.equal(summary.aborted, null);
    // The index plus two children.
    assert.equal(summary.sitemaps.length, 3);
    assert.equal(
      summary.sitemaps.some((sitemap) => sitemap.gzipped),
      true,
    );

    // --- exclusions ----------------------------------------------------
    assert.equal(summary.urls_disallowed, 1, 'robots.txt Disallow should exclude one URL');
    assert.equal(
      site.hits.has(FIXTURE_EXCLUDED_PATHS.disallowed),
      false,
      'must not fetch a disallowed URL',
    );
    assert.equal(
      summary.dropped_entries.some((entry) => entry.rawUrl === FIXTURE_EXCLUDED_PATHS.crossHost),
      true,
      'cross-host entry should be dropped and recorded',
    );

    // --- storage -------------------------------------------------------
    const manifest = await readManifest(workDir);
    const byUrl = new Map(manifest.map((record) => [record.url, record]));

    // Keyed on canonical_url — the final URL after redirects, which is the
    // page's identity. /moved-target is reached via /moved, so its requested
    // `url` and its `canonical_url` differ.
    const byCanonical = new Map(manifest.map((record) => [record.canonical_url, record]));

    for (const pagePath of FIXTURE_FETCHABLE_PATHS) {
      const url = site.url(pagePath === '/' ? '/' : pagePath);
      const record = byCanonical.get(url);
      assert.notEqual(record, undefined, `expected a manifest record for ${url}`);
      if (record === undefined) continue;

      assert.equal(record.http_status, 200);
      // page_id is derived from the URL the fetch RESOLVED to. Deriving it from
      // the requested URL stored one page twice whenever a sitemap listed both
      // a redirecting URL and its destination.
      assert.equal(record.page_id, pageIdFor(record.canonical_url));
      assert.match(record.content_type ?? '', /text\/html/);
      assert.notEqual(record.content_sha256, null);
      assert.deepEqual(record.errors, []);

      const stored = await fs.readFile(
        path.join(workDir, 'pages', record.page_id, 'page.html'),
        'utf8',
      );
      assert.match(stored, /<!DOCTYPE html>/);

      const meta = JSON.parse(
        await fs.readFile(path.join(workDir, 'pages', record.page_id, 'meta.json'), 'utf8'),
      ) as Record<string, unknown>;
      assert.equal(meta['page_id'], record.page_id);
      assert.notEqual(meta['headers'], undefined);
    }

    // Requests that succeeded — which is more than the pages stored, because
    // two of them landed on a page another request had already claimed.
    assert.equal(summary.fetched, FIXTURE_FETCHABLE_PATHS.length + FIXTURE_ALIAS_PATHS.length);

    for (const aliasPath of FIXTURE_ALIAS_PATHS) {
      assert.equal(
        byUrl.has(site.url(aliasPath)),
        false,
        `${aliasPath} redirects to a page the sitemap also lists — it must not be a second record`,
      );
    }

    // --- the pages that must not have a body ---------------------------
    const notFound = byUrl.get(site.url(FIXTURE_EXCLUDED_PATHS.notFound));
    assert.equal(notFound?.http_status, 404);
    assert.equal(notFound?.content_sha256, null);

    const pdf = byUrl.get(site.url(FIXTURE_EXCLUDED_PATHS.notHtml));
    assert.equal(pdf?.http_status, 200);
    assert.equal(pdf?.content_sha256, null);
    assert.match(pdf?.errors.join(' ') ?? '', /content-type-rejected/);

    // Both are skips, not failures: expected and recorded, not a malfunction.
    assert.equal(summary.skipped, 2);
    assert.equal(summary.failed, 0);

    // --- redirect chain ------------------------------------------------
    //
    // /moved 301s twice and lands on /moved-target, which the same sitemap
    // lists directly. One page, one record — and the request that redirected is
    // kept rather than discarded, because which URL was asked for and what the
    // server said about it is what `indexing.sitemap-redirects` reports.
    const target = byCanonical.get(site.url('/moved-target'));
    assert.notEqual(target, undefined);
    assert.equal(target?.url, site.url('/moved-target'), 'the direct request holds the record');
    assert.deepEqual(target?.redirect_chain, []);

    const alias = target?.aliases?.find((entry) => entry.url === site.url('/moved'));
    assert.notEqual(alias, undefined, 'the redirecting request must survive as an alias');
    assert.equal(alias?.redirect_chain.length, 2, 'both hops, on the request that made them');
    assert.equal(alias?.http_status, 200);
    assert.match(alias?.source ?? '', /^sitemap:/);

    // The opposite order: /old-post is fetched AFTER the page it lands on. The
    // result must be identical, or the manifest would depend on which entry a
    // sitemap happened to list first.
    const post = byCanonical.get(site.url('/blog/post-one'));
    assert.equal(post?.url, site.url('/blog/post-one'));
    assert.equal(
      post?.aliases?.some((entry) => entry.url === site.url('/old-post')),
      true,
    );

    // --- crawl artefacts ------------------------------------------------
    const robots = await fs.readFile(path.join(workDir, 'crawl', 'robots.txt'), 'utf8');
    assert.match(robots, /Disallow: \/private\//);

    const parsed = JSON.parse(
      await fs.readFile(path.join(workDir, 'crawl', 'robots.parsed.json'), 'utf8'),
    ) as Record<string, unknown>;
    assert.equal(parsed['source'], 'fetched');
    assert.equal((parsed['sitemaps'] as string[]).length, 1);

    const sitemapFiles = await fs.readdir(path.join(workDir, 'crawl', 'sitemaps'));
    assert.equal(sitemapFiles.length, 3);
    // The gzipped one is stored decompressed, so it is greppable like the rest.
    const stored = await Promise.all(
      sitemapFiles.map((name) =>
        fs.readFile(path.join(workDir, 'crawl', 'sitemaps', name), 'utf8'),
      ),
    );
    assert.equal(
      stored.some((body) => body.includes('/blog/post-one')),
      true,
    );

    // One line per *request*, which is no longer one line per manifest record:
    // two requests landed on pages another request had already claimed, and the
    // log is the record of what was asked for rather than of what was stored.
    const log = await fs.readFile(path.join(workDir, 'crawl', 'crawl.log'), 'utf8');
    assert.equal(log.trim().split('\n').length, manifest.length + FIXTURE_ALIAS_PATHS.length);

    const runSummary = JSON.parse(
      await fs.readFile(path.join(workDir, 'crawl-summary.json'), 'utf8'),
    ) as Record<string, unknown>;
    assert.equal(
      runSummary['fetched'],
      FIXTURE_FETCHABLE_PATHS.length + FIXTURE_ALIAS_PATHS.length,
    );
  } finally {
    await site.close();
    await fs.rm(workRoot, { recursive: true, force: true });
  }
});

test('deduplicates a URL advertised twice under different spellings', async () => {
  const site = await startFixtureSite();
  const workRoot = await tempWorkRoot();
  try {
    await runCrawl({ startUrl: site.origin, workRoot, ...quiet });

    // /about appears plainly in one sitemap and with ?utm_source in another.
    assert.equal(site.hits.get('/about'), 1, '/about must be fetched exactly once');
  } finally {
    await site.close();
    await fs.rm(workRoot, { recursive: true, force: true });
  }
});

test('a repeated sitemap entry is crawled once and recorded twice', async () => {
  // Both halves matter, and they pull in opposite directions. The crawler must
  // keep deduplicating — a URL listed three times is one page, and fetching it
  // three times would be rude as well as wrong — while no longer deduplicating
  // into silence, which is why no check could see a real site whose product
  // sitemap was three copies of one URL (`dev-notes/10`, finding 7).
  const site = await startFixtureSite();
  const workRoot = await tempWorkRoot();
  try {
    const summary = await runCrawl({ startUrl: site.origin, workRoot, ...quiet });

    assert.equal(site.hits.get('/contact'), 1, 'listed twice, and must still be fetched once');

    const duplicates = summary.duplicate_entries ?? [];
    const within = duplicates.filter((entry) => entry.fromSitemap === entry.firstSitemap);
    const across = duplicates.filter((entry) => entry.fromSitemap !== entry.firstSitemap);

    assert.deepEqual(
      within.map((entry) => entry.url),
      [site.url('/contact')],
    );
    // `/about` plainly in sitemap-pages.xml, and again with a tracking
    // parameter in the gzipped one — the same page by canonical identity.
    assert.deepEqual(
      across.map((entry) => entry.url),
      [site.url('/about')],
    );
  } finally {
    await site.close();
    await fs.rm(workRoot, { recursive: true, force: true });
  }
});

test('and both repetitions reach the report as findings', async () => {
  // The plumbing between them: crawl-summary.json is written by the crawl and
  // read by `analyse`, and a check that never receives the measurement is a
  // check that quietly reports nothing. This is the only path that proves the
  // two new checks fire on something that actually happened.
  const site = await startFixtureSite();
  const workRoot = await tempWorkRoot();
  try {
    const summary = await runCrawl({ startUrl: site.origin, workRoot, ...quiet });
    const { report } = await runAnalysis({ workRoot, siteSlug: summary.site_slug });

    const checks = report.findings.map((finding) => finding.check);
    assert.equal(checks.includes('indexing.sitemap-duplicate-url'), true);
    assert.equal(checks.includes('indexing.sitemap-overlap'), true);

    const overlap = report.findings.find((finding) => finding.check === 'indexing.sitemap-overlap');
    assert.equal(overlap?.observed[0]?.value, site.url('/about'));
    assert.equal(overlap?.pages_affected, 0, 'a page listed twice is still one page');
  } finally {
    await site.close();
    await fs.rm(workRoot, { recursive: true, force: true });
  }
});

test('--max-pages truncates in sitemap document order and records the cap', async () => {
  const site = await startFixtureSite();
  const workRoot = await tempWorkRoot();
  try {
    const summary = await runCrawl({ startUrl: site.origin, workRoot, maxPages: 2, ...quiet });

    assert.equal(summary.urls_queued, 2);
    assert.deepEqual(summary.truncated, { limit: 2, dropped: 7 });

    // Document order: the first two allowed entries of sitemap-pages.xml.
    const manifest = await readManifest(summary.work_dir ?? '');
    assert.deepEqual(
      manifest.map((record) => record.url),
      [site.url('/'), site.url('/about')],
    );
  } finally {
    await site.close();
    await fs.rm(workRoot, { recursive: true, force: true });
  }
});

test('--sitemap overrides robots discovery entirely', async () => {
  const site = await startFixtureSite();
  const workRoot = await tempWorkRoot();
  try {
    const summary = await runCrawl({
      startUrl: site.origin,
      workRoot,
      cliSitemaps: [site.url('/sitemap-pages.xml')],
      ...quiet,
    });

    // robots.txt is still fetched and obeyed...
    assert.equal(site.hits.has('/robots.txt'), true);
    assert.equal(summary.urls_disallowed, 1);
    // ...but its Sitemap directive is not followed.
    assert.equal(site.hits.has('/sitemap_index.xml'), false);
    assert.equal(summary.sitemaps.length, 1);
    assert.equal(summary.sitemaps[0]?.source, 'cli');
    assert.equal(site.hits.has('/blog/post-one'), false);
  } finally {
    await site.close();
    await fs.rm(workRoot, { recursive: true, force: true });
  }
});

test('--resume skips what was already fetched', async () => {
  const site = await startFixtureSite();
  const workRoot = await tempWorkRoot();
  try {
    const first = await runCrawl({ startUrl: site.origin, workRoot, maxPages: 2, ...quiet });
    assert.equal(first.fetched, 2);
    assert.equal(site.hits.get('/about'), 1);

    const second = await runCrawl({ startUrl: site.origin, workRoot, resume: true, ...quiet });

    // The two already-done pages are not re-requested.
    assert.equal(site.hits.get('/about'), 1, 'resume must not re-fetch a completed page');
    assert.equal(second.fetched, FIXTURE_FETCHABLE_PATHS.length + FIXTURE_ALIAS_PATHS.length);
  } finally {
    await site.close();
    await fs.rm(workRoot, { recursive: true, force: true });
  }
});

test('a run without --resume starts from a clean frontier', async () => {
  const site = await startFixtureSite();
  const workRoot = await tempWorkRoot();
  try {
    await runCrawl({ startUrl: site.origin, workRoot, maxPages: 2, ...quiet });
    const second = await runCrawl({ startUrl: site.origin, workRoot, maxPages: 2, ...quiet });

    assert.equal(site.hits.get('/about'), 2, 'a fresh run should re-fetch');
    const manifest = await readManifest(second.work_dir ?? '');
    assert.equal(manifest.length, 2, 'the manifest should not accumulate across runs');
  } finally {
    await site.close();
    await fs.rm(workRoot, { recursive: true, force: true });
  }
});

test('falls back to the front page when there is no sitemap', async () => {
  const { startTestServer } = await import('./helpers/server.ts');
  const site = await startTestServer({
    '/robots.txt': {
      headers: { 'content-type': 'text/plain' },
      body: 'User-agent: *\nDisallow:\n',
    },
    '/': {
      headers: { 'content-type': 'text/html' },
      body: '<!DOCTYPE html><html><body>only page</body></html>',
    },
  });
  const workRoot = await tempWorkRoot();
  try {
    const summary = await runCrawl({ startUrl: site.origin, workRoot, ...quiet });

    assert.equal(summary.seeded_from, 'front-page');
    assert.equal(summary.fetched, 1);

    const manifest = await readManifest(summary.work_dir ?? '');
    assert.equal(manifest[0]?.url, site.url('/'));
    assert.equal(manifest[0]?.source, 'front-page-fallback');
  } finally {
    await site.close();
    await fs.rm(workRoot, { recursive: true, force: true });
  }
});

test('refuses to crawl when robots.txt is unreadable', async () => {
  const { startTestServer } = await import('./helpers/server.ts');
  const site = await startTestServer({
    '/robots.txt': { status: 503 },
    '/': { body: '<!DOCTYPE html><html><body>should never be fetched</body></html>' },
  });
  const workRoot = await tempWorkRoot();
  try {
    await assert.rejects(
      () => runCrawl({ startUrl: site.origin, workRoot, maxRetries: 0, ...quiet } as never),
      /refusing to crawl/,
    );
    assert.equal(site.hits.has('/'), false, 'no page may be fetched when robots.txt is unreadable');
    assert.deepEqual(await fs.readdir(workRoot), [], 'nothing should be written');
  } finally {
    await site.close();
    await fs.rm(workRoot, { recursive: true, force: true });
  }
});

test('backs off on a 429 and still gets the page', async () => {
  const site = await startThrottlingSite();
  const workRoot = await tempWorkRoot();
  try {
    const summary = await runCrawl({ startUrl: site.origin, workRoot, ...quiet });

    assert.equal(summary.aborted, null);
    assert.equal(summary.fetched, 2);
    assert.equal(site.hits.get('/about'), 2, 'the 429 should have been retried once');

    const manifest = await readManifest(summary.work_dir ?? '');
    const about = manifest.find((record) => record.url === site.url('/about'));
    assert.equal(about?.http_status, 200);
  } finally {
    await site.close();
    await fs.rm(workRoot, { recursive: true, force: true });
  }
});
