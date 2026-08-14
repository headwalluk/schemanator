/**
 * Group `content` — the page was fetched, but can a machine find the content?
 *
 * Stage 3 of `07`, and the group the reframe exists for. Paul's case:
 *
 * > If an AI Agent crawls a page with `web_fetch` and gets a heading with no
 * > content — even though there are words in the rendered DOM — then it's a
 * > problem that needs to be fixed.
 *
 * ## Every check here is a discrepancy, not a judgement
 *
 * That distinction is load-bearing. **This tool has no opinion about whether
 * your copy is any good** — that is the copywriter's job, and `07` rules it out
 * explicitly. What it can say is that two views of the same page disagree:
 * plenty of text is present, and a machine reading the document's own structure
 * finds almost none of it.
 *
 * Neither view has to be perfect for the gap to be real, which is what makes
 * this robust. A crude extractor finding 32 words where 2,030 are present still
 * proves the point, and the failure mode of a *better* extractor is that the
 * finding quietly disappears — the safe direction.
 */

import type { PageRecord } from '../store/workdir.ts';
import { dedupeByUrl } from './indexing.ts';
import { findingId, sampleObserved, type Check } from './framework.ts';

/** Pages we can say anything about: fetched, extracted, and carrying facts. */
/** Fetched, extracted, and one record per destination URL. See `page.ts`. */
function withFacts(pages: readonly PageRecord[]): PageRecord[] {
  return dedupeByUrl(pages.filter((page) => page.http_status === 200 && page.page_facts !== null));
}

/**
 * Below this there is not enough text for a ratio to mean anything.
 *
 * A page with 12 words of content and 2 in its landmarks is 17%, and is not a
 * finding — it is a thin page, which is the copywriter's business.
 */
const MIN_WORDS_FOR_RATIO = 50;

/**
 * Landmarks holding less than this share of the page's text.
 *
 * **Measured, not chosen.** Across 1,193 corpus pages carrying a landmark and at
 * least 50 words: p1 is 12%, p5 is 93%, and the median is 163% — the ratio can
 * exceed 100 because landmark text includes fragments the block scan does not.
 * The distribution is bimodal, and 20% sits in the empty gap between the two
 * humps: it catches 14 pages across 22 sites, and 9 of those are under 10%.
 *
 * The obvious alternative was `extractable / dom_words`, which was tried first
 * and abandoned: its median is 46% and a 25% threshold fired on **390 pages**,
 * because `dom_words` includes the navigation. That ratio mostly measures how
 * big a site's menu is.
 */
const LANDMARK_SHARE = 0.2;

// --- content.not-extractable -------------------------------------------------

const notExtractable: Check = {
  id: 'content.not-extractable',
  group: 'content',
  run({ pages }) {
    const affected = withFacts(pages).filter((page) => {
      const facts = page.page_facts;
      if (facts === null) return false;
      const { landmarks, text } = facts;
      if (!landmarks.has_main && !landmarks.has_article) return false;
      if (text.extractable_words < MIN_WORDS_FOR_RATIO) return false;
      return text.main_words < text.extractable_words * LANDMARK_SHARE;
    });

    if (affected.length === 0) return [];

    return [
      {
        finding_id: findingId('content.not-extractable', 'site'),
        check: 'content.not-extractable',
        severity: 'error',
        origin: 'check',
        title: `${affected.length} page(s) hide their content from a machine reader`,
        subject: { kind: 'site', id: 'content' },
        summary:
          `${affected.length} page(s) carry substantial text that sits **outside** the page's own ` +
          `<main> and <article> landmarks. A consumer that follows those landmarks — which is what ` +
          `most AI agents and a \`web_fetch\` do — reads a fraction of what a person sees.\n\n` +
          `This is a discrepancy, not a judgement about the writing. The words are there; the ` +
          `document's structure just does not point at them. The usual cause is a body wrapped in a ` +
          `plain \`<div>\` while \`<article>\` is used for something else, such as related-post cards.`,
        expected: 'The page body inside <main> or <article>.',
        ...sampleObserved(
          dedupeByUrl(affected).map((page) => {
            const text = page.page_facts?.text;
            return {
              value:
                `${page.canonical_url} — landmarks hold ${text?.main_words ?? 0} of ` +
                `${text?.extractable_words ?? 0} words`,
              observation_count: 1,
              page_count: 1,
              provenance: [],
            };
          }),
        ),
        pages_affected: affected.length,
        coverage_qualified: false,
        remediation:
          'Wrap the page body in <main>, or move <article> so it encloses the article rather than ' +
          'a list of links to other ones. The stored content.md shows what a reader currently gets.',
        tradeoff: null,
        page_ids: affected.map((page) => page.page_id),
      },
    ];
  },
};

