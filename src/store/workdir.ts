/**
 * The work directory — the filesystem *is* the database for Phase 0.
 *
 * Layout and rationale are in `dev-notes/01-work-directory-layout.md`. The rule
 * that governs everything here:
 *
 *   **Directory names are a human affordance. The manifest is truth.**
 *
 * Nothing in this tool ever parses a directory name to recover a URL. The slug
 * exists so you can `ls` and see what is what; `pages.jsonl` is what the code
 * reads.
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import type { PageFacts } from '../extract/page-facts.ts';

import type { FetchRecord } from '../net/fetcher.ts';

/** Slug component length cap. Filesystems allow 255 bytes; 80 keeps `ls` readable. */
const MAX_SLUG_LENGTH = 80;

/**
 * Derive a stable page id: `<slug>-<hash8>`.
 *
 * The slug is lossy on purpose — truncated, case-folded, punctuation collapsed.
 * The hash is taken over the **full canonical URL**, so query strings, unicode
 * and deep paths that all slugify identically still get distinct directories.
 */
export function pageIdFor(canonicalUrl: string): string {
  const hash8 = createHash('sha256').update(canonicalUrl).digest('hex').slice(0, 8);

  let slug: string;
  try {
    slug = new URL(canonicalUrl).pathname;
  } catch {
    slug = canonicalUrl;
  }

  slug = slug
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_SLUG_LENGTH)
    .replace(/-+$/g, '');

  return `${slug === '' ? '_root' : slug}-${hash8}`;
}

/** Default site key: the hostname, made filesystem-safe. */
export function siteSlugFor(origin: string): string {
  return new URL(origin).host.replace(/[^a-zA-Z0-9.-]+/g, '_');
}

export function sha256(body: Buffer): string {
  return createHash('sha256').update(body).digest('hex');
}

/** One line of `pages.jsonl` — the index. Shape per `dev-notes/01`. */
/**
 * Another URL whose fetch resolved to this page.
 *
 * A sitemap that lists both `/shop/` and `/website-hosting-and-email/`, where
 * the first 301s to the second, describes **one page**. Before 1.12.0 the crawl
 * stored two: the destination's HTML was written twice, once under each
 * requested URL, so its markup was extracted twice, every `@id` on it appeared
 * under two `page_id`s, and every finding about it was billed to two pages. On a
 * real site that turned 5 products into 9 (`dev-notes/10`, finding 9).
 *
 * The request is kept rather than discarded, because it is not noise: which URL
 * was asked for, which sitemap asked for it, and what the server said are
 * exactly what `indexing.sitemap-redirects` reports. Losing them to fix the
 * arithmetic would have traded one wrong number for one missing finding.
 */
export interface PageAlias {
  /** The URL that was requested. */
  url: string;
  /** Why it was crawled — `sitemap:<url>`, as on a page record. */
  source: string;
  http_status: number | null;
  redirect_chain: { url: string; status: number; location: string }[];
  fetched_at: string;
}

export interface PageRecord {
  /**
   * Derived from `canonical_url` — **the URL the fetch resolved to**, not the
   * one that was requested. Two requests landing on one page therefore produce
   * one record, whichever order they arrive in, with the losers in `aliases`.
   */
  page_id: string;
  url: string;
  canonical_url: string;
  /** The page's own `<link rel=canonical>`. Filled by extraction, not the crawl. */
  declared_canonical: string | null;
  source: string;
  http_status: number | null;
  redirect_chain: { url: string; status: number; location: string }[];
  content_type: string | null;
  fetched_at: string;
  content_sha256: string | null;
  bytes: number;
  html_purged: boolean;
  /**
   * Other URLs whose fetch landed here. Absent when nothing redirected to it,
   * which is the overwhelming majority of pages.
   */
  aliases?: PageAlias[];
  /** Null until extraction has run (`dev-notes/03`). */
  extraction: null | Record<string, number>;
  /**
   * `itemtype` values seen on the page, read from attributes rather than parsed.
   *
   * Separate from `extraction` because that map is counts only, and this is the
   * one piece of extraction output that is not a number. Kept because
   * `coverage.competing-syntax` has to name the types it found on **this** site:
   * without it the finding could only cite types measured on other sites, and a
   * downstream agent will repeat those as though they were observed here.
   *
   * Empty on records written before this field existed. Re-running `analyse`
   * fills it in, since that re-runs extraction over the stored HTML.
   */
  microdata_types: string[];
  /**
   * Per-page facts extraction records so checks never touch HTML (`04`).
   *
   * Null on a crawl older than the field. Re-running `analyse` fills it in,
   * since that re-extracts from stored HTML — **unless `purge --html` has run**,
   * in which case only a re-crawl can. Findings depending on these must say so
   * rather than reporting a false absence, the way `coverage.competing-syntax`
   * already does.
   *
   * Scalars and tiny arrays only. Heading *levels* rather than heading text,
   * because no check needs the words and storing them would roughly double the
   * manifest — which `sites` reads whole. Links live in `graph/links.jsonl`
   * for the same reason, at a far larger scale (`07`).
   */
  page_facts: PageFacts | null;
  errors: string[];
}

