/**
 * Pulling structured data out of HTML, before any JSON is parsed.
 *
 * `03` step 1: capture every `<script type="application/ld+json">` payload
 * verbatim, in document order, **including if it is malformed**. Malformed
 * JSON-LD is itself a finding, and every report needs to quote exact source
 * back at the operator.
 */

import * as cheerio from 'cheerio';

/** Leading BOM and whitespace before the JSON are endemic. */
function stripLeading(text: string): string {
  return text.replace(/^\uFEFF/, '').trim();
}

/**
 * Unwrap the CDATA and comment guards that older templates put inside
 * `<script>`. Both appear in the wild and both make otherwise valid JSON
 * unparseable.
 */
function unwrapGuards(text: string): string {
  let result = text;
  result = result.replace(/^\s*<!--\s*/, '').replace(/\s*-->\s*$/, '');
  result = result.replace(/^\s*(?:\/\/)?\s*<!\[CDATA\[/, '').replace(/\]\]>\s*(?:\/\/)?\s*$/, '');
  return stripLeading(result);
}

export interface LdBlock {
  index: number;
  /** Exactly as it appeared in the document, before any cleanup. */
  raw: string;
  /** BOM, CDATA and comment guards removed — what we hand to `JSON.parse`. */
  cleaned: string;
}

export function findLdJsonBlocks(html: string): LdBlock[] {
  const $ = cheerio.load(html);
  const blocks: LdBlock[] = [];

  // Attribute selectors are case-sensitive in cheerio but the type attribute is
  // not in HTML, so match loosely and filter.
  $('script').each((_index, element) => {
    const type = ($(element).attr('type') ?? '').split(';')[0]?.trim().toLowerCase();
    if (type !== 'application/ld+json') return;

    const raw = $(element).text();
    if (raw.trim() === '') return;

    blocks.push({ index: blocks.length, raw, cleaned: unwrapGuards(raw) });
  });

  return blocks;
}

/**
 * The page's own `<link rel=canonical>`, resolved against the page URL.
 *
 * `01` puts this next to our computed `canonical_url` precisely so the
 * divergence between them can be reported. The crawler leaves it null because
 * it does not parse HTML; filling it is extraction's job, and `04`'s
 * `url.canonical-mismatch` depends on it.
 */
export function findDeclaredCanonical(html: string, pageUrl: string): string | null {
  const $ = cheerio.load(html);

  let found: string | null = null;
  $('link').each((_index, element) => {
    if (found !== null) return;
    const rel = ($(element).attr('rel') ?? '').trim().toLowerCase();
    if (!rel.split(/\s+/).includes('canonical')) return;

    const href = ($(element).attr('href') ?? '').trim();
    if (href === '') return;

    try {
      found = new URL(href, pageUrl).toString();
    } catch {
      // A malformed canonical is a finding, not a crash. Keep the raw value so
      // the report can show what the page actually said.
      found = href;
    }
  });

  return found;
}

/**
 * Microdata and RDFa presence, plus the microdata **types** — which is as far
 * as we go without a parser, and further than it sounds.
 *
 * Full microdata extraction is blocked on a real tension (`03`): the maintained
 * parsers emit RDF quads with no path back to the emitting element, which
 * cannot satisfy `01`'s provenance requirement. But `itemtype` is an attribute,
 * and reading it needs no parser at all.
 *
 * That turns out to answer the question we actually had. Measured across the
 * two corpus sites carrying microdata, it is almost entirely theme boilerplate
 * — `WPHeader`, `WPFooter`, `SiteNavigationElement`, `Blog`, `CreativeWork` —
 * with essentially no entity overlap with the JSON-LD graph. So the worry that
 * microdata *contradicts* the JSON-LD is unfounded on this evidence; the real
 * issue is generic theme markup diluting a carefully-built graph.
 */
export function detectOtherSyntaxes(html: string): {
  microdata: number;
  rdfa: number;
  microdataTypes: string[];
} {
  const $ = cheerio.load(html);

  const types = new Set<string>();
  $('[itemscope]').each((_index, element) => {
    const itemtype = ($(element).attr('itemtype') ?? '').trim();
    for (const single of itemtype.split(/\s+/).filter((value) => value !== '')) types.add(single);
  });

  return {
    microdata: $('[itemscope]').length,
    // Not a bare `property=`: Open Graph uses that on every meta tag in a
    // modern head, which would report RDFa on every page of every site.
    rdfa: $('[typeof]').length,
    microdataTypes: [...types].sort(),
  };
}
