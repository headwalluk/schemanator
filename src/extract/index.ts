/**
 * Extraction: one page of HTML into `raw/*` plus canonical nodes.
 *
 * ```
 * extract(html, pageUrl, pageId) → ExtractionResult
 * ```
 *
 * **Takes HTML, not a URL** (`03`). That is what lets a later headless-render
 * fetcher drop in without touching this code, and what lets the fixture corpus
 * drive extraction directly with no network at all.
 */

import jsonld from 'jsonld';

import { staticDocumentLoader, UnresolvableContextError } from './context.ts';
import { flattenExpanded } from './flatten.ts';
import { detectOtherSyntaxes, findDeclaredCanonical, findLdJsonBlocks } from './html.ts';
import type { ExtractedNode, ExtractionResult, RawBlock } from './types.ts';

/**
 * Collect every `@id` the author actually wrote, mapped to what it resolves to.
 *
 * Amendment C. Expansion resolves `"@id": "#organization"` against the page
 * URL, so 200 pages produce 200 distinct entities — spec-correct, and from a
 * consumer's point of view a genuine identity fracture, but reported as 200
 * findings the tool is unusable. Keeping the raw string lets
 * `graph.relative-id` raise **one** finding covering all 200 pages.
 *
 * Done by walking the original document rather than by instrumenting
 * expansion, because `03` forbids hand-rolling the expansion algorithm.
 */
function collectRawIds(value: unknown, base: string, into: Map<string, string>): void {
  if (Array.isArray(value)) {
    for (const item of value) collectRawIds(item, base, into);
    return;
  }
  if (value === null || typeof value !== 'object') return;

  const node = value as Record<string, unknown>;
  const id = node['@id'];
  if (typeof id === 'string' && !id.startsWith('_:')) {
    try {
      const resolved = new URL(id, base).toString();
      if (resolved !== id) into.set(resolved, id);
    } catch {
      // Unresolvable @id. Left for a check to report rather than fixed here.
    }
  }

  for (const child of Object.values(node)) {
    if (child !== null && typeof child === 'object') collectRawIds(child, base, into);
  }
}

/**
 * Find our own error inside whatever `jsonld.js` wrapped it in.
 *
 * A rejected document loader surfaces as a `JsonLdError` whose message blames
 * CORS, redirects and same-origin policy — none of which happened. It carries
 * the real cause in `details.cause`, so dig it out rather than reporting the
 * library's guess at what went wrong.
 */
function unwrapCause(error: unknown, depth = 0): unknown {
  if (depth > 5 || error === null || typeof error !== 'object') return error;
  if (error instanceof UnresolvableContextError) return error;

  const details = (error as { details?: { cause?: unknown } }).details;
  if (details?.cause !== undefined) return unwrapCause(details.cause, depth + 1);

  const cause = (error as { cause?: unknown }).cause;
  if (cause !== undefined) return unwrapCause(cause, depth + 1);

  return error;
}

/** Name the likely cause. `03`: trailing commas are common enough to call out. */
function describeJsonError(error: unknown, text: string): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/,\s*[}\]]/.test(text)) {
    return `${message} — a trailing comma before a closing brace or bracket is the likely cause`;
  }
  if (/^\s*</.test(text)) {
    return `${message} — the block starts with "<", so this may be HTML rather than JSON`;
  }
  return message;
}

export async function extract(html: string, pageUrl: string, pageId: string): Promise<ExtractionResult> {
  const blocks: RawBlock[] = [];
  const nodes: ExtractedNode[] = [];
  const errors: string[] = [];
  let failed = 0;

  const found = findLdJsonBlocks(html);

  for (const block of found) {
    const record: RawBlock = { index: block.index, text: block.raw, error: null };
    blocks.push(record);

    let parsed: unknown;
    try {
      parsed = JSON.parse(block.cleaned);
    } catch (error) {
      // A malformed block must not abort the page (`03`). Record it, extract
      // everything else, carry on.
      record.error = describeJsonError(error, block.cleaned);
      failed += 1;
      continue;
    }

    const rawIds = new Map<string, string>();
    collectRawIds(parsed, pageUrl, rawIds);

    let expanded: unknown[];
    try {
      expanded = (await jsonld.expand(parsed as jsonld.JsonLdDocument, {
        // Spec-correct: relative `@id`s resolve against the page. See the
        // base-IRI discussion in `00` — we resolve, and keep the raw string
        // alongside so one finding can cover N pages.
        base: pageUrl,
        documentLoader: staticDocumentLoader as never,
      })) as unknown[];
    } catch (error) {
      const cause = unwrapCause(error);
      record.error =
        cause instanceof UnresolvableContextError
          ? cause.message
          : `expansion failed: ${error instanceof Error ? error.message : String(error)}`;
      failed += 1;
      continue;
    }

    nodes.push(
      ...flattenExpanded(expanded, {
        pageId,
        syntax: 'json-ld',
        block: block.index,
        rawIds,
      }),
    );
  }

  // Presence is recorded rather than raised as a page-level error. Microdata
  // alongside JSON-LD is the normal state of a WooCommerce site, and flagging
  // it per page would emit 242 findings across the corpus that say only "we did
  // not look" — the drowning `04` exists to prevent. What the syntaxes contain
  // is a site-level question, answered once by a check.
  const other = detectOtherSyntaxes(html);

  return {
    page_id: pageId,
    page_url: pageUrl,
    declared_canonical: findDeclaredCanonical(html, pageUrl),
    blocks,
    nodes,
    errors,
    microdata_types: other.microdataTypes,
    counts: {
      json_ld_blocks: blocks.length,
      json_ld_failed: failed,
      microdata_items: other.microdata,
      rdfa_items: other.rdfa,
      nodes: nodes.length,
    },
  };
}

export type { ExtractedNode, ExtractionResult, RawBlock } from './types.ts';