export class WorkDir {
  readonly root: string;
  readonly siteSlug: string;

  constructor(workRoot: string, siteSlug: string) {
    this.siteSlug = siteSlug;
    this.root = path.resolve(workRoot, siteSlug);
  }

  get crawlDir(): string {
    return path.join(this.root, 'crawl');
  }

  get sitemapsDir(): string {
    return path.join(this.crawlDir, 'sitemaps');
  }

  get pagesDir(): string {
    return path.join(this.root, 'pages');
  }

  get pagesManifest(): string {
    return path.join(this.root, 'pages.jsonl');
  }

  get frontierPath(): string {
    return path.join(this.crawlDir, 'frontier.jsonl');
  }

  get crawlLogPath(): string {
    return path.join(this.crawlDir, 'crawl.log');
  }

  /** One row per link. Separate from the manifest: a 500-page site has ~190,000. */
  get linksPath(): string {
    return path.join(this.root, 'graph', 'links.jsonl');
  }

  /**
   * The de-boilerplated page, as markdown.
   *
   * Beside `page.html` and **deliberately not removed by `purge --html`**. It is
   * 5-15% of the size, and keeping it means the operator and their agent still
   * have the page's readable content after the biggest disk-reclaiming action.
   */
  contentPath(pageId: string): string {
    return path.join(this.pageDir(pageId), 'content.md');
  }

  pageDir(pageId: string): string {
    return path.join(this.pagesDir, pageId);
  }

  async init(): Promise<void> {
    await fs.mkdir(this.sitemapsDir, { recursive: true });
    await fs.mkdir(this.pagesDir, { recursive: true });
  }

  /** Wipe crawl state so a fresh run does not inherit a stale frontier or manifest. */
  async resetCrawlState(): Promise<void> {
    await fs.rm(this.frontierPath, { force: true });
    await fs.rm(this.pagesManifest, { force: true });
    await fs.rm(this.crawlLogPath, { force: true });
  }

  async writeCrawlFile(name: string, content: string | Buffer): Promise<void> {
    await fs.writeFile(path.join(this.crawlDir, name), content);
  }

  /** Sitemaps are stored index-recursion-flattened, numbered in fetch order. */
  async writeSitemap(index: number, content: Buffer): Promise<string> {
    const name = `sitemap-${String(index).padStart(2, '0')}.xml`;
    await fs.writeFile(path.join(this.sitemapsDir, name), content);
    return name;
  }

