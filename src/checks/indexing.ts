/**
 * Group `indexing` — the signals disagree about whether to index a page.
 *
 * Stage 2 of `07`, and the group closest to what this tool already does. Every
 * check here is **two claims contradicting each other**, which is the same shape
 * as `entity.contradiction` pointed at indexation instead of entities:
 *
 *   - A sitemap entry is a request to index. A `404` is the page saying it does
 *     not exist. Both cannot be true.
 *   - A canonical is a claim about which URL is authoritative. One pointing at a
 *     redirect names a URL that disclaims itself.
 *
 * ## Everything here reads data the crawl already stored
 *
 * `redirect_chain`, `http_status`, `content_sha256` and `source` — which records
 * *which sitemap file* each URL came from — have been on the page record since
 * 1.0.0 and were read by nothing until now. No extraction change, no re-crawl.
 */

import type { PageRecord } from '../store/workdir.ts';
import { tryCanonicaliseUrl } from '../url/canonical.ts';
import { findingId, sampleObserved, type Check } from './framework.ts';

/** Did this URL come from a sitemap, and which one? Null when it did not. */
function sitemapOf(page: PageRecord): string | null {
  return page.source.startsWith('sitemap:') ? page.source.slice('sitemap:'.length) : null;
}

/** Compare URLs the way the rest of the tool does, so spelling is not a finding. */
function sameUrl(left: string, right: string): boolean {
  const a = tryCanonicaliseUrl(left);
  const b = tryCanonicaliseUrl(right);
  return a.ok && b.ok && a.url === b.url;
}

/**
 * Records keyed by the URL that was **requested**, not the one it landed on.
 *
 * The distinction is the whole correctness of the canonical checks, and getting
 * it wrong produced a clean-looking false positive on a corpus site. "Does the
 * canonical target redirect?" is a question about what happens when you request
 * that URL — so the record must be the one whose `url` is the target.
 *
 * Keying on `canonical_url` collides: several requests land on one destination,
 * and the map keeps whichever came last. One corpus site has both a `/login/`
 * page served directly and a members-only page that redirects to it — so both
 * records carry `canonical_url = /login/`. Looking up `/login/` returned the
 * *redirecting* record, and six pages were told their canonical redirects when
 * it does not.
 */
/**
 * One record per destination URL.
 *
 * Several requests can land on one page — `/checkout/` redirecting to
 * `/basket/` gives two records with one `canonical_url` — and a finding that
 * lists the same URL twice reads as a bug in the tool. Found by reading a real
 * report, where one URL appeared twice in three separate findings.
 */
export function dedupeByUrl(pages: readonly PageRecord[]): PageRecord[] {
  const seen = new Map<string, PageRecord>();
  for (const page of pages) if (!seen.has(page.canonical_url)) seen.set(page.canonical_url, page);
  return [...seen.values()];
}

function pageByRequestedUrl(pages: readonly PageRecord[]): Map<string, PageRecord> {
  const index = new Map<string, PageRecord>();
  for (const page of pages) {
    const requested = tryCanonicaliseUrl(page.url);
    if (requested.ok) index.set(requested.url, page);
  }
  return index;
}

// --- indexing.sitemap-dead-url ----------------------------------------------

/**
 * A sitemap lists a URL that does not resolve.
 *
 * A sitemap is a set of claims: *these URLs exist and are worth indexing*. A
 * 404 or 5xx is the server contradicting one of them, and every crawler that
 * follows the sitemap wastes a request discovering it.
 */
