/**
 * Extraction over a stored crawl: each page's stored `page.html` becomes the
 * three layers of `dev-notes/01`.
 *
 * Reads only what the crawl stored. No network, so a crawl can be extracted
 * repeatedly — after a rule change, after a bug fix — without touching the
 * site again. That property is why `02` stores the HTML at all.
 */

import { SILENT_LOGGER, type Logger } from '../log.ts';
import {
  CHROME_SHARE,
  extractBlocks,
  extractLinks,
  extractPageFacts,
  isChrome,
  isChromeCandidate,
  loadDom,
  renderMarkdown,
  simhash,
  type PageLink,
  type TextBlock,
} from './page-facts.ts';
import type { WorkDir } from '../store/workdir.ts';
import { extract } from './index.ts';
import type { ExtractedNode } from './types.ts';

export interface ExtractionRunSummary {
  pages_extracted: number;
  pages_skipped: number;
  json_ld_blocks: number;
  json_ld_failed: number;
  nodes: number;
  pages_with_microdata: number;
  declared_canonicals: number;
  /** Outbound links recorded to `graph/links.jsonl`. */
  links: number;
  /** Distinct text blocks judged to be site furniture. */
  chrome_blocks: number;
  started_at: string;
  finished_at: string;
}

export interface ExtractionRunOptions {
  workDir: WorkDir;
  logger?: Logger;
  /** Emit the disposable `by-type/` browsing view (`01` layer 3). */
  emitByType?: boolean;
}

/**
 * Below this, "appears on 80% of pages" is one or two pages and means nothing.
 * The threshold is not applied at all rather than applied badly.
 */
const MIN_PAGES_FOR_CHROME = 5;

