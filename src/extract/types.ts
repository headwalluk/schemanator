/**
 * The canonical node shape — `dev-notes/01` and `03`.
 *
 * One JSON object per line in `nodes.jsonl`. **This is the only thing checks
 * read.** Everything a check needs must be here, because `04` forbids checks
 * from touching HTML or re-parsing anything.
 */

export type Syntax = 'json-ld' | 'microdata' | 'rdfa';

export interface NodeSource {
  syntax: Syntax;
  /** Index of the emitting `<script>` block, in document order. */
  block: number;
  /**
   * JSON pointer into the **expanded** document for this block.
   *
   * Not into the original. `jsonld.expand` restructures — arrays everywhere,
   * IRIs, `@graph` hoisted — and gives no mapping back, and `03` forbids
   * hand-rolling expansion to obtain one. The verbatim original is on disk in
   * `raw/ld-NN.json`, so a report can show both: this pointer says precisely
   * which node we mean, and the raw block shows what the author wrote.
   */
  pointer: string;
}

export interface ExtractedNode {
  /** Resolved IRI, or a stable blank-node id. Group by this. */
  node_id: string;
  /**
   * The `@id` exactly as written, when it differed from the resolved form.
   *
   * Amendment C in `dev-notes/00`. Plugins emit `"@id": "#organization"`, which
   * resolves against the page URL and so fractures into N entities across N
   * pages. Grouping uses `node_id`; this field is what lets one finding cover
   * all N pages instead of raising N findings.
   */
  raw_id: string | null;
  is_blank: boolean;
  page_id: string;
  /** Full IRIs. Short names only at display time. */
  types: string[];
  /** Full IRIs to arrays of values. Arrays even for singletons. */
  props: Record<string, unknown[]>;
  /** Mandatory. No exceptions (`01`). */
  source: NodeSource;
}

/** A `<script type="application/ld+json">` block, captured before parsing. */
export interface RawBlock {
  index: number;
  /** Exactly as it appeared, including if malformed. */
  text: string;
  /** Set when the block could not be parsed or expanded. */
  error: string | null;
}

export interface ExtractionResult {
  page_id: string;
  page_url: string;
  /** The page's own `<link rel=canonical>`, resolved. Null when absent. */
  declared_canonical: string | null;
  blocks: RawBlock[];
  nodes: ExtractedNode[];
  /** Page-level faults that only extraction can see (`03`). */
  errors: string[];
  /**
   * `itemtype` values found on the page. Read from attributes, not parsed —
   * enough to compare syntaxes at the type level without solving the microdata
   * provenance problem. See `detectOtherSyntaxes`.
   */
  microdata_types: string[];
  counts: {
    json_ld_blocks: number;
    json_ld_failed: number;
    microdata_items: number;
    rdfa_items: number;
    nodes: number;
  };
}