const sitemapDeadUrl: Check = {
  id: 'indexing.sitemap-dead-url',
  group: 'indexing',
  run({ pages }) {
    const dead = pages.filter(
      (page) =>
        sitemapOf(page) !== null &&
        page.http_status !== null &&
        (page.http_status >= 400 || page.http_status < 200),
    );
    if (dead.length === 0) return [];

    const byStatus = new Map<number, PageRecord[]>();
    for (const page of dead) {
      const status = page.http_status ?? 0;
      byStatus.set(status, [...(byStatus.get(status) ?? []), page]);
    }

    return [...byStatus.entries()].map(([status, affected]) => ({
      finding_id: findingId('indexing.sitemap-dead-url', String(status)),
      check: 'indexing.sitemap-dead-url',
      severity: 'error' as const,
      origin: 'check' as const,
      title: `${affected.length} sitemap URL(s) return ${status}`,
      subject: { kind: 'site' as const, id: `HTTP ${status}` },
      summary:
        `The sitemap lists ${affected.length} URL(s) that respond with ${status}. A sitemap is a ` +
        `claim that these pages exist and are worth indexing, and the server disagrees. Every ` +
        `crawler following the sitemap spends a request finding that out.`,
      expected: 'Every URL in a sitemap resolving to 200.',
      ...sampleObserved(
        affected.map((page) => ({
          value: page.canonical_url,
          observation_count: 1,
          page_count: 1,
          provenance: [],
        })),
      ),
      pages_affected: affected.length,
      coverage_qualified: false,
      remediation:
        'Remove them from the sitemap, or restore the pages. If the generator produces the ' +
        'sitemap, the stale entries usually mean its cache needs clearing.',
      tradeoff: null,
      pattern: `sitemap URL returning ${status}`,
      page_ids: affected.map((page) => page.page_id),
    }));
  },
};

// --- indexing.sitemap-redirects ----------------------------------------------

/**
 * A sitemap lists a URL that redirects.
 *
 * Not broken — the destination is reached — but the sitemap is naming a URL the
 * site itself does not consider authoritative, and it should name the
 * destination instead.
 */
const sitemapRedirects: Check = {
  id: 'indexing.sitemap-redirects',
  group: 'indexing',
  run({ pages }) {
    const redirected = pages.filter(
      (page) => sitemapOf(page) !== null && page.redirect_chain.length > 0,
    );
    if (redirected.length === 0) return [];

    return [
      {
        finding_id: findingId('indexing.sitemap-redirects', 'site'),
        check: 'indexing.sitemap-redirects',
        severity: 'warning',
        origin: 'check',
        title: `${redirected.length} sitemap URL(s) redirect elsewhere`,
        subject: { kind: 'site', id: 'sitemap' },
        summary:
          `${redirected.length} URL(s) in the sitemap redirect rather than serving a page. Nothing ` +
          `is broken and the destination is reached, but the sitemap is nominating a URL the site ` +
          `itself disclaims — so every crawler pays an extra request, and the sitemap disagrees ` +
          `with the redirect about which URL is the real one.`,
        expected: 'Sitemaps naming the destination URL directly.',
        ...sampleObserved(
          redirected.map((page) => ({
            value: `${page.url} → ${page.canonical_url}`,
            observation_count: 1,
            page_count: 1,
            provenance: [],
          })),
        ),
        pages_affected: redirected.length,
        coverage_qualified: false,
        remediation: 'Update the sitemap to list the destination URLs. Keep the redirects.',
        tradeoff: null,
        page_ids: redirected.map((page) => page.page_id),
      },
    ];
  },
};

// --- indexing.redirect-chain -------------------------------------------------

/** Two or more hops before a 200. Each one costs a request and loses a little signal. */
const redirectChain: Check = {
  id: 'indexing.redirect-chain',
  group: 'indexing',
  run({ pages }) {
    const chained = pages.filter((page) => page.redirect_chain.length >= 2);
    if (chained.length === 0) return [];

    return [
      {
        finding_id: findingId('indexing.redirect-chain', 'site'),
        check: 'indexing.redirect-chain',
        severity: 'opportunity',
        origin: 'check',
        title: `${chained.length} URL(s) redirect more than once`,
        subject: { kind: 'site', id: 'redirects' },
        summary:
          `${chained.length} URL(s) take two or more hops before returning a page. Each hop is a ` +
          `request, and chains are usually accidental — two migrations layered on each other, ` +
          `where the first rule was never repointed at the final destination.`,
        expected: 'One redirect, straight to the final URL.',
        ...sampleObserved(
          chained.map((page) => ({
            value: `${page.url} → ${page.redirect_chain.map((hop) => hop.location).join(' → ')}`,
            observation_count: page.redirect_chain.length,
            page_count: 1,
            provenance: [],
          })),
        ),
        pages_affected: chained.length,
        coverage_qualified: false,
        remediation: 'Repoint the first redirect at the final destination.',
        tradeoff: null,
        page_ids: chained.map((page) => page.page_id),
      },
    ];
  },
};