// --- content.no-landmark -----------------------------------------------------

/**
 * Neither `<main>` nor `<article>` anywhere on the page.
 *
 * Site-level and reported once. 462 of 1,831 corpus pages qualify — a quarter —
 * so per page this would be the drowning `04` rule 2 exists to prevent, and it
 * is one template decision rather than 462 problems.
 */
const noLandmark: Check = {
  id: 'content.no-landmark',
  group: 'content',
  run({ pages }) {
    const withText = withFacts(pages).filter(
      (page) => (page.page_facts?.text.extractable_words ?? 0) >= MIN_WORDS_FOR_RATIO,
    );
    if (withText.length === 0) return [];

    const bare = withText.filter((page) => {
      const landmarks = page.page_facts?.landmarks;
      return landmarks !== undefined && !landmarks.has_main && !landmarks.has_article;
    });
    if (bare.length === 0) return [];

    return [
      {
        finding_id: findingId('content.no-landmark', 'site'),
        check: 'content.no-landmark',
        severity: 'opportunity',
        origin: 'check',
        title: `${bare.length} of ${withText.length} pages have no <main> or <article>`,
        subject: { kind: 'site', id: 'landmarks' },
        summary:
          `${bare.length} page(s) with real text carry neither <main> nor <article>, so a consumer ` +
          `reading the document's structure has nothing to anchor on and must guess which part of ` +
          `the page is the page. Most get it right most of the time; the ones that do not fail ` +
          `silently, and you never find out.\n\n` +
          `Nothing is broken, and a person reading the site sees no difference. This is about what ` +
          `a machine can be *sure* of.`,
        expected: 'A <main> element wrapping the page body.',
        ...sampleObserved(
          dedupeByUrl(bare).map((page) => ({
            value: page.canonical_url,
            observation_count: 1,
            page_count: 1,
            provenance: [],
          })),
        ),
        pages_affected: bare.length,
        coverage_qualified: false,
        remediation:
          'Add <main> around the body in the theme template. One edit usually covers every page.',
        tradeoff: null,
      },
    ];
  },
};

// --- content.main-in-aside ---------------------------------------------------

/** More of the page's text is in an `<aside>` than in its main landmarks. */
const mainInAside: Check = {
  id: 'content.main-in-aside',
  group: 'content',
  run({ pages }) {
    const affected = withFacts(pages).filter((page) => {
      const text = page.page_facts?.text;
      if (text === undefined) return false;
      // The claim is "this page's substance is in an aside", so the page must
      // have substance. Without this it fired on 8 utility pages of one site
      // with 9-32 words of content apiece, where any sidebar exceeds the body —
      // and the advice was wrong twice over, because those pages should not have
      // been in the sitemap at all. `indexing.thin-sitemap-entry` says so.
      //
      // Exactly the flaw fixed in `content.hidden-text`, not carried across to
      // its sibling at the time.
      return (
        text.aside_words >= MIN_WORDS_FOR_RATIO &&
        text.extractable_words >= MIN_WORDS_FOR_RATIO &&
        text.aside_words > text.main_words
      );
    });
    if (affected.length === 0) return [];

    return [
      {
        finding_id: findingId('content.main-in-aside', 'site'),
        check: 'content.main-in-aside',
        severity: 'warning',
        origin: 'check',
        title: `${affected.length} page(s) hold more text in <aside> than in <main>`,
        subject: { kind: 'site', id: 'content' },
        summary:
          `On ${affected.length} page(s), <aside> — which means "tangential to the content" — ` +
          `contains more words than <main> and <article> combined. Extractors treat an aside as ` +
          `secondary and commonly drop it, so if that is where the page's substance lives, the ` +
          `substance is what gets dropped.`,
        expected: 'The page body in <main>, with <aside> for genuinely secondary material.',
        ...sampleObserved(
          dedupeByUrl(affected).map((page) => {
            const text = page.page_facts?.text;
            return {
              value: `${page.canonical_url} — aside ${text?.aside_words ?? 0} words, main ${text?.main_words ?? 0}`,
              observation_count: 1,
              page_count: 1,
              provenance: [],
            };
          }),
        ),
        pages_affected: affected.length,
        coverage_qualified: false,
        remediation: 'Move the body into <main>, and keep <aside> for sidebars and related links.',
        tradeoff: null,
        page_ids: affected.map((page) => page.page_id),
      },
    ];
  },
};

// --- content.javascript-only -------------------------------------------------

/**
 * A page that is heavy on the wire and nearly empty of server-rendered text.
 *
 * **This tool's refusal to run JavaScript is the measurement**, not a limitation
 * to apologise for. We see precisely what a non-rendering fetcher sees, which is
 * what most AI agents are and what Google's first pass is.
 *
 * Both thresholds are deliberately extreme. A page can be legitimately short —
 * a contact page, a redirect stub — so this fires only when a large response
 * produces almost no readable text, which is the signature of client-side
 * rendering rather than of brevity.
 */