export async function runExtraction(options: ExtractionRunOptions): Promise<ExtractionRunSummary> {
  const { workDir, logger = SILENT_LOGGER, emitByType = true } = options;

  const startedAt = new Date().toISOString();
  const records = await workDir.readPageRecords();

  // A re-extract must not accumulate on top of the last one — stale nodes in
  // `graph/nodes.jsonl` would be indistinguishable from real ones.
  await workDir.resetExtraction();

  const summary: ExtractionRunSummary = {
    pages_extracted: 0,
    pages_skipped: 0,
    json_ld_blocks: 0,
    json_ld_failed: 0,
    nodes: 0,
    pages_with_microdata: 0,
    declared_canonicals: 0,
    links: 0,
    chrome_blocks: 0,
    started_at: startedAt,
    finished_at: startedAt,
  };

  logger.info(`Extracting ${records.length} stored page(s) …`);

  /**
   * Held for the second pass, because chrome cannot be known from one page.
   *
   * A 500-page site is roughly 10 MB of block text and 190,000 links — large,
   * but bounded by `--max-pages` and far cheaper than parsing every page twice.
   */
  const perPage = new Map<string, { blocks: TextBlock[]; links: PageLink[] }>();

  let siteHost = '';
  for (const record of records) {
    try {
      siteHost = new URL(record.canonical_url).host;
      break;
    } catch {
      continue;
    }
  }

  for (const record of records) {
    const html = await workDir.readPageHtml(record.page_id);
    if (html === null) {
      // Expected for a 404 or a rejected content-type: the crawl kept the
      // meta.json but never had a body.
      summary.pages_skipped += 1;
      record.extraction = null;
      continue;
    }

    // The page's identity is the URL it was served at, and relative `@id`s
    // resolve against it.
    const result = await extract(html, record.canonical_url, record.page_id);

    await workDir.writeRawBlocks(record.page_id, result.blocks);
    await workDir.writePageNodes(record.page_id, result.nodes);
    await workDir.appendGraphNodes(result.nodes);
    if (emitByType) await workDir.writeByType(record.page_id, result.nodes);

    record.declared_canonical = result.declared_canonical;
    record.extraction = {
      json_ld_blocks: result.counts.json_ld_blocks,
      json_ld_failed: result.counts.json_ld_failed,
      microdata_items: result.counts.microdata_items,
      rdfa_items: result.counts.rdfa_items,
      nodes: result.counts.nodes,
    };
    // Sorted and de-duplicated: one page emitting `WPHeader` six times says the
    // same thing as emitting it once, and the manifest is read by humans.
    record.microdata_types = [...new Set(result.microdata_types)].sort();

    // One more pass over the DOM this page already needs. `04`'s rule holds:
    // extraction records facts, and no check ever sees the HTML.
    const dom = loadDom(html);
    const blocks = extractBlocks(dom);
    perPage.set(record.page_id, {
      blocks,
      links: extractLinks(dom, record.canonical_url, siteHost),
    });
    record.page_facts = extractPageFacts(dom, blocks);
    // Structural faults only extraction can see belong on the page record
    // (`03`), but must not clobber the crawl's own errors.
    const blockErrors = result.blocks
      .filter((block) => block.error !== null)
      .map((block) => `ld-block-${block.index}: ${block.error ?? ''}`);
    record.errors = [
      ...record.errors.filter((error) => !error.startsWith('ld-block-')),
      ...blockErrors,
    ];

    summary.pages_extracted += 1;
    summary.json_ld_blocks += result.counts.json_ld_blocks;
    summary.json_ld_failed += result.counts.json_ld_failed;
    summary.nodes += result.counts.nodes;
    if (result.counts.microdata_items > 0) summary.pages_with_microdata += 1;
    if (result.declared_canonical !== null) summary.declared_canonicals += 1;

    if (summary.pages_extracted % 50 === 0) {
      logger.debug(`  ${summary.pages_extracted}/${records.length} …`);
    }
  }

  /**
   * Second pass: decide what is chrome, then finish the facts that depend on it.
   *
   * A block of text on ≥80% of pages is site furniture — measured rather than
   * guessed, which is the whole reason this beats a per-page heuristic library
   * (`07`). Below a handful of pages the frequency count means nothing, so the
   * threshold is not applied and every block counts as content.
   */
  const pageCount = perPage.size;
  const blockPages = new Map<string, number>();
  for (const { blocks } of perPage.values()) {
    for (const hash of new Set(
      blocks
        .filter((block) => isChromeCandidate(block) && !block.structural_chrome)
        .map((b) => b.hash),
    )) {
      blockPages.set(hash, (blockPages.get(hash) ?? 0) + 1);
    }
  }

  const chrome = new Set<string>();
  if (pageCount >= MIN_PAGES_FOR_CHROME) {
    for (const [hash, count] of blockPages) {
      if (count >= pageCount * CHROME_SHARE) chrome.add(hash);
    }
  }
  summary.chrome_blocks = chrome.size;

  /**
   * Navigation links are decided by **target frequency**, not by the block that
   * encloses them.
   *
   * The first version used the enclosing text block and caught almost nothing:
   * a nav link lives in `<li><a>Contact</a></li>`, whose text is one word and
   * never registers as a block at all. It marked 9% of one site's edges as
   * chrome when 88% of them pointed at targets present on every page — the
   * homepage and the basket among them.
   *
   * A target appearing on ≥80% of pages *is* navigation, and that is the same
   * frequency argument the block detection uses, applied to the thing actually
   * being counted. The block signal is kept as a second route, for a
   * contextual link that happens to sit inside boilerplate prose.
   */
  const targetPages = new Map<string, number>();
  for (const { links } of perPage.values()) {
    for (const target of new Set(links.map((link) => link.to))) {
      targetPages.set(target, (targetPages.get(target) ?? 0) + 1);
    }
  }

  const chromeTargets = new Set<string>();
  if (pageCount >= MIN_PAGES_FOR_CHROME) {
    for (const [target, count] of targetPages) {
      if (count >= pageCount * CHROME_SHARE) chromeTargets.add(target);
    }
  }

  await workDir.resetLinks();

  for (const record of records) {
    const held = perPage.get(record.page_id);
    if (held === undefined || record.page_facts === null) continue;

    const notChrome = held.blocks.filter((block) => !isChrome(block, chrome));
    const content = notChrome.filter((block) => !block.hidden);
    record.page_facts.text.extractable_words = content.reduce((sum, block) => sum + block.words, 0);

    /**
     * Hidden *content*, not hidden anything.
     *
     * Computed here rather than in the first pass because chrome is not known
     * until now, and the distinction is the whole check. A mobile menu marked
     * `aria-hidden` and a sticky top bar are hidden navigation — normal, on
     * every page, and nothing to report. Counting them made
     * `content.hidden-text` fire on 91 corpus pages, none of which were
     * concealing anything.
     */
    record.page_facts.text.hidden_words = notChrome
      .filter((block) => block.hidden)
      .reduce((sum, block) => sum + block.words, 0);
    record.page_facts.content_simhash = simhash(content.map((block) => block.text).join(' '));

    await workDir.writeContentMarkdown(
      record.page_id,
      renderMarkdown(held.blocks, chrome, record.page_facts.title),
    );
    await workDir.appendLinks(
      record.page_id,
      held.links.map((link) => ({
        ...link,
        in_chrome: chromeTargets.has(link.to) || (link.block !== null && chrome.has(link.block)),
      })),
    );
    summary.links += held.links.length;
  }

  await workDir.rewritePageRecords(records);

  summary.finished_at = new Date().toISOString();
  if (summary.links > 0) {
    logger.info(
      `  ${summary.links} link(s), ${summary.chrome_blocks} block(s) identified as site chrome`,
    );
  }
  logger.info(
    `  ${summary.nodes} node(s) from ${summary.json_ld_blocks} JSON-LD block(s)` +
      (summary.json_ld_failed > 0 ? `, ${summary.json_ld_failed} malformed` : ''),
  );

  return summary;
}

/** Read the whole graph back. Checks operate on this and nothing else (`04`). */
export async function readGraph(workDir: WorkDir): Promise<ExtractedNode[]> {
  const fs = await import('node:fs/promises');
  let raw: string;
  try {
    raw = await fs.readFile(workDir.graphNodesPath, 'utf8');
  } catch {
    return [];
  }
  return raw
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as ExtractedNode);
}
