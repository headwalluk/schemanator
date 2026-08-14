/**
 * Group `page` — the content was found, but can a machine parse the document?
 *
 * Stage 4 of `07`, and the last of the four things that can block a consumer.
 * Everything here is something a machine *uses* to build its model of the page:
 * the document title it reads, the images it cannot see, the language it would
 * otherwise guess.
 *
 * ## What the corpus removed from this group
 *
 * `07` planned a `page.heading-sequence` check for skipped levels — `h2`
 * followed by `h4`. **Measured across 1,831 pages, 549 of them skip a level:
 * 29%.** At that incidence it is normal practice rather than a defect, and a
 * slightly malformed outline does not stop a machine consuming anything. It
 * fails this document's own admission test, so it is not built. Same lesson as
 * `coverage.type-gap`, which was noise until it was narrowed.
 *
 * Title and description *length* were excluded at design time, for the same
 * reason: Google truncates on pixel width, the character thresholds everyone
 * quotes are folklore, and nobody can act on "63 characters" without looking at
 * the page.
 *
 * ## Everything here is site-level
 *
 * A per-page finding for missing alt text on a 500-page site is 500 findings
 * describing one template. Each check below reports once, names the pages, and
 * says how many.
 */

import type { PageRecord } from '../store/workdir.ts';
import { dedupeByUrl } from './indexing.ts';
import { findingId, sampleObserved, type Check, type Finding } from './framework.ts';

/**
 * Fetched, extracted, and **one record per destination URL**.
 *
 * Several requests can land on one page — `/checkout/` redirecting to
 * `/basket/` leaves two records sharing a `canonical_url` — and every check
 * here reasons about the page a reader arrives at, not the request that got
 * them there. Deduplicating only the *display* was not enough: it left titles
 * counting 9 while the field beneath said 8, and it let `page.title-duplicate`
 * report one page as a duplicate of itself.
 *
 * `indexing` deliberately does not do this. A sitemap entry that redirects is a
 * fact about the request, and collapsing it would erase the finding.
 */
function withFacts(pages: readonly PageRecord[]): PageRecord[] {
  return dedupeByUrl(pages.filter((page) => page.http_status === 200 && page.page_facts !== null));
}

/** One finding for the site, listing a sample of the pages behind it. */
function siteFinding(options: {
  check: string;
  severity: Finding['severity'];
  title: string;
  summary: string;
  expected: string | null;
  remediation: string;
  tradeoff?: string;
  pages: readonly PageRecord[];
  describe?: (page: PageRecord) => string;
}): Finding {
  return {
    finding_id: findingId(options.check, 'site'),
    check: options.check,
    severity: options.severity,
    origin: 'check',
    title: options.title,
    subject: { kind: 'site', id: 'page' },
    summary: options.summary,
    expected: options.expected,
    // One row per URL. Several requests can land on one page, and listing the
    // same URL twice reads as a bug in the tool rather than a fact about the site.
    ...sampleObserved(
      options.pages.map((page) => ({
        value: options.describe === undefined ? page.canonical_url : options.describe(page),
        observation_count: 1,
        page_count: 1,
        provenance: [],
      })),
    ),
    pages_affected: options.pages.length,
    coverage_qualified: false,
    remediation: options.remediation,
    tradeoff: options.tradeoff ?? null,
    page_ids: options.pages.map((page) => page.page_id),
  };
}

// --- page.title-missing ------------------------------------------------------

/** *Untriggered: every one of the 1,831 corpus pages has a title.* */
const titleMissing: Check = {
  id: 'page.title-missing',
  group: 'page',
  run({ pages }) {
    const bare = withFacts(pages).filter((page) => page.page_facts?.title === null);
    if (bare.length === 0) return [];

    return [
      siteFinding({
        check: 'page.title-missing',
        severity: 'error',
        title: `${bare.length} page(s) have no <title>`,
        summary:
          `${bare.length} page(s) carry no <title> element. It is the single strongest signal a ` +
          `machine has for what a page is, used as the heading in search results and as the label ` +
          `almost everywhere else a page is referenced.`,
        expected: 'A <title> on every page.',
        remediation: 'Set a title in the template or the page settings.',
        pages: bare,
      }),
    ];
  },
};

// --- page.h1-missing / page.h1-multiple --------------------------------------

