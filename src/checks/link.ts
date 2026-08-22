/**
 * Group `link` — the internal link graph disagrees with the sitemap.
 *
 * The last item in `07`'s build order, designed in `dev-notes/11`. Same shape
 * as every other group here: **two claims contradicting each other.** A sitemap
 * entry is a request to index a page. A link graph with no route to that page
 * is the site declining to point at it.
 *
 * ## Why this could not ship as a check on its own
 *
 * It needs the crawl to have followed one hop out of the sitemap, and until
 * 1.13.0 it did not. Measured on `headwall-hosting.com`: of eight pages with no
 * inbound link, five were real and three were posts on page 2 of a paginated
 * archive that no sitemap lists and nothing fetched. **37% false positives, and
 * no amount of narrowing the rule could have found them** — the evidence was
 * not on disk. Hence {@link CheckContext.linkHopRan} gating both checks to
 * silence rather than to a guess.
 *
 * ## Any inbound edge counts, including navigation
 *
 * `07` expected these to read content links only, on the grounds that a page
 * reachable solely from the footer is not meaningfully linked. That was
 * measured on a site averaging 376 links a page and **inverts on a small one**:
 * `headwall-hosting.com` is 85% chrome, and content-only reachability calls its
 * homepage, `/contact/` and `/about/` orphans. So the lens is any edge, and the
 * precision comes from `noindex` instead — which is the sharper signal anyway,
 * because it is a directive rather than a heuristic about templates.
 */

import { isSitemapPage, type PageRecord, type StoredLink } from '../store/workdir.ts';
import {
  findingId,
  sampleObserved,
  type CheckContext,
  type Check,
  type Finding,
} from './framework.ts';

/**
 * Inbound internal edges per page, excluding a page's link to itself.
 *
 * Self-links are not a rounding error, they are most of what an orphan has:
 * on the site this was designed against, every one of the eight candidates had
 * inbound edges, and all of them were comment permalinks and *"Cancel reply"*
 * pointing at the page they sit on. Counting those would have reported nothing
 * at all.
 */
function inboundBySource(
  links: readonly StoredLink[],
  pages: readonly PageRecord[],
): Map<string, Set<string>> {
  const idByUrl = new Map<string, string>();
  for (const page of pages) {
    idByUrl.set(page.canonical_url, page.page_id);
    idByUrl.set(page.url, page.page_id);
    for (const alias of page.aliases ?? []) idByUrl.set(alias.url, page.page_id);
  }

  const inbound = new Map<string, Set<string>>();
  for (const page of pages) inbound.set(page.page_id, new Set());

  for (const link of links) {
    if (!link.internal) continue;
    const target = idByUrl.get(link.to);
    if (target === undefined || target === link.from) continue;
    inbound.get(target)?.add(link.from);
  }

  return inbound;
}

/** Is this page asking not to be indexed? Null `page_facts` means we cannot say. */
function isNoIndex(page: PageRecord | undefined): boolean {
  return page?.page_facts?.robots?.index === false;
}

/**
 * Is the graph closed enough for an absence claim about it?
 *
 * Both checks here assert that something is **not** linked, and rule 3 of `04`
 * is that an absence claim is only as good as the coverage behind it. There are
 * two ways to be blind, and both are silence rather than a qualified finding.
 *
 * Both checks here assert that something is **not** linked, so every page that
 * could hold the disproving link has to have been fetched. Three ways to fall
 * short, all of them silence rather than a qualified finding.
 *
 * **1. The hop did not run** — a crawl older than 1.13.0, or `--no-link-hop`.
 * A page whose only inbound link sits on an unlisted archive is then
 * indistinguishable from a page nothing links to: 37% false positives on the
 * first real site measured.
 *
 * **2. The sitemap crawl was capped.** On a 564-URL site sampled at 100,
 * `link.orphan` reported nine pages "linked from nowhere on the site" — a claim
 * resting on 18% of it, with 464 sitemap URLs unfetched and any of them free to
 * disprove all nine. Spot-checked by hand and neither confirmable nor
 * refutable: **the tool could not know, and said so with a straight face.**
 *
 * **3. The hop itself was capped.** Found immediately after fixing 2, by the
 * same site at full sitemap coverage — which is exactly why the first two were
 * not enough. `coverage.complete` was true and `link.orphan` reported 29 pages,
 * while **205 unlisted URLs had been dropped by `--link-hop-pages`**. The
 * headline said the crawl was complete; the link graph was not.
 *
 * That number is also the correction to this group's original sizing
 * assumption. The unlisted set does **not** stay small on a large site: 21 URLs
 * on a 54-page site, and 832 on a 564-page one — `/product-tag/`, `/brand/` and
 * other taxonomy archives that a shop generates in bulk and lists in no
 * sitemap. It scales *faster* than the sitemap does.
 *
 * `disallowed` is deliberately **not** in the gate. A page robots.txt refuses
 * can never be fetched by anything, at any budget, so gating on it would
 * silence this group permanently on every site with a `Disallow` — which is
 * most of them. It is a residual risk, recorded here rather than hidden: a
 * disallowed page could hold the link, and its links carry little weight
 * anyway.
 *
 * **The other residual risk:** a page linked only from an unlisted page that is
 * itself only reachable from another unlisted page is two hops out and still
 * invisible. Closing that means becoming a general web crawler.
 */
function graphIsClosed(context: CheckContext): boolean {
  return context.linkHop !== null && context.linkHop.dropped === 0 && !context.partialCoverage;
}

