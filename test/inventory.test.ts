/**
 * Work-directory inventory and purging.
 *
 * Purging is the only destructive thing this tool does, and the thing it
 * destroys took an hour of somebody else's bandwidth to fetch. So these cover
 * the refusals as carefully as the deletions.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { applyPurge, formatBytes, listSites, planPurge, readSite } from '../src/store/inventory.ts';
import type { PageRecord } from '../src/store/workdir.ts';

function record(id: string, overrides: Partial<PageRecord> = {}): PageRecord {
  return {
    page_id: id,
    url: `https://example.com/${id}`,
    canonical_url: `https://example.com/${id}`,
    declared_canonical: null,
    source: 'sitemap',
    http_status: 200,
    redirect_chain: [],
    content_type: 'text/html',
    fetched_at: '2026-08-02T12:00:00Z',
    content_sha256: 'x',
    bytes: 100,
    html_purged: false,
    microdata_types: [],
    extraction: null,
    errors: [],
    ...overrides,
  };
}

/** A work directory with one site in it, as the crawler would leave it. */
async function fixture(
  options: { pages?: PageRecord[]; runs?: string[]; summary?: boolean } = {},
): Promise<{
  workRoot: string;
  slug: string;
}> {
  const workRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'schemanator-inv-'));
  const slug = 'example.com';
  const root = path.join(workRoot, slug);
  const pages = options.pages ?? [record('a'), record('b')];

  await fs.mkdir(path.join(root, 'graph'), { recursive: true });
  await fs.writeFile(path.join(root, 'graph', 'nodes.jsonl'), '{"node_id":"x"}\n');

  if (options.summary !== false) {
    await fs.writeFile(
      path.join(root, 'crawl-summary.json'),
      JSON.stringify({ site_origin: 'https://example.com', site_slug: slug }),
    );
  }

  await fs.writeFile(
    path.join(root, 'pages.jsonl'),
    `${pages.map((page) => JSON.stringify(page)).join('\n')}\n`,
  );

  for (const page of pages) {
    const dir = path.join(root, 'pages', page.page_id);
    await fs.mkdir(dir, { recursive: true });
    if (!page.html_purged) await fs.writeFile(path.join(dir, 'page.html'), '<html>'.repeat(200));
    await fs.writeFile(path.join(dir, 'meta.json'), '{}');
  }

  for (const run of options.runs ?? ['20260801T120000Z', '20260802T120000Z']) {
    await fs.mkdir(path.join(root, 'reports', run), { recursive: true });
    await fs.writeFile(path.join(root, 'reports', run, 'report.json'), '{}');
  }

  return { workRoot, slug };
}

// --- reading -----------------------------------------------------------------

test('reads a site the crawler left behind', async () => {
  const { workRoot, slug } = await fixture();
  const site = await readSite(workRoot, slug);

  assert.equal(site.slug, slug);
  assert.equal(site.origin, 'https://example.com');
  assert.equal(site.pages, 2);
  assert.equal(site.pages_ok, 2);
  assert.equal(site.runs, 2);
  assert.equal(site.latest_run, '20260802T120000Z');
  assert.equal(site.html_purged, false);
  assert.equal(site.usage.html_files, 2);
  assert.equal(site.usage.html_bytes > 0, true);
  assert.deepEqual(site.notes, []);
});

test('non-200 pages are counted separately', async () => {
  const { workRoot, slug } = await fixture({
    pages: [record('a'), record('b', { http_status: 404 }), record('c', { http_status: null })],
  });
  const site = await readSite(workRoot, slug);
  assert.equal(site.pages, 3);
  assert.equal(site.pages_ok, 1);
});

test('a half-finished crawl is listed, with a note rather than a refusal', async () => {
  // The whole point is finding directories you had forgotten about, and the
  // forgotten ones are exactly the ones a crash left incomplete.
  const { workRoot, slug } = await fixture({ summary: false, runs: [] });
  const site = await readSite(workRoot, slug);

  assert.equal(site.origin, null);
  assert.equal(site.pages, 2, 'the manifest is still readable');
  assert.equal(site.runs, 0);
  assert.equal(site.notes.length, 1);
  assert.match(site.notes[0] ?? '', /crawl summary/);
});

test('a directory with no manifest is still reported', async () => {
  const workRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'schemanator-inv-'));
  await fs.mkdir(path.join(workRoot, 'stray'), { recursive: true });
  const site = await readSite(workRoot, 'stray');

  assert.equal(site.pages, null);
  assert.match(site.notes.join(' '), /nothing has been crawled/);
});

test('an empty or missing work directory lists nothing rather than throwing', async () => {
  const empty = await fs.mkdtemp(path.join(os.tmpdir(), 'schemanator-inv-'));
  assert.deepEqual(await listSites(empty), []);
  assert.deepEqual(await listSites(path.join(empty, 'nope')), []);
});

