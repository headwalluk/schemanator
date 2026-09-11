/**
 * What is in the work directory, and what it costs.
 *
 * A crawl is expensive in a way that is easy to forget once it has finished: it
 * took an hour of somebody else's bandwidth, politely, one request at a time.
 * So the work directory accumulates, and after a dozen sites nobody remembers
 * which are still wanted or which is the 400 MB one.
 *
 * This module answers both questions by reading the directory rather than by
 * keeping an index. There is no state to fall out of step, and a work directory
 * copied from another machine or half-deleted by hand still reports honestly.
 */

import fs from 'node:fs/promises';
import path from 'node:path';

import type { PageRecord } from './workdir.ts';

export interface SiteUsage {
  /** Every byte under the site directory. */
  total_bytes: number;
  /** Stored `page.html` only — the part worth reclaiming. */
  html_bytes: number;
  html_files: number;
  /** Files of every kind, for a sense of what a delete would touch. */
  files: number;
}

export interface SiteInventory {
  slug: string;
  /** From `crawl-summary.json`. Null if the crawl never completed. */
  origin: string | null;
  /** Lines in `pages.jsonl`. Null when there is no manifest at all. */
  pages: number | null;
  pages_ok: number | null;
  /** `fetched_at` of the most recently fetched page. */
  last_crawled: string | null;
  runs: number;
  latest_run: string | null;
  usage: SiteUsage;
  /** Set when the manifest says the HTML has been reclaimed. */
  html_purged: boolean;
  /** Anything that stopped this being read fully — a partial or foreign directory. */
  notes: string[];
}

async function directoryUsage(root: string): Promise<SiteUsage> {
  const usage: SiteUsage = { total_bytes: 0, html_bytes: 0, html_files: 0, files: 0 };

  const walk = async (dir: string): Promise<void> => {
    let entries: import('node:fs').Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
        continue;
      }
      if (!entry.isFile()) continue;

      let size: number;
      try {
        size = (await fs.stat(full)).size;
      } catch {
        continue;
      }
      usage.files += 1;
      usage.total_bytes += size;
      if (entry.name === 'page.html') {
        usage.html_files += 1;
        usage.html_bytes += size;
      }
    }
  };

  await walk(root);
  return usage;
}

