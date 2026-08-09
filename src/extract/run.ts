/**
 * Extraction over a stored crawl: each page's stored `page.html` becomes the
 * three layers of `dev-notes/01`.
 *
 * Reads only what the crawl stored. No network, so a crawl can be extracted
 * repeatedly — after a rule change, after a bug fix — without touching the
 * site again. That property is why `02` stores the HTML at all.
 */

import { SILENT_LOGGER, type Logger } from '../log.ts';
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
  started_at: string;
  finished_at: string;
}

export interface ExtractionRunOptions {
  workDir: WorkDir;
  logger?: Logger;
  /** Emit the disposable `by-type/` browsing view (`01` layer 3). */
  emitByType?: boolean;
}

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
    started_at: startedAt,
    finished_at: startedAt,
  };

  logger.info(`Extracting ${records.length} stored page(s) …`);

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

  await workDir.rewritePageRecords(records);

  summary.finished_at = new Date().toISOString();
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