const h1Missing: Check = {
  id: 'page.h1-missing',
  group: 'page',
  run({ pages }) {
    const bare = withFacts(pages).filter(
      (page) => (page.page_facts?.heading_levels ?? []).filter((level) => level === 1).length === 0,
    );
    if (bare.length === 0) return [];

    return [
      siteFinding({
        check: 'page.h1-missing',
        severity: 'warning',
        title: `${bare.length} page(s) have no <h1>`,
        summary:
          `${bare.length} page(s) carry no top-level heading. A consumer building an outline of the ` +
          `document has nothing to hang it on, and the page's own statement of what it is about is ` +
          `missing — leaving the <title> and the URL to carry it alone.`,
        expected: 'One <h1> per page, saying what the page is about.',
        remediation: 'Add an <h1>. On most templates the page or post title should be one.',
        pages: bare,
      }),
    ];
  },
};

/**
 * More than one `h1`.
 *
 * **Reported as an opportunity, and worded carefully, because the rule people
 * remember is out of date.** HTML5 permits an `h1` inside each sectioning
 * element, and Google has said explicitly that several are fine. 205 of 1,831
 * corpus pages have more than one — 11%, and 144 of those are a single site.
 *
 * It is still worth surfacing: a consumer picking one line to represent the
 * document has to choose, and it will not always choose the one you meant. That
 * is a genuine ambiguity, and it is also not a defect, so the wording must not
 * imply the page is broken.
 */
const h1Multiple: Check = {
  id: 'page.h1-multiple',
  group: 'page',
  run({ pages }) {
    const affected = withFacts(pages).filter(
      (page) => (page.page_facts?.heading_levels ?? []).filter((level) => level === 1).length > 1,
    );
    if (affected.length === 0) return [];

    return [
      siteFinding({
        check: 'page.h1-multiple',
        severity: 'opportunity',
        title: `${affected.length} page(s) have more than one <h1>`,
        summary:
          `${affected.length} page(s) carry several top-level headings. **This is valid HTML and ` +
          `Google has said it is fine**, so nothing here is broken — but a consumer picking one ` +
          `line to represent the document has to choose between them, and it will not always ` +
          `choose the one you meant.`,
        expected: null,
        remediation:
          'If the page has one subject, give it one <h1> and demote the rest. If it genuinely has ' +
          'several sections, this is working as intended and can be silenced with ' +
          '--disable page.h1-multiple.',
        tradeoff:
          'The one-h1 rule comes from HTML4 and is widely repeated as though it still applied. ' +
          'HTML5 sectioning permits several, so this is reported as an ambiguity to resolve rather ' +
          'than an error to fix.',
        pages: affected,
        describe: (page) =>
          `${page.canonical_url} — ${(page.page_facts?.heading_levels ?? []).filter((l) => l === 1).length} <h1> elements`,
      }),
    ];
  },
};

// --- page.image-alt-missing / page.image-alt-useless -------------------------

const imageAltMissing: Check = {
  id: 'page.image-alt-missing',
  group: 'page',
  run({ pages }) {
    const affected = withFacts(pages).filter(
      (page) => (page.page_facts?.images.missing_alt ?? 0) > 0,
    );
    if (affected.length === 0) return [];

    const images = affected.reduce(
      (sum, page) => sum + (page.page_facts?.images.missing_alt ?? 0),
      0,
    );
    const total = withFacts(pages).reduce(
      (sum, page) => sum + (page.page_facts?.images.total ?? 0),
      0,
    );

    return [
      siteFinding({
        check: 'page.image-alt-missing',
        severity: 'warning',
        title: `${images} image(s) have no alt attribute`,
        summary:
          `${images} of ${total} images across ${affected.length} page(s) carry no alt attribute at ` +
          `all. **To anything reading the page as text, an image without alt is simply absent** — ` +
          `whatever it shows, says or sells is invisible to a search engine, an AI agent and a ` +
          `screen reader alike.\n\n` +
          `An explicitly empty \`alt=""\` is *not* reported: that is the correct way to mark an ` +
          `image as decorative, and this only counts images with no alt attribute.`,
        expected: 'An alt attribute on every image, empty only where it is decorative.',
        remediation:
          'Describe what the image shows, or set alt="" if it is decorative. The media library ' +
          'usually carries a default that most themes will use.',
        pages: affected,
        describe: (page) =>
          `${page.canonical_url} — ${page.page_facts?.images.missing_alt ?? 0} of ${page.page_facts?.images.total ?? 0} images`,
      }),
    ];
  },
};

/**
 * Alt values quoted in the finding, and in its opening sentence.
 *
 * The whole set is not listed: one corpus site carries 40 variations of
 * `IMG_1234.jpg`, and the fortieth teaches a reader nothing the third did not.
 * The sentence takes fewer still, because it is a sentence.
 */
const ALT_VALUES_LISTED = 8;
const ALT_VALUES_IN_SENTENCE = 3;