async function readJson(file: string): Promise<Record<string, unknown> | null> {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * Read one site directory.
 *
 * Every field is optional in practice. A crawl killed halfway leaves a manifest
 * and no summary; a directory copied from elsewhere may have neither. Reporting
 * what is there and noting what is missing beats refusing to list it — the
 * whole point is to find the things you had forgotten about.
 */
export async function readSite(workRoot: string, slug: string): Promise<SiteInventory> {
  const root = path.join(workRoot, slug);
  const notes: string[] = [];

  const summary = await readJson(path.join(root, 'crawl-summary.json'));
  if (summary === null) notes.push('no crawl summary — the crawl may not have finished');

  let pages: number | null = null;
  let pagesOk: number | null = null;
  let lastCrawled: string | null = null;
  let htmlPurged = false;

  try {
    const manifest = await fs.readFile(path.join(root, 'pages.jsonl'), 'utf8');
    const records = manifest
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((line) => {
        try {
          return JSON.parse(line) as PageRecord;
        } catch {
          return null;
        }
      })
      .filter((record): record is PageRecord => record !== null);

    pages = records.length;
    pagesOk = records.filter((record) => record.http_status === 200).length;
    for (const record of records) {
      if (record.fetched_at !== '' && (lastCrawled === null || record.fetched_at > lastCrawled)) {
        lastCrawled = record.fetched_at;
      }
    }
    htmlPurged = records.length > 0 && records.every((record) => record.html_purged);
  } catch {
    notes.push('no page manifest — nothing has been crawled here');
  }

  let runs: string[] = [];
  try {
    runs = (await fs.readdir(path.join(root, 'reports'), { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch {
    // No reports directory just means nothing has been analysed yet.
  }

  return {
    slug,
    origin: typeof summary?.['site_origin'] === 'string' ? summary['site_origin'] : null,
    pages,
    pages_ok: pagesOk,
    last_crawled: lastCrawled,
    runs: runs.length,
    latest_run: runs[runs.length - 1] ?? null,
    usage: await directoryUsage(root),
    html_purged: htmlPurged,
    notes,
  };
}

/** Every site in the work directory, largest first. */
export async function listSites(workRoot: string): Promise<SiteInventory[]> {
  let entries: import('node:fs').Dirent[];
  try {
    entries = await fs.readdir(workRoot, { withFileTypes: true });
  } catch {
    return [];
  }

  const slugs = entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
    .map((entry) => entry.name)
    .sort();

  const sites = await Promise.all(slugs.map((slug) => readSite(workRoot, slug)));
  // Largest first: the question this answers is usually "what is eating my disk".
  return sites.sort((left, right) => right.usage.total_bytes - left.usage.total_bytes);
}

export type PurgeScope = 'html' | 'all' | 'orphans';

export interface PurgePlan {
  slug: string;
  root: string;
  /**
   * `html` reclaims stored pages; `all` removes the site entirely; `orphans`
   * removes page directories no manifest names.
   */
  scope: PurgeScope;
  files: number;
  bytes: number;
  /** True when there is nothing at this path to remove. */
  missing: boolean;
  /** `orphans` only: the directory names, sorted. Empty for every other scope. */
  orphans: readonly string[];
  /**
   * `orphans` only, and set when the manifest could not be read.
   *
   * The scope is defined against `pages.jsonl`, so without one there is no
   * truth to compare against — not an empty one. Treating a missing manifest as
   * "nothing is named" would make every stored page an orphan and delete the
   * whole crawl, which is the one outcome this scope must never produce.
   */
  unreadableManifest: boolean;
}

/**
 * Page directories `pages.jsonl` does not name.
 *
 * A fresh crawl deletes the manifest and writes a new one (`resetCrawlState`),
 * but nothing removes the directories the old manifest named, so a re-crawl
 * that drops or renames a page leaves its directory behind for good. The
 * manifest is truth (`01`), so a directory absent from it is unreachable by
 * every other part of the tool.
 *
 * A failed fetch is never an orphan: `appendPageRecord` runs for those too, so
 * the directory kept as evidence is named by the manifest that records the
 * failure.
 */
async function findOrphans(
  root: string,
): Promise<{ orphans: string[]; unreadableManifest: boolean }> {
  let named: Set<string>;
  try {
    const manifest = await fs.readFile(path.join(root, 'pages.jsonl'), 'utf8');
    named = new Set(
      manifest
        .split('\n')
        .filter((line) => line.trim() !== '')
        .map((line) => (JSON.parse(line) as PageRecord).page_id),
    );
  } catch {
    return { orphans: [], unreadableManifest: true };
  }

  let entries: import('node:fs').Dirent[];
  try {
    entries = await fs.readdir(path.join(root, 'pages'), { withFileTypes: true });
  } catch {
    // No pages directory at all. Nothing stored, so nothing orphaned.
    return { orphans: [], unreadableManifest: false };
  }

  return {
    orphans: entries
      .filter((entry) => entry.isDirectory() && !named.has(entry.name))
      .map((entry) => entry.name)
      .sort(),
    unreadableManifest: false,
  };
}

export async function planPurge(
  workRoot: string,
  slug: string,
  scope: PurgeScope,
): Promise<PurgePlan> {
  const root = path.join(workRoot, slug);
  let missing = false;
  try {
    await fs.stat(root);
  } catch {
    missing = true;
  }

  if (scope === 'orphans') {
    const { orphans, unreadableManifest } = await findOrphans(root);
    let files = 0;
    let bytes = 0;
    for (const orphan of orphans) {
      const usage = await directoryUsage(path.join(root, 'pages', orphan));
      files += usage.files;
      bytes += usage.total_bytes;
    }
    return { slug, root, scope, files, bytes, missing, orphans, unreadableManifest };
  }

  const usage = await directoryUsage(root);
  return {
    slug,
    root,
    scope,
    files: scope === 'all' ? usage.files : usage.html_files,
    bytes: scope === 'all' ? usage.total_bytes : usage.html_bytes,
    missing,
    orphans: [],
    unreadableManifest: false,
  };
}

/**
 * Carry out a plan.
 *
 * The `html` scope also rewrites the manifest to set `html_purged`. Deleting the
 * files with `find` works and leaves `pages.jsonl` insisting the HTML is still
 * there — a flag that lies is worse than one that does not exist, and this is
 * the command that can keep it honest.
 */
export async function applyPurge(plan: PurgePlan): Promise<void> {
  if (plan.missing) return;

  if (plan.scope === 'all') {
    await fs.rm(plan.root, { recursive: true, force: true });
    return;
  }

  if (plan.scope === 'orphans') {
    // The plan's list, never a fresh scan: what the operator was shown and
    // approved is what gets removed, even if a crawl has run since.
    if (plan.unreadableManifest) return;
    for (const orphan of plan.orphans) {
      await fs.rm(path.join(plan.root, 'pages', orphan), { recursive: true, force: true });
    }
    return;
  }

  const pagesDir = path.join(plan.root, 'pages');
  let entries: import('node:fs').Dirent[];
  try {
    entries = await fs.readdir(pagesDir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    await fs.rm(path.join(pagesDir, entry.name, 'page.html'), { force: true });
  }

  const manifestPath = path.join(plan.root, 'pages.jsonl');
  try {
    const manifest = await fs.readFile(manifestPath, 'utf8');
    const rewritten = manifest
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((line) => {
        try {
          const record = JSON.parse(line) as PageRecord;
          return JSON.stringify({ ...record, html_purged: true });
        } catch {
          return line;
        }
      })
      .join('\n');
    await fs.writeFile(manifestPath, `${rewritten}\n`, 'utf8');
  } catch {
    // No manifest to update. The files are still gone, which is what was asked.
  }
}

/** Human sizes. `du -h` conventions, because that is what people compare against. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}
