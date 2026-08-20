/**
 * Per-page facts, links, and the de-boilerplated text view.
 *
 * `04` forbids checks from touching HTML, so extraction records *facts* and the
 * checks read them — the same pattern as `microdata_types`. This module is
 * where the facts come from, and it runs while cheerio already holds the DOM,
 * so the marginal cost sits against a parse that is already happening.
 *
 * ## Why the markdown is hand-rolled rather than `turndown`
 *
 * Two reasons, and the second is the stronger one.
 *
 * `turndown` needs a real DOM and brings its own (`@mixmark-io/domino`), so it
 * would **re-parse every page** — doubling the most expensive thing `analyse`
 * does. Extraction is already 99% of its runtime.
 *
 * And it would convert the *whole* page. What we need is the main content with
 * site chrome removed, which turndown has no opinion about — so the stripping
 * has to happen here regardless, and once it has, emitting markdown from the
 * surviving blocks is thirty lines.
 *
 * ## Boilerplate is measured, not guessed
 *
 * Removing chrome per page needs heuristics — that is what Readability is, and
 * `07` records why it was rejected: it is version-sensitive, so an upgrade
 * changes findings with no change to the site, which breaks `--since` diffing.
 *
 * Measuring it across a site needs none. A block of text appearing on 147 of
 * 150 pages **is** chrome, and no per-page tool can know that. Same argument as
 * the rest of this product, applied to text instead of entities.
 */

import { createHash } from 'node:crypto';
import type { CheerioAPI } from 'cheerio';
import * as cheerio from 'cheerio';

/** Elements whose text is a unit for chrome detection and for markdown. */
const BLOCK_SELECTOR = 'p, li, h1, h2, h3, h4, h5, h6, blockquote, figcaption, dd, dt, th, td';

/** Never part of the content, whatever a frequency count says. */
const NEVER_CONTENT = 'script, style, noscript, template, svg, iframe';

/**
 * Elements that *say* they are not main content.
 *
 * This is reading the document, not guessing at it — which is the line `07`
 * draws when it rejects Readability. `<nav>` means navigation because the
 * author wrote `<nav>`; no heuristic is involved and no version of a library
 * can change its mind about it.
 *
 * It also covers the case frequency cannot: on a site of fewer than
 * `MIN_PAGES_FOR_CHROME` pages there is nothing to count, and without this the
 * markdown would open with the main menu.
 *
 * **`<aside>` is deliberately absent.** Main content wrongly placed in an
 * `<aside>` is the subject of a planned finding (`content.main-in-aside`), and
 * stripping it here would erase the very discrepancy that check exists to see.
 */
const STRUCTURAL_CHROME =
  'nav, header, footer, [role="navigation"], [role="banner"], [role="contentinfo"]';

/**
 * Below this a block is too short to *anchor a link* to a context, which is the
 * only thing the threshold is still used for.
 *
 * It was briefly applied to block extraction itself and quietly censored the
 * document: "What is included" is three words, so almost every heading on every
 * page was dropped and the markdown came out as unheaded prose. Length is not
 * evidence of boilerplate — **frequency is**, and frequency is measured.
 */
const MIN_ANCHOR_WORDS = 4;

/** A block appearing on at least this share of pages is site chrome. */
export const CHROME_SHARE = 0.8;

export interface TextBlock {
  /** Stable hash of the normalised text. The frequency-count key. */
  hash: string;
  /** Headings are structure, and are never treated as chrome. See `isChromeCandidate`. */
  /** `p`, `h2`, `li` … drives markdown rendering. */
  tag: string;
  text: string;
  words: number;
  /** Inside `hidden`, `aria-hidden` or an inline `display:none`. */
  hidden: boolean;
  /** Inside `<nav>`, `<header>` or `<footer>`. Chrome by declaration. */
  structural_chrome: boolean;
}

export interface PageLink {
  to: string;
  anchor: string;
  internal: boolean;
  rel: string | null;
  /** Hash of the enclosing block, so chrome can be decided in the second pass. */
  block: string | null;
}