const orphan: Check = {
  id: 'link.orphan',
  group: 'link',
  run(context) {
    if (!graphIsClosed(context)) return [];

    // `allPages`, because a link *from* a hop page is exactly what stops a page
    // being an orphan. Only the subjects are drawn from the sitemap.
    const inbound = inboundBySource(context.links, context.allPages);
    const stranded = context.allPages
      .filter(isSitemapPage)
      .filter((page) => (inbound.get(page.page_id)?.size ?? 0) === 0);

    if (stranded.length === 0) return [];

    return [
      {
        finding_id: findingId('link.orphan', 'site'),
        check: 'link.orphan',
        severity: 'warning',
        origin: 'check',
        title: `${stranded.length} sitemap page(s) are linked from nowhere on the site`,
        subject: { kind: 'site', id: context.siteHost },
        summary:
          `${stranded.length} page(s) are listed in a sitemap and nothing links to them: not the ` +
          `sitemap pages, and not the unlisted pages those link out to. The sitemap asks for them ` +
          `to be indexed; the site never points at them, so they receive nothing from the pages ` +
          `around them and a visitor cannot reach them by browsing. Links a page makes to itself do ` +
          `not count, which is what most of these have.\n\n` +
          `**The crawl follows one hop off the sitemap, so that is how far this looked.** A page ` +
          `linked only from somewhere two hops out would not be seen — rare, and worth knowing ` +
          `before you delete anything.`,
        expected: 'Every page worth listing in a sitemap is reachable by following links.',
        ...sampleObserved(
          stranded.map((page) => ({
            value: page.canonical_url,
            observation_count: 1,
            page_count: 1,
            provenance: [],
          })),
        ),
        pages_affected: stranded.length,
        // Always false here: `graphIsClosed` refuses to run on a capped crawl,
        // so a finding that exists is not qualified by coverage — it is the
        // whole-sitemap answer.
        coverage_qualified: false,
        remediation:
          'Link to them from a page that covers the section, or drop them from the sitemap if ' +
          'they are not meant to be found.',
        tradeoff: null,
        page_ids: stranded.map((page) => page.page_id),
      },
    ];
  },
};

/**
 * The finding this whole milestone was built for.
 *
 * A `noindex, follow` section index is a normal, correct thing for an SEO
 * plugin to produce — and it quietly becomes the only route to everything under
 * it. Google has said it eventually treats a long-lived `noindex, follow` as
 * `noindex, nofollow`, so those pages end up cut off from internal signal while
 * looking perfect in every per-page tool. Nothing that reads one page at a time
 * can see this, which is what makes it worth a check here rather than
 * elsewhere.
 */
const noIndexOnlyInbound: Check = {
  id: 'link.noindex-only-inbound',
  group: 'link',
  run(context) {
    if (!graphIsClosed(context)) return [];

    // `allPages` throughout: the hub whose `noindex` is the entire finding is a
    // hop page, so reading the audited sample here would find nothing at all.
    const byId = new Map(context.allPages.map((page) => [page.page_id, page]));
    const inbound = inboundBySource(context.links, context.allPages);

    const cutOff = context.allPages.filter((page) => {
      if (!isSitemapPage(page)) return false;
      if (isNoIndex(page)) return false; // Its own request not to be indexed wins.
      const sources = inbound.get(page.page_id);
      if (sources === undefined || sources.size === 0) return false; // `link.orphan`'s.
      return [...sources].every((from) => isNoIndex(byId.get(from)));
    });

    if (cutOff.length === 0) return [];

    const findings: Finding[] = [];
    for (const page of cutOff) {
      const sources = [...(inbound.get(page.page_id) ?? [])]
        .map((from) => byId.get(from)?.canonical_url ?? from)
        .sort();

      findings.push({
        finding_id: findingId('link.noindex-only-inbound', page.canonical_url),
        check: 'link.noindex-only-inbound',
        severity: 'warning',
        origin: 'check',
        title: 'Reachable only from pages that ask not to be indexed',
        subject: { kind: 'page', id: page.canonical_url },
        summary:
          `This page is in a sitemap, so the site is asking for it to be indexed, but the only ` +
          `internal links to it are on ${sources.length} page(s) carrying noindex. Search engines ` +
          `treat a long-lived "noindex, follow" as eventually not following either, which leaves ` +
          `this page listed for indexing and cut off from every page that could support it.`,
        expected: 'At least one indexable page links to it.',
        ...sampleObserved(
          sources.map((url) => ({
            value: url,
            detail: 'noindex',
            observation_count: 1,
            page_count: 1,
            provenance: [],
          })),
        ),
        pages_affected: 1,
        // Always false here: `graphIsClosed` refuses to run on a capped crawl,
        // so a finding that exists is not qualified by coverage — it is the
        // whole-sitemap answer.
        coverage_qualified: false,
        remediation:
          'Link to it from an indexable page — the section it belongs to, or a related page. ' +
          'Alternatively, if the hub really should be indexable, remove its noindex.',
        tradeoff:
          'Only the link matters here, not the noindex. A section index, tag archive or ' +
          'paginated listing set to noindex is usually a deliberate, correct decision, and this ' +
          'check is not asking you to reverse it.',
        pattern: 'link.noindex-only-inbound',
        // Lowercase and plural, because `aggregate()` renders it as
        // `${count} ${aggregate_title}`. This read "6 Sitemap page reachable
        // only from noindex pages" on a real report.
        aggregate_title: 'sitemap pages reachable only from a noindex page',
        page_ids: [page.page_id],
      });
    }

    return findings;
  },
};

export const LINK_CHECKS: Check[] = [orphan, noIndexOnlyInbound];