// --- indexing.canonical-to-redirect ------------------------------------------

/**
 * A canonical naming a URL that redirects.
 *
 * The canonical says "this URL is the authoritative one" and the URL it names
 * says "not me, over there". Two claims, directly opposed.
 */
const canonicalToRedirect: Check = {
  id: 'indexing.canonical-to-redirect',
  group: 'indexing',
  run({ pages }) {
    const index = pageByRequestedUrl(pages);
    const findings: { page: PageRecord; target: PageRecord }[] = [];

    for (const page of pages) {
      if (page.declared_canonical === null) continue;
      const declared = tryCanonicaliseUrl(page.declared_canonical);
      if (!declared.ok) continue;

      // Only a request made *to* that URL can tell us whether it redirects.
      const target = index.get(declared.url);
      if (target === undefined || target.page_id === page.page_id) continue;
      if (target.redirect_chain.length === 0) continue;

      findings.push({ page, target });
    }

    if (findings.length === 0) return [];

    return [
      {
        finding_id: findingId('indexing.canonical-to-redirect', 'site'),
        check: 'indexing.canonical-to-redirect',
        severity: 'warning',
        origin: 'check',
        title: `${findings.length} page(s) declare a canonical that redirects`,
        subject: { kind: 'site', id: 'canonical' },
        summary:
          `${findings.length} page(s) name a canonical URL which then redirects somewhere else. ` +
          `The canonical claims that URL is authoritative; the redirect says it is not. A consumer ` +
          `has to pick, and which one wins is not something you control.`,
        expected: 'A canonical pointing at a URL that serves a 200 directly.',
        ...sampleObserved(
          findings.map((hit) => ({
            value: `${hit.page.canonical_url} → canonical ${hit.page.declared_canonical ?? ''} → redirects`,
            observation_count: 1,
            page_count: 1,
            provenance: [],
          })),
        ),
        pages_affected: findings.length,
        coverage_qualified: false,
        remediation: 'Point the canonical at the redirect destination.',
        tradeoff: null,
        page_ids: findings.map((hit) => hit.page.page_id),
      },
    ];
  },
};

// --- indexing.canonical-chain ------------------------------------------------

/** A canonicals to B, and B canonicals to C. Google follows one hop, not two. */
const canonicalChain: Check = {
  id: 'indexing.canonical-chain',
  group: 'indexing',
  run({ pages }) {
    const index = pageByRequestedUrl(pages);
    const chains: { from: PageRecord; via: PageRecord; to: string }[] = [];

    for (const page of pages) {
      if (page.declared_canonical === null) continue;
      const declared = tryCanonicaliseUrl(page.declared_canonical);
      if (!declared.ok || sameUrl(page.canonical_url, page.declared_canonical)) continue;

      const via = index.get(declared.url);
      if (via === undefined || via.declared_canonical === null) continue;
      // B must point somewhere other than itself for this to be a chain.
      if (sameUrl(via.canonical_url, via.declared_canonical)) continue;

      chains.push({ from: page, via, to: via.declared_canonical });
    }

    if (chains.length === 0) return [];

    return [
      {
        finding_id: findingId('indexing.canonical-chain', 'site'),
        check: 'indexing.canonical-chain',
        severity: 'warning',
        origin: 'check',
        title: `${chains.length} canonical chain(s)`,
        subject: { kind: 'site', id: 'canonical' },
        summary:
          `${chains.length} page(s) declare a canonical which itself declares a different ` +
          `canonical. Consumers generally follow one hop, so the end of the chain may never be ` +
          `reached and which URL is treated as authoritative becomes unpredictable.`,
        expected: 'Every canonical pointing directly at the final authoritative URL.',
        ...sampleObserved(
          chains.map((chain) => ({
            value: `${chain.from.canonical_url} → ${chain.via.canonical_url} → ${chain.to}`,
            observation_count: 1,
            page_count: 1,
            provenance: [],
          })),
        ),
        pages_affected: chains.length,
        coverage_qualified: false,
        remediation: 'Point the first canonical at the end of the chain.',
        tradeoff: null,
        page_ids: chains.map((chain) => chain.from.page_id),
      },
    ];
  },
};