/** Facts that need only this page. The site-wide ones are filled in later. */
export interface PageFacts {
  title: string | null;
  meta_description: string | null;
  /** Levels only, in document order. No check needs the text (`07`). */
  heading_levels: number[];
  robots: { index: boolean; follow: boolean; raw: string | null };
  hreflang: { lang: string; href: string }[];
  html_lang: string | null;
  landmarks: { has_main: boolean; has_article: boolean };
  images: { total: number; missing_alt: number; suspect_alt: string[] };
  text: {
    /** Every word in the body, chrome included. */
    dom_words: number;
    /** Outside site chrome and not hidden — what is genuinely on the page. */
    extractable_words: number;
    /**
     * Inside `<main>` or `<article>` — what a landmark-following extractor gets,
     * which is what a `web_fetch`-style consumer usually is.
     *
     * The gap between this and `extractable_words` is the finding: text that is
     * plainly there, and that a machine reading the document's own structure
     * will not find.
     */
    main_words: number;
    /** Inside `<aside>` or `role="complementary"`. Content in the wrong place. */
    aside_words: number;
    hidden_words: number;
  };
  /** Over the de-boilerplated text. Comparison primitive, never the text. */
  content_simhash: string | null;
}

const normalise = (text: string): string => text.replace(/\s+/g, ' ').trim();
const countWords = (text: string): number => (text === '' ? 0 : text.split(' ').length);

export function blockHash(text: string): string {
  return createHash('sha256').update(normalise(text).toLowerCase()).digest('hex').slice(0, 16);
}

/**
 * Alt text that exists but says nothing a consumer can use.
 *
 * **A file extension alone is not enough**, and the corpus said so. An earlier
 * version flagged anything ending `.jpg`, which caught alt text like `"<company>
 * logo.jpg"` and `"<product>-print-to-perfection-banner-circle.png"` — both of
 * which describe their image perfectly well. The suffix is untidy;
 * telling somebody to rewrite them is low-value advice, and low-value advice is
 * what makes a report get skimmed.
 *
 * So the *stem* has to be uninformative too. What survives is the real thing:
 * `"1000005782"` on 142 pages of one site, and `"IMG"` on twelve more.
 */
const USELESS_STEM = [
  /^(dsc|dscn|img|image|photo|pic|untitled|screenshot|banner|logo)[-_ ]?\d*$/i,
  /^\d[\d-_ ]*$/,
];

export function isUselessAlt(alt: string): boolean {
  const trimmed = alt.trim();
  if (trimmed === '') return false; // Empty alt is *decorative*, and legitimate.
  const stem = trimmed.replace(/\.(jpe?g|png|gif|webp|svg|avif)$/i, '').trim();
  return USELESS_STEM.some((pattern) => pattern.test(stem));
}

/**
 * May this block be judged site chrome?
 *
 * **Headings never can.** They are the document's structure, and a site that
 * uses the same section heading on many pages — "Ingredients", "Specification",
 * "Opening hours" — would otherwise have its outline stripped out of the
 * markdown by its own consistency.
 */
export function isChromeCandidate(block: TextBlock): boolean {
  return !/^h[1-6]$/.test(block.tag);
}

/** Chrome by frequency, or chrome by declaration. Either is enough. */
export function isChrome(block: TextBlock, byFrequency: ReadonlySet<string>): boolean {
  return block.structural_chrome || byFrequency.has(block.hash);
}

/** Text blocks in document order, with the hidden ones marked rather than dropped. */
export function extractBlocks($: CheerioAPI): TextBlock[] {
  const blocks: TextBlock[] = [];

  $(BLOCK_SELECTOR).each((_index, element) => {
    const node = $(element);
    // Nested blocks would double-count: a `li` inside a `li`, or a `p` in a
    // `td`. Only the innermost carries its own text.
    if (node.find(BLOCK_SELECTOR).length > 0) return;

    const text = normalise(node.text());
    const words = countWords(text);
    if (words === 0) return;

    const hidden =
      node.closest('[hidden], [aria-hidden="true"]').length > 0 ||
      /display\s*:\s*none/i.test(node.closest('[style]').attr('style') ?? '');

    blocks.push({
      structural_chrome: node.closest(STRUCTURAL_CHROME).length > 0,
      hash: blockHash(text),
      tag: (element as { tagName?: string }).tagName?.toLowerCase() ?? 'p',
      text,
      words,
      hidden,
    });
  });

  return blocks;
}

/**
 * Resolve one `href` against the page it was found on. `null` if it is not a
 * link to a document — an anchor, a `mailto:`, a `tel:`, or unparseable.
 *
 * **Factored out so the crawl and extraction cannot disagree about what a link
 * is.** The link hop (`dev-notes/11`) has to decide which URLs a page points at
 * during the crawl, hours before extraction runs; two implementations of "is
 * this internal" would be two answers to a question this whole tool is about.
 */
