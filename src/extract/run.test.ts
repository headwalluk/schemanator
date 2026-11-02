import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { WorkDir, type PageRecord } from '../store/workdir.ts';
import { runExtraction } from './run.ts';

const ROOTS: string[] = [];
after(async () => {
  await Promise.all(ROOTS.map((root) => fs.rm(root, { recursive: true, force: true })));
});

/** A one-page work directory whose `meta.json` holds `metaText`. */
async function siteWithMeta(metaText: string | null): Promise<WorkDir> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'schemanator-extract-'));
  ROOTS.push(root);
  const workDir = new WorkDir(root, 'example.com');
  await workDir.init();

  const record: PageRecord = {
    page_id: 'home',
    url: 'https://example.com/',
    canonical_url: 'https://example.com/',
    declared_canonical: null,
    source: 'sitemap:https://example.com/sitemap.xml',
    http_status: 200,
    redirect_chain: [],
    content_type: 'text/html',
    fetched_at: '2026-11-02T00:00:00.000Z',
    content_sha256: null,
    bytes: 0,
    html_purged: false,
    extraction: null,
    microdata_types: [],
    page_facts: null,
    errors: [],
  };
  await workDir.appendPageRecord(record);
  await workDir.savePage('home', Buffer.from('<html><body><p>Hello</p></body></html>'), {});
  const metaPath = path.join(workDir.pageDir('home'), 'meta.json');
  if (metaText === null) await fs.rm(metaPath);
  else await fs.writeFile(metaPath, metaText);
  return workDir;
}

async function extractedRecord(workDir: WorkDir): Promise<PageRecord | undefined> {
  await runExtraction({ workDir, emitByType: false });
  return (await workDir.readPageRecords())[0];
}

test('extraction lifts the recorded headers from meta.json onto the page record', async () => {
  const workDir = await siteWithMeta(
    JSON.stringify({ headers: { 'x-robots-tag': 'noindex', server: 'Apache' } }),
  );
  assert.deepEqual((await extractedRecord(workDir))?.response_headers, {
    'x-robots-tag': 'noindex',
  });
});

test('a missing meta.json leaves headers null without an error', async () => {
  const record = await extractedRecord(await siteWithMeta(null));
  assert.equal(record?.response_headers, null);
  assert.deepEqual(record?.errors, []);
});

test('a corrupt meta.json is recorded on the page, once, and does not stop extraction', async () => {
  const workDir = await siteWithMeta('{ not json');
  await runExtraction({ workDir, emitByType: false });
  const record = await extractedRecord(workDir);

  assert.equal(record?.response_headers, null);
  assert.equal(record?.page_facts?.title, null, 'the page was still extracted');
  const metaErrors = (record?.errors ?? []).filter((error) => error.startsWith('meta-json: '));
  assert.equal(
    metaErrors.length,
    1,
    `a re-extract must replace its error: ${metaErrors.join(' | ')}`,
  );
  assert.match(metaErrors[0] ?? '', /meta\.json/);
});