// --- indexing.duplicate-content ----------------------------------------------

/**
 * Two URLs serving byte-identical bodies.
 *
 * **Exact matches only, and the finding must say so.** `content_sha256` hashes
 * the response body, so two pages differing only in a highlighted nav item are
 * not equal here. It catches the real and common case — one page served at two
 * URLs — and silently misses near-duplicates.
 *
 * Claiming more than that would be exactly the overreach `04` exists to prevent.
 * Near-duplicate detection needs de-boilerplated text and a simhash, which
 * arrives with the `content` group (`07`, stage 3).
 */
const duplicateContent: Check = {
  id: 'indexing.duplicate-content',
  group: 'indexing',
  run({ pages }) {
    const byHash = new Map<string, PageRecord[]>();
    for (const page of pages) {
      if (page.content_sha256 === null || page.http_status !== 200) continue;
      // A page reached through a redirect is not a second URL serving the
      // content — it is a redirect, and `indexing.sitemap-redirects` reports it.
      // Counting it here billed the same defect twice.
      if (page.redirect_chain.length > 0) continue;
      byHash.set(page.content_sha256, [...(byHash.get(page.content_sha256) ?? []), page]);
    }

    const duplicated = [...byHash.entries()]
      .map(([hash, group]) => {
        // Distinct destinations only. Several records can share a
        // `canonical_url` — it is the URL *after* redirects — and a group that
        // collapses to one destination describes one page, not two.
        const seen = new Map<string, PageRecord>();
        for (const page of group)
          if (!seen.has(page.canonical_url)) seen.set(page.canonical_url, page);
        return [hash, [...seen.values()]] as const;
      })
      .filter(([, group]) => group.length > 1);
    if (duplicated.length === 0) return [];

    const affected = duplicated.reduce((sum, [, group]) => sum + group.length, 0);

    return [
      {
        finding_id: findingId('indexing.duplicate-content', 'site'),
        check: 'indexing.duplicate-content',
        severity: 'warning',
        origin: 'check',
        title: `${duplicated.length} page(s) are served at more than one URL`,
        subject: { kind: 'site', id: 'duplicate content' },
        summary:
          `${affected} URL(s) return byte-identical content, in ${duplicated.length} group(s). ` +
          `Indexing has to choose which URL represents the page, and anything you have said about ` +
          `one of them — links, canonicals, structured data — is split across the set.\n\n` +
          `**This compares whole responses, so it finds only exact duplicates.** Two pages ` +
          `differing by a single highlighted menu item are not reported here. Near-duplicate ` +
          `detection needs text extraction and is not built yet.`,
        expected: 'One URL per page, with the others redirecting or carrying a canonical.',
        ...sampleObserved(
          // The hash keys the group and is not shown: it identifies nothing an
          // operator can act on.
          duplicated.map(([, group]) => ({
            value: group.map((page) => page.canonical_url).join('  =  '),
            observation_count: group.length,
            page_count: group.length,
            provenance: [],
          })),
        ),
        pages_affected: affected,
        coverage_qualified: false,
        remediation:
          'Pick one URL per page. Redirect the others, or give them a canonical pointing at the ' +
          'one you kept.',
        tradeoff: null,
        page_ids: duplicated.flatMap(([, group]) => group.map((page) => page.page_id)),
      },
    ];
  },
};