  async savePage(pageId: string, html: Buffer, meta: Record<string, unknown>): Promise<void> {
    const dir = this.pageDir(pageId);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'page.html'), html);
    await fs.writeFile(path.join(dir, 'meta.json'), `${JSON.stringify(meta, null, 2)}\n`);
  }

  /** A page we could not store — still gets a directory, so the failure is inspectable. */
  async saveFailedPage(pageId: string, meta: Record<string, unknown>): Promise<void> {
    const dir = this.pageDir(pageId);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'meta.json'), `${JSON.stringify(meta, null, 2)}\n`);
  }

  async appendPageRecord(record: PageRecord): Promise<void> {
    await fs.appendFile(this.pagesManifest, `${JSON.stringify(record)}\n`);
  }

  /** One line per request: URL, status, bytes, ms. */
  async appendCrawlLog(record: FetchRecord): Promise<void> {
    const status = record.status ?? (record.error ? record.error.kind : 'none');
    const line = `${new Date().toISOString()} ${status} ${record.bytes} ${record.elapsedMs}ms ${record.requestedUrl}\n`;
    await fs.appendFile(this.crawlLogPath, line);
  }

  // --- extraction artefacts (dev-notes/01, three layers) -------------------

  get graphDir(): string {
    return path.join(this.root, 'graph');
  }

  get graphNodesPath(): string {
    return path.join(this.graphDir, 'nodes.jsonl');
  }

  reportsDir(runId: string): string {
    return path.join(this.root, 'reports', runId);
  }

  /** Layer 1, verbatim: the audit trail. Written even when the block is malformed. */
  async writeRawBlocks(pageId: string, blocks: { index: number; text: string }[]): Promise<void> {
    if (blocks.length === 0) return;
    const dir = path.join(this.pageDir(pageId), 'raw');
    await fs.mkdir(dir, { recursive: true });
    await Promise.all(
      blocks.map((block) =>
        fs.writeFile(path.join(dir, `ld-${String(block.index).padStart(2, '0')}.json`), block.text),
      ),
    );
  }

  /** Layer 2, canonical: the only thing checks read. */
  async writePageNodes(pageId: string, nodes: unknown[]): Promise<void> {
    const body = nodes.map((node) => JSON.stringify(node)).join('\n');
    await fs.writeFile(
      path.join(this.pageDir(pageId), 'nodes.jsonl'),
      body === '' ? '' : `${body}\n`,
    );
  }

  async appendGraphNodes(nodes: unknown[]): Promise<void> {
    if (nodes.length === 0) return;
    await fs.mkdir(this.graphDir, { recursive: true });
    await fs.appendFile(
      this.graphNodesPath,
      `${nodes.map((node) => JSON.stringify(node)).join('\n')}\n`,
    );
  }

  /**
   * Layer 3, convenience: derived, disposable, for eyeballing during Phase 0.
   * Never an input to any check.
   */
  async writeByType(pageId: string, nodes: { types: string[] }[]): Promise<void> {
    if (nodes.length === 0) return;
    const dir = path.join(this.pageDir(pageId), 'by-type');
    await fs.mkdir(dir, { recursive: true });

    const counters = new Map<string, number>();
    await Promise.all(
      nodes.map((node) => {
        const type = (node.types[0] ?? 'untyped').split('/').pop() ?? 'untyped';
        const slug = type.toLowerCase().replace(/[^a-z0-9]+/g, '-');
        const index = counters.get(slug) ?? 0;
        counters.set(slug, index + 1);
        return fs.writeFile(
          path.join(dir, `${slug}-${String(index).padStart(2, '0')}.json`),
          `${JSON.stringify(node, null, 2)}\n`,
        );
      }),
    );
  }

  /** One JSON object per link, appended as extraction's second pass runs. */
  async appendLinks(
    pageId: string,
    links: readonly {
      to: string;
      anchor: string;
      internal: boolean;
      rel: string | null;
      in_chrome: boolean;
    }[],
  ): Promise<void> {
    if (links.length === 0) return;
    await fs.mkdir(path.dirname(this.linksPath), { recursive: true });
    const lines = links.map((link) => JSON.stringify({ from: pageId, ...link })).join('\n');
    await fs.appendFile(this.linksPath, `${lines}\n`, 'utf8');
  }

  /** Clear the link graph before a re-extract, for `resetExtraction`'s reason. */
  async resetLinks(): Promise<void> {
    await fs.rm(this.linksPath, { force: true });
  }

  /** The de-boilerplated page. Survives `purge --html` deliberately. */
  async writeContentMarkdown(pageId: string, markdown: string): Promise<void> {
    await fs.mkdir(this.pageDir(pageId), { recursive: true });
    await fs.writeFile(this.contentPath(pageId), markdown, 'utf8');
  }

  /** Wipe derived artefacts so a re-extract cannot accumulate stale nodes. */
  async resetExtraction(): Promise<void> {
    await fs.rm(this.graphNodesPath, { force: true });
    let pages: string[];
    try {
      pages = await fs.readdir(this.pagesDir);
    } catch {
      return;
    }
    await Promise.all(
      pages.flatMap((pageId) => [
        fs.rm(path.join(this.pageDir(pageId), 'raw'), { recursive: true, force: true }),
        fs.rm(path.join(this.pageDir(pageId), 'by-type'), { recursive: true, force: true }),
        fs.rm(path.join(this.pageDir(pageId), 'nodes.jsonl'), { force: true }),
      ]),
    );
  }

  async readPageRecords(): Promise<PageRecord[]> {
    const raw = await fs.readFile(this.pagesManifest, 'utf8');
    return raw
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((line) => JSON.parse(line) as PageRecord);
  }

  /** Rewrite the manifest in place, once extraction has filled in its fields. */
  async rewritePageRecords(records: PageRecord[]): Promise<void> {
    await fs.writeFile(
      this.pagesManifest,
      records.map((record) => `${JSON.stringify(record)}\n`).join(''),
    );
  }

  async readPageHtml(pageId: string): Promise<string | null> {
    try {
      return await fs.readFile(path.join(this.pageDir(pageId), 'page.html'), 'utf8');
    } catch {
      return null;
    }
  }

  /** Run ids present on disk, oldest first. Ids are timestamps, so they sort. */
  async listRuns(): Promise<string[]> {
    try {
      const entries = await fs.readdir(path.join(this.root, 'reports'), { withFileTypes: true });
      return entries
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort();
    } catch {
      return [];
    }
  }

  async readReport(runId: string): Promise<unknown> {
    try {
      return JSON.parse(
        await fs.readFile(path.join(this.reportsDir(runId), 'report.json'), 'utf8'),
      ) as unknown;
    } catch {
      return null;
    }
  }

  async writeReport(runId: string, name: string, content: string): Promise<string> {
    const dir = this.reportsDir(runId);
    await fs.mkdir(dir, { recursive: true });
    const target = path.join(dir, name);
    await fs.writeFile(target, content);
    return target;
  }

  async writeRunSummary(summary: Record<string, unknown>): Promise<string> {
    const target = path.join(this.root, 'crawl-summary.json');
    await fs.writeFile(target, `${JSON.stringify(summary, null, 2)}\n`);
    return target;
  }
}