test('sites are listed largest first', async () => {
  const { workRoot } = await fixture();
  const small = path.join(workRoot, 'small.example');
  await fs.mkdir(path.join(small, 'pages', 'a'), { recursive: true });
  await fs.writeFile(path.join(small, 'pages', 'a', 'page.html'), 'x');

  const sites = await listSites(workRoot);
  assert.equal(sites.length, 2);
  assert.equal(
    sites[0]?.slug,
    'example.com',
    '"what is eating my disk" is the question this answers',
  );
});

// --- purging -----------------------------------------------------------------

test('a plan reports what would go, and removes nothing', async () => {
  const { workRoot, slug } = await fixture();
  const plan = await planPurge(workRoot, slug, 'all');

  assert.equal(plan.missing, false);
  assert.equal(plan.files > 0, true);
  assert.equal(plan.bytes > 0, true);
  // Still there. A plan is a plan.
  assert.equal((await readSite(workRoot, slug)).pages, 2);
});

test('a plan for a site that is not there says so', async () => {
  const { workRoot } = await fixture();
  const plan = await planPurge(workRoot, 'absent.example', 'all');
  assert.equal(plan.missing, true);
  assert.equal(plan.files, 0);
});

test('the html scope counts only stored pages', async () => {
  const { workRoot, slug } = await fixture();
  const all = await planPurge(workRoot, slug, 'all');
  const html = await planPurge(workRoot, slug, 'html');

  assert.equal(html.files, 2, 'two page.html files');
  assert.equal(html.files < all.files, true, 'the site holds more than its HTML');
  assert.equal(html.bytes < all.bytes, true);
});

test('purging html keeps the reports and the extracted nodes', async () => {
  const { workRoot, slug } = await fixture();
  await applyPurge(await planPurge(workRoot, slug, 'html'));

  const site = await readSite(workRoot, slug);
  assert.equal(site.usage.html_files, 0, 'the HTML should be gone');
  assert.equal(site.runs, 2, 'reports are the audit history and must survive');
  assert.equal(site.pages, 2, 'the manifest still describes what was crawled');

  const nodes = await fs.readFile(path.join(workRoot, slug, 'graph', 'nodes.jsonl'), 'utf8');
  assert.match(nodes, /node_id/);
});

test('purging html sets html_purged, so the manifest stops lying', async () => {
  // Deleting the files with `find` works and leaves pages.jsonl insisting the
  // HTML is still there. A flag that lies is worse than one that does not exist.
  const { workRoot, slug } = await fixture();
  await applyPurge(await planPurge(workRoot, slug, 'html'));

  const manifest = await fs.readFile(path.join(workRoot, slug, 'pages.jsonl'), 'utf8');
  const records = manifest
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as PageRecord);

  assert.equal(records.length, 2);
  assert.equal(
    records.every((page) => page.html_purged),
    true,
  );
  assert.equal((await readSite(workRoot, slug)).html_purged, true);
});

test('purging html twice is harmless', async () => {
  const { workRoot, slug } = await fixture();
  await applyPurge(await planPurge(workRoot, slug, 'html'));
  await applyPurge(await planPurge(workRoot, slug, 'html'));
  assert.equal((await readSite(workRoot, slug)).pages, 2);
});

test('purging everything removes the site and leaves its neighbours alone', async () => {
  const { workRoot, slug } = await fixture();
  const neighbour = path.join(workRoot, 'other.example');
  await fs.mkdir(path.join(neighbour, 'pages'), { recursive: true });
  await fs.writeFile(path.join(neighbour, 'pages.jsonl'), `${JSON.stringify(record('z'))}\n`);

  await applyPurge(await planPurge(workRoot, slug, 'all'));

  await assert.rejects(() => fs.stat(path.join(workRoot, slug)));
  const remaining = await listSites(workRoot);
  assert.deepEqual(
    remaining.map((site) => site.slug),
    ['other.example'],
  );
});

test('applying a plan for a missing site does nothing at all', async () => {
  const { workRoot } = await fixture();
  const before = await listSites(workRoot);
  await applyPurge(await planPurge(workRoot, 'absent.example', 'all'));
  assert.deepEqual(
    (await listSites(workRoot)).map((site) => site.slug),
    before.map((site) => site.slug),
  );
});

// --- formatting --------------------------------------------------------------

test('sizes read the way du reads them', () => {
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(999), '999 B');
  assert.equal(formatBytes(1024), '1.0 KB');
  assert.equal(formatBytes(1024 * 1024), '1.0 MB');
  assert.equal(formatBytes(1024 * 1024 * 20), '20 MB');
  assert.equal(formatBytes(1024 * 1024 * 1024 * 3.5), '3.5 GB');
});