export function resolveHref(
  href: string,
  pageUrl: string,
  siteHost: string,
): { resolved: string; internal: boolean } | null {
  const trimmed = href.trim();
  if (trimmed === '' || trimmed.startsWith('#') || /^(mailto|tel|javascript):/i.test(trimmed))
    return null;

  try {
    const url = new URL(trimmed, pageUrl);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    url.hash = '';
    return { resolved: url.toString(), internal: url.host === siteHost };
  } catch {
    return null;
  }
}

/**
 * Every distinct internal URL this page links to.
 *
 * Deliberately cheaper than {@link extractLinks}: no anchor text, no enclosing
 * block, no hashing. The crawl calls this on a body it already holds in memory,
 * and the block work is the expensive half — `.closest()` and `.text()` per
 * link, against 2,871 links on a 54-page site.
 */
export function collectLinkTargets($: CheerioAPI, pageUrl: string, siteHost: string): string[] {
  const targets = new Set<string>();

  $('a[href]').each((_index, element) => {
    const link = resolveHref($(element).attr('href') ?? '', pageUrl, siteHost);
    if (link !== null && link.internal) targets.add(link.resolved);
  });

  return [...targets];
}

export function extractLinks($: CheerioAPI, pageUrl: string, siteHost: string): PageLink[] {
  const links: PageLink[] = [];

  $('a[href]').each((_index, element) => {
    const node = $(element);
    const link = resolveHref(node.attr('href') ?? '', pageUrl, siteHost);
    if (link === null) return;
    const { resolved, internal } = link;

    // Which block encloses this link decides whether it is navigation or
    // content, once the site-wide frequency count is known.
    const enclosing = node.closest(BLOCK_SELECTOR);
    const enclosingText = enclosing.length > 0 ? normalise(enclosing.text()) : '';

    links.push({
      to: resolved,
      anchor: normalise(node.text()).slice(0, 200),
      internal,
      rel: node.attr('rel') ?? null,
      block: countWords(enclosingText) >= MIN_ANCHOR_WORDS ? blockHash(enclosingText) : null,
    });
  });

  return links;
}

/** Everything derivable from this page alone. `text.extractable_words` is provisional. */
export function extractPageFacts($: CheerioAPI, blocks: readonly TextBlock[]): PageFacts {
  const robotsRaw = $('meta[name="robots"]').attr('content') ?? null;
  const robotsLower = (robotsRaw ?? '').toLowerCase();

  const headingLevels: number[] = [];
  $('h1, h2, h3, h4, h5, h6').each((_index, element) => {
    const tag = (element as { tagName?: string }).tagName ?? '';
    const level = Number.parseInt(tag.slice(1), 10);
    if (!Number.isNaN(level)) headingLevels.push(level);
  });

  const hreflang: { lang: string; href: string }[] = [];
  $('link[rel="alternate"][hreflang]').each((_index, element) => {
    const lang = $(element).attr('hreflang');
    const href = $(element).attr('href');
    if (lang !== undefined && href !== undefined) hreflang.push({ lang, href });
  });

  let imagesTotal = 0;
  let missingAlt = 0;
  const suspectAlt: string[] = [];
  $('img').each((_index, element) => {
    imagesTotal += 1;
    const alt = $(element).attr('alt');
    if (alt === undefined) missingAlt += 1;
    else if (isUselessAlt(alt) && suspectAlt.length < 5) suspectAlt.push(alt.trim());
  });

  // The whole document's text, chrome included, with scripts removed.
  const body = $('body').clone();
  body.find(NEVER_CONTENT).remove();
  const domWords = countWords(normalise(body.text()));

  // What a consumer following the document's own landmarks would read.
  const wordsIn = (selector: string): number => {
    const scope = $(selector);
    if (scope.length === 0) return 0;
    const clone = scope.clone();
    clone.find(NEVER_CONTENT).remove();
    return countWords(normalise(clone.text()));
  };
  const mainWords = wordsIn('main, article');
  const asideWords = wordsIn('aside, [role="complementary"]');

  return {
    title: normalise($('title').first().text()) || null,
    meta_description: $('meta[name="description"]').attr('content')?.trim() ?? null,
    heading_levels: headingLevels,
    robots: {
      index: !robotsLower.includes('noindex'),
      follow: !robotsLower.includes('nofollow'),
      raw: robotsRaw,
    },
    hreflang,
    html_lang: $('html').attr('lang')?.trim() ?? null,
    landmarks: { has_main: $('main').length > 0, has_article: $('article').length > 0 },
    images: { total: imagesTotal, missing_alt: missingAlt, suspect_alt: suspectAlt },
    text: {
      dom_words: domWords,
      main_words: mainWords,
      aside_words: asideWords,
      // Provisional: every visible block. The second pass subtracts chrome.
      extractable_words: blocks
        .filter((block) => !block.hidden)
        .reduce((sum, b) => sum + b.words, 0),
      hidden_words: blocks.filter((block) => block.hidden).reduce((sum, b) => sum + b.words, 0),
    },
    content_simhash: null,
  };
}