const imageAltUseless: Check = {
  id: 'page.image-alt-useless',
  group: 'page',
  run({ pages }) {
    const affected = withFacts(pages).filter(
      (page) => (page.page_facts?.images.suspect_alt ?? []).length > 0,
    );
    if (affected.length === 0) return [];

    const samples = [
      ...new Set(affected.flatMap((page) => page.page_facts?.images.suspect_alt ?? [])),
    ].slice(0, ALT_VALUES_LISTED);

    return [
      siteFinding({
        check: 'page.image-alt-useless',
        severity: 'warning',
        title: `${affected.length} page(s) carry alt text that describes nothing`,
        summary:
          `Alt text like ${samples
            .slice(0, ALT_VALUES_IN_SENTENCE)
            .map((s) => `"${s}"`)
            .join(', ')} is a filename or a ` +
          `camera reference, not a description. It passes every automated check that only asks ` +
          `whether the attribute exists, and tells a reader nothing at all — which is arguably ` +
          `worse than an empty one, because it looks handled.\n\n` +
          `Values seen: ${samples.map((s) => `"${s}"`).join(', ')}`,
        expected: 'Alt text describing what the image shows.',
        remediation:
          'Replace the filenames with descriptions. These usually come from a bulk upload where ' +
          'the media library took the filename as the title.',
        pages: affected,
        describe: (page) =>
          `${page.canonical_url} — ${(page.page_facts?.images.suspect_alt ?? []).join(', ')}`,
      }),
    ];
  },
};

// --- page.lang-missing -------------------------------------------------------

/** *Untriggered: every corpus page declares a language.* */
const langMissing: Check = {
  id: 'page.lang-missing',
  group: 'page',
  run({ pages }) {
    const bare = withFacts(pages).filter((page) => page.page_facts?.html_lang === null);
    if (bare.length === 0) return [];

    return [
      siteFinding({
        check: 'page.lang-missing',
        severity: 'opportunity',
        title: `${bare.length} page(s) do not declare a language`,
        summary:
          `${bare.length} page(s) carry no lang attribute on <html>, so anything processing the ` +
          `text has to guess which language it is in. Guessing is usually right and occasionally ` +
          `wrong, and when it is wrong the consequences are silent.`,
        expected: 'A lang attribute on <html>, such as lang="en-GB".',
        remediation: 'Set the site language. Most themes emit this from a single setting.',
        pages: bare,
      }),
    ];
  },
};

// --- page.title-duplicate ----------------------------------------------------

/**
 * One title across several pages.
 *
 * Site-wide by nature, which makes it a natural fit here — a per-page tool can
 * see a title but not that it is shared. 36 duplicate groups across the corpus.
 */
const titleDuplicate: Check = {
  id: 'page.title-duplicate',
  group: 'page',
  run({ pages }) {
    const byTitle = new Map<string, PageRecord[]>();
    for (const page of withFacts(pages)) {
      const title = page.page_facts?.title;
      if (title === null || title === undefined || title === '') continue;
      byTitle.set(title, [...(byTitle.get(title) ?? []), page]);
    }

    const shared = [...byTitle.entries()]
      .filter(([, group]) => group.length > 1)
      .sort(([, left], [, right]) => right.length - left.length);
    if (shared.length === 0) return [];

    const affected = shared.flatMap(([, group]) => group);

    return [
      {
        ...siteFinding({
          check: 'page.title-duplicate',
          severity: 'warning',
          title: `${shared.length} title(s) are used on more than one page`,
          summary:
            `${affected.length} page(s) share ${shared.length} title(s) between them. The title is the ` +
            `strongest signal a machine has for what a page is, so where several pages claim the same ` +
            `one, nothing distinguishes them — not in a search result, not in a list of citations, ` +
            `and not to anything deciding which of them to keep.`,
          expected: 'A distinct title per page.',
          remediation:
            'Give each page its own title. Paginated archives and filtered listings are the usual ' +
            'source, and adding the page number or filter is normally enough.',
          pages: affected,
        }),
        // The duplicated titles are what an operator acts on. A list of URLs
        // says which pages collide without saying what they collide on.
        // The title is not wrapped in quotes. One corpus site has a page title
        // beginning with a stray `"`, and wrapping produced `""Virtual …` —
        // which reads as a rendering fault and makes a reader distrust a finding
        // that had just surfaced a real typo. The count leads instead, and the
        // renderers already delimit the value.
        ...sampleObserved(
          shared.map(([title, group]) => ({
            value: `${group.length} pages: ${title}`,
            observation_count: group.length,
            page_count: group.length,
            provenance: [],
          })),
        ),
      },
    ];
  },
};

export const PAGE_CHECKS: Check[] = [
  titleMissing,
  h1Missing,
  imageAltMissing,
  imageAltUseless,
  titleDuplicate,
  h1Multiple,
  langMissing,
];