const MAX_WORDS_FOR_JS_ONLY = 100;
const MIN_BYTES_FOR_JS_ONLY = 50_000;

const javascriptOnly: Check = {
  id: 'content.javascript-only',
  group: 'content',
  run({ pages }) {
    const affected = withFacts(pages).filter(
      (page) =>
        (page.page_facts?.text.dom_words ?? 0) < MAX_WORDS_FOR_JS_ONLY &&
        page.bytes >= MIN_BYTES_FOR_JS_ONLY,
    );
    if (affected.length === 0) return [];

    return [
      {
        finding_id: findingId('content.javascript-only', 'site'),
        check: 'content.javascript-only',
        severity: 'error',
        origin: 'check',
        title: `${affected.length} page(s) appear to render their content in the browser`,
        subject: { kind: 'site', id: 'content' },
        summary:
          `${affected.length} page(s) return a large response containing almost no readable text. ` +
          `That is the signature of content assembled by JavaScript after the page loads.\n\n` +
          `**schemanator does not run JavaScript, and here that is the point rather than a ` +
          `limitation** — it sees exactly what a non-rendering consumer sees, which is what most AI ` +
          `agents are and what Google's first indexing pass is. Anything only assembled in a browser ` +
          `is invisible to them, and to this report.`,
        expected: 'The page content present in the HTML as served.',
        ...sampleObserved(
          dedupeByUrl(affected).map((page) => ({
            value: `${page.canonical_url} — ${Math.round(page.bytes / 1024)} KB, ${page.page_facts?.text.dom_words ?? 0} words`,
            observation_count: 1,
            page_count: 1,
            provenance: [],
          })),
        ),
        pages_affected: affected.length,
        coverage_qualified: false,
        remediation:
          'Server-render the content, or pre-render it. Confirm what Google sees with the URL ' +
          'Inspection tool, which does render.',
        tradeoff: null,
        page_ids: affected.map((page) => page.page_id),
      },
    ];
  },
};

// --- content.hidden-text -----------------------------------------------------

/**
 * More text hidden than shown.
 *
 * 592 corpus pages carry *some* hidden text, at a median of 66 words — tabs,
 * accordions and mobile menus, all entirely normal. So the bar is deliberately
 * high: more hidden than visible, which is not a design pattern but a page
 * whose substance is behind something.
 */
const hiddenText: Check = {
  id: 'content.hidden-text',
  group: 'content',
  run({ pages }) {
    const affected = withFacts(pages).filter((page) => {
      const text = page.page_facts?.text;
      if (text === undefined) return false;
      // Both sides must be substantial. Requiring only "more hidden than
      // visible" fired on 48 colour-swatch pages with 17 visible words apiece —
      // pages that are *sparse*, not pages that are concealing anything. The
      // claim is "this page's substance is hidden", so it must have substance.
      return (
        text.hidden_words >= MIN_WORDS_FOR_RATIO &&
        text.extractable_words >= MIN_WORDS_FOR_RATIO &&
        text.hidden_words > text.extractable_words
      );
    });
    if (affected.length === 0) return [];

    return [
      {
        finding_id: findingId('content.hidden-text', 'site'),
        check: 'content.hidden-text',
        severity: 'warning',
        origin: 'check',
        title: `${affected.length} page(s) hide more text than they show`,
        subject: { kind: 'site', id: 'content' },
        summary:
          `${affected.length} page(s) carry more words behind \`hidden\` or \`aria-hidden\` than in ` +
          `the open. Tabs and accordions are normal and are not what this reports — this is a page ` +
          `whose substance is concealed from anything that honours those attributes, which includes ` +
          `screen readers and most text extractors.`,
        expected: 'The page substance visible without interaction.',
        ...sampleObserved(
          dedupeByUrl(affected).map((page) => {
            const text = page.page_facts?.text;
            return {
              value: `${page.canonical_url} — ${text?.hidden_words ?? 0} hidden, ${text?.extractable_words ?? 0} visible`,
              observation_count: 1,
              page_count: 1,
              provenance: [],
            };
          }),
        ),
        pages_affected: affected.length,
        coverage_qualified: false,
        remediation:
          'Check whether the hidden content is meant to be reachable. If it is behind a tab, ' +
          'ensure the markup is present and only visually collapsed rather than removed.',
        tradeoff: null,
        page_ids: affected.map((page) => page.page_id),
      },
    ];
  },
};

export const CONTENT_CHECKS: Check[] = [
  notExtractable,
  javascriptOnly,
  mainInAside,
  hiddenText,
  noLandmark,
];