/**
 * A 64-bit simhash over word shingles.
 *
 * Near-duplicate detection needs *similarity*, not equality: two pages
 * differing by one menu item hash differently under SHA-256 and are 99% the
 * same document. Simhash puts them a few bits apart, so a Hamming distance
 * answers "how alike are these" from two integers.
 *
 * Deterministic and dependency-free, which matters — `05` needs cross-run
 * diffing, and a similarity measure that shifted between versions would make
 * findings appear and vanish with no change to the site.
 */
export function simhash(text: string): string {
  const words = normalise(text).toLowerCase().split(' ').filter(Boolean);
  if (words.length === 0) return '0'.repeat(16);

  // Shingles rather than words: word order carries most of the signal, and a
  // bag of words calls two pages with the same vocabulary identical.
  const shingles: string[] = [];
  for (let index = 0; index + 2 < words.length; index += 1) {
    shingles.push(words.slice(index, index + 3).join(' '));
  }
  if (shingles.length === 0) shingles.push(words.join(' '));

  const bits = new Array<number>(64).fill(0);
  for (const shingle of shingles) {
    const digest = createHash('sha256').update(shingle).digest();
    for (let bit = 0; bit < 64; bit += 1) {
      const byte = digest[bit >> 3] ?? 0;
      const set = (byte >> (7 - (bit % 8))) & 1;
      bits[bit] = (bits[bit] ?? 0) + (set === 1 ? 1 : -1);
    }
  }

  let hex = '';
  for (let nibble = 0; nibble < 16; nibble += 1) {
    let value = 0;
    for (let bit = 0; bit < 4; bit += 1) {
      value = (value << 1) | ((bits[nibble * 4 + bit] ?? 0) > 0 ? 1 : 0);
    }
    hex += value.toString(16);
  }
  return hex;
}

/** Bits differing between two simhashes. Below ~6 of 64 is "substantially the same". */
export function hammingDistance(left: string, right: string): number {
  if (left.length !== right.length) return 64;
  let distance = 0;
  for (let index = 0; index < left.length; index += 1) {
    let difference = parseInt(left[index] ?? '0', 16) ^ parseInt(right[index] ?? '0', 16);
    while (difference > 0) {
      distance += difference & 1;
      difference >>= 1;
    }
  }
  return distance;
}

/** The de-boilerplated page, as markdown. Written for a person to read. */
export function renderMarkdown(
  blocks: readonly TextBlock[],
  chrome: ReadonlySet<string>,
  title: string | null,
): string {
  const kept = blocks.filter((block) => !isChrome(block, chrome) && !block.hidden);

  const lines: string[] = [];
  // Headings keep their own level, and the `<title>` is only used when the
  // content has no `h1` of its own. The first version emitted the title as `#`
  // and shifted every heading down one, which printed the same words twice on
  // any page whose `h1` matches its title — which is most of them.
  if (title !== null && !kept.some((block) => block.tag === 'h1')) {
    lines.push(`# ${title}`, '');
  }

  for (const block of kept) {
    if (/^h[1-6]$/.test(block.tag)) {
      const level = Number.parseInt(block.tag.slice(1), 10);
      lines.push(`${'#'.repeat(level)} ${block.text}`, '');
    } else if (block.tag === 'li') {
      lines.push(`- ${block.text}`);
    } else {
      lines.push(block.text, '');
    }
  }

  return `${lines
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()}\n`;
}

/** Load HTML once, for callers that need the DOM rather than a fact. */
export function loadDom(html: string): CheerioAPI {
  return cheerio.load(html);
}