// --- indexing.thin-sitemap-entry ---------------------------------------------

/**
 * Below this a page has essentially nothing of its own to index.
 *
 * Measured: 154 of 1,829 corpus sitemap pages fall under 25 words once site
 * boilerplate is removed — 8% — and reading them, they are carts, baskets,
 * account pages, wishlists, "no access" gates and thank-you pages.
 */
const THIN_SITEMAP_WORDS = 25;

/**
 * A sitemap entry for a page with no content of its own.
 *
 * A sitemap is a request to index. These pages have nothing to index: a cart, a
 * login gate, an account screen. Nothing is broken — they work fine — but every
 * crawler spends a request on them, and anything that does index them is
 * indexing furniture.
 *
 * ## Why this reports rather than decides
 *
 * **Word count cannot tell a cart from a contact page.** One corpus site's
 * `/contact-us/` carries five words and belongs in a sitemap absolutely; the
 * `/basket/` beside it carries eight and does not. So this lists what it found
 * and says which kinds usually belong out, rather than asserting a fix — the
 * same posture as `coverage.missing-expected-entity`, and for the same reason:
 * the tool cannot read the page and the operator can, in about four seconds.
 *
 * ## What it deliberately does not claim
 *
 * `07` planned a `low-value-archive` check keyed on "high link-to-text ratio".
 * **Measured, that signal does not exist**: on the corpus, a WooCommerce product
 * archive renders full descriptions and scores 0.00 links per word, while a
 * single product page scores 0.03. Archives look exactly like content pages by
 * every text measure available here, so this check does not pretend to find
 * them. A product archive with nothing unique on it still needs a human eye.
 */
const thinSitemapEntry: Check = {
  id: 'indexing.thin-sitemap-entry',
  group: 'indexing',
  run({ pages }) {
    const thin = pages.filter(
      (page) =>
        sitemapOf(page) !== null &&
        page.http_status === 200 &&
        page.redirect_chain.length === 0 &&
        page.page_facts !== null &&
        page.page_facts.text.extractable_words < THIN_SITEMAP_WORDS,
    );
    if (thin.length === 0) return [];

    return [
      {
        finding_id: findingId('indexing.thin-sitemap-entry', 'site'),
        check: 'indexing.thin-sitemap-entry',
        severity: 'opportunity',
        origin: 'check',
        title: `${thin.length} sitemap URL(s) have almost no content of their own`,
        subject: { kind: 'site', id: 'sitemap' },
        summary:
          `${thin.length} URL(s) listed in the sitemap carry fewer than ${THIN_SITEMAP_WORDS} words ` +
          `once site furniture is removed. A sitemap is a request to index, and these have little ` +
          `to index — carts, baskets, account screens, login gates and thank-you pages are the ` +
          `usual set. Nothing is broken; every crawler simply spends a request on each of them.\n\n` +
          `**Read the list before acting.** Word count cannot tell a cart from a contact page — a ` +
          `contact page is often a form and a phone number, and belongs in the sitemap. ` +
          `Transactional and account pages generally do not, and are usually better set to ` +
          `\`noindex\`.`,
        expected: null,
        ...sampleObserved(
          dedupeByUrl(thin).map((page) => ({
            value: page.canonical_url,
            detail: `${page.page_facts?.text.extractable_words ?? 0} words`,
            observation_count: 1,
            page_count: 1,
            provenance: [],
          })),
        ),
        pages_affected: dedupeByUrl(thin).length,
        coverage_qualified: false,
        remediation:
          'Remove the ones that are not meant to be found in search from the sitemap, and set them ' +
          'to noindex. Most SEO plugins have a per-post-type switch for exactly this.',
        tradeoff: null,
        page_ids: thin.map((page) => page.page_id),
      },
    ];
  },
};

export const INDEXING_CHECKS: Check[] = [
  thinSitemapEntry,
  sitemapDeadUrl,
  sitemapRedirects,
  redirectChain,
  canonicalToRedirect,
  canonicalChain,
  duplicateContent,
];
