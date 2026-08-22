/**
 * Group `breadcrumb` — the site as a tree.
 *
 * Assemble every `BreadcrumbList` into one hierarchy, then check the hierarchy.
 * Individually valid breadcrumbs can still describe an impossible site, which is
 * the whole reason this group exists: a per-page validator sees one trail at a
 * time and has nothing to disagree with.
 *
 * ## What the corpus actually contains
 *
 * Designed against a survey of all 22 crawled sites rather than the spec alone,
 * because three of the false-positive classes found so far were invisible until
 * a check met real markup. 18 sites carry breadcrumbs; 4,777 `ListItem`s in all.
 *
 * | Shape | Count | Consequence |
 * | --- | --- | --- |
 * | `item` as a literal string | 2,849 | the common case |
 * | `item` **absent** | 1,545 | see below — normal, never a finding |
 * | `item` as `{"@id": url}` | 383 | equally valid |
 * | `itemListElement` as a blank-node reference | 4,437 | must dereference |
 * | `itemListElement` as a named reference | 336 | must dereference |
 * | `position` as an integer | 4,777 | always; no string positions in the wild |
 *
 * **Every one of those 1,545 absent `item`s is the final crumb** — verified, 0
 * exceptions. That is the documented pattern (the last crumb is the current
 * page, so it needs no link), and a check that flagged it would fire on 18 of 18
 * sites and be switched off within a day. A missing `item` anywhere *else* is a
 * genuinely broken trail, and the corpus contains none.
 *
 * ## The tree
 *
 * Trails give parent→child edges. Assembled site-wide they answer questions no
 * single page can: does a URL have two different parents, does the tree loop,
 * does one URL sit at two depths.
 */

import type { ExtractedNode } from '../extract/types.ts';
import type { PageRecord } from '../store/workdir.ts';
import { tryCanonicaliseUrl } from '../url/canonical.ts';
import {
  findingId,
  indexPagesById,
  provenanceOf,
  sampleObserved,
  type Check,
  type CheckContext,
  type Finding,
  type Observed,
} from './framework.ts';
import type { EntityGraph } from './graph.ts';

const BREADCRUMB_LIST = 'http://schema.org/BreadcrumbList';
const ITEM_LIST_ELEMENT = 'http://schema.org/itemListElement';
const ITEM = 'http://schema.org/item';
const POSITION = 'http://schema.org/position';
const NAME = 'http://schema.org/name';
const URL_PROP = 'http://schema.org/url';

export interface Crumb {
  /** As published. Integer on every crumb in the corpus; null if absent. */
  position: number | null;
  /** Crumb text. A *label*, never the entity's name — `04` rule 4. */
  name: string | null;
  /** Canonicalised target. Null when the crumb carries no `item`. */
  url: string | null;
  node: ExtractedNode;
}

export interface Trail {
  /** The `BreadcrumbList` node itself, for provenance. */
  list: ExtractedNode;
  page_id: string;
  /** Sorted by `position`, with unpositioned crumbs left in document order at the end. */
  crumbs: Crumb[];
}

/**
 * Resolve one `itemListElement` value to the `ListItem` node it names.
 *
 * Both blank and named references appear in the corpus, and `@list` wrappers are
 * legal JSON-LD even though no corpus site emits one. An unresolvable reference
 * is dropped rather than guessed at.
 */
function resolveElements(value: unknown, graph: EntityGraph, into: ExtractedNode[]): void {
  if (Array.isArray(value)) {
    for (const entry of value) resolveElements(entry, graph, into);
    return;
  }
  if (value === null || typeof value !== 'object') return;

  const object = value as Record<string, unknown>;
  if (Array.isArray(object['@list'])) {
    for (const entry of object['@list']) resolveElements(entry, graph, into);
    return;
  }
  if (typeof object['@id'] !== 'string') return;

  const target = graph.index.get(object['@id']);
  if (target !== undefined) into.push(target);
}

/** First literal value of a property, trimmed. */
function literal(node: ExtractedNode, property: string): string | null {
  for (const value of node.props[property] ?? []) {
    if (value === null || typeof value !== 'object') continue;
    const object = value as Record<string, unknown>;
    if ('@value' in object) {
      const text = String(object['@value']).trim();
      return text === '' ? null : text;
    }
  }
  return null;
}

/**
 * The URL a crumb points at, canonicalised.
 *
 * `item` arrives three ways in the corpus — a literal string, a named `{"@id"}`,
 * and (in principle) a blank reference to a node carrying the real identity.
 * The last is the shape `04` rule 4 warns about: `{"@type": "ListItem", "item":
 * {"@id": "…/inkjet-paper/", "name": "Inkjet Paper"}}`, where the *node's* `@id`
 * is the target and its `name` is crumb text rather than the entity's name.
 */
function crumbUrl(node: ExtractedNode, graph: EntityGraph): string | null {
  const values = node.props[ITEM] ?? [];
  let raw: string | null = null;

  for (const value of values) {
    if (value === null || typeof value !== 'object') continue;
    const object = value as Record<string, unknown>;

    if (typeof object['@value'] === 'string') {
      raw = object['@value'];
      break;
    }
    if (typeof object['@id'] !== 'string') continue;

    const target = object['@id'];
    if (!target.startsWith('_:')) {
      raw = target;
      break;
    }
    // A blank reference names a node rather than a URL; its own `url` is the
    // only thing that can identify the resource.
    const inner = graph.index.get(target);
    if (inner === undefined) continue;
    const innerUrl = literal(inner, URL_PROP);
    if (innerUrl !== null) {
      raw = innerUrl;
      break;
    }
    for (const candidate of inner.props[URL_PROP] ?? []) {
      if (
        candidate !== null &&
        typeof candidate === 'object' &&
        typeof (candidate as Record<string, unknown>)['@id'] === 'string'
      ) {
        raw = String((candidate as Record<string, unknown>)['@id']);
        break;
      }
    }
    if (raw !== null) break;
  }

  if (raw === null) return null;
  const canonical = tryCanonicaliseUrl(raw);
  return canonical.ok ? canonical.url : null;
}

/** Every breadcrumb trail on the site, crumbs resolved and ordered. */
export function assembleTrails(graph: EntityGraph): Trail[] {
  const trails: Trail[] = [];

  // Every observation, not `index.values()`: that map is deduplicated by `@id`,
  // so a site emitting one sitewide `#breadcrumb` id would yield a single trail
  // however many pages carry one.
  for (const node of graph.allNodes) {
    if (!node.types.includes(BREADCRUMB_LIST)) continue;

    const elements: ExtractedNode[] = [];
    for (const value of node.props[ITEM_LIST_ELEMENT] ?? []) {
      resolveElements(value, graph, elements);
    }
    if (elements.length === 0) continue;

    const crumbs: Crumb[] = elements.map((element) => {
      const positionText = literal(element, POSITION);
      const position = positionText === null ? null : Number.parseInt(positionText, 10);
      return {
        position: position === null || Number.isNaN(position) ? null : position,
        name: literal(element, NAME),
        url: crumbUrl(element, graph),
        node: element,
      };
    });

    // Sort by published position. Crumbs without one keep document order at the
    // end rather than being discarded — the trail is still evidence.
    crumbs.sort((left, right) => {
      if (left.position === null && right.position === null) return 0;
      if (left.position === null) return 1;
      if (right.position === null) return -1;
      return left.position - right.position;
    });

    trails.push({ list: node, page_id: node.page_id, crumbs });
  }

  return trails;
}

/**
 * The URL a trail terminates at.
 *
 * The final crumb usually omits `item` because it is the current page, so the
 * page's own canonical URL stands in. Without this, every trail on every site
 * would look like it ended nowhere.
 */
function terminalUrl(trail: Trail, pages: Map<string, PageRecord>): string | null {
  const last = trail.crumbs[trail.crumbs.length - 1];
  if (last?.url != null) return last.url;

  const page = pages.get(trail.page_id);
  if (page === undefined) return null;
  const canonical = tryCanonicaliseUrl(page.canonical_url);
  return canonical.ok ? canonical.url : null;
}

/** Every crumb's URL in order, with the terminal filled in. Null entries dropped. */
function trailUrls(trail: Trail, pages: Map<string, PageRecord>): string[] {
  const terminal = terminalUrl(trail, pages);
  const urls: string[] = [];

  trail.crumbs.forEach((crumb, index) => {
    const isLast = index === trail.crumbs.length - 1;
    const url = crumb.url ?? (isLast ? terminal : null);
    if (url !== null) urls.push(url);
  });

  return urls;
}

interface TrailContext {
  trails: Trail[];
  pageIndex: Map<string, PageRecord>;
  /** Trail URL sequences, computed once — every check in the group wants them. */
  sequences: { trail: Trail; urls: string[] }[];
}

function trailContext(context: CheckContext): TrailContext {
  const pageIndex = indexPagesById(context.pages);
  const trails = assembleTrails(context.graph);
  return {
    trails,
    pageIndex,
    sequences: trails.map((trail) => ({ trail, urls: trailUrls(trail, pageIndex) })),
  };
}

/** Path-only display form. Full URLs make a trail unreadable in a terminal. */
function pathOf(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.pathname + parsed.search;
  } catch {
    return url;
  }
}

// --- breadcrumb.cycle --------------------------------------------------------

/**
 * A trail that loops.
 *
 * Two ways a site can express one, and both are reported here because both mean
 * the same thing to a consumer walking the tree:
 *
 *   - **Within a trail** — the same URL at two positions. `A > B > A`.
 *   - **Across trails** — the parent edges form a loop. Page A's trail says B is
 *     A's parent; page B's trail says A is B's. Neither trail is wrong alone.
 */
const cycle: Check = {
  id: 'breadcrumb.cycle',
  group: 'breadcrumb',
  run(context) {
    const { sequences, pageIndex } = trailContext(context);
    const findings: Finding[] = [];
    const reported = new Set<string>();

    for (const { trail, urls } of sequences) {
      const seen = new Set<string>();
      const repeated = urls.filter((url) => (seen.has(url) ? true : (seen.add(url), false)));
      if (repeated.length === 0) continue;

      const key = urls.join('>');
      if (reported.has(key)) continue;
      reported.add(key);

      findings.push({
        finding_id: findingId('breadcrumb.cycle', key),
        check: 'breadcrumb.cycle',
        severity: 'error',
        origin: 'check',
        title: 'A breadcrumb trail visits the same page twice',
        subject: { kind: 'page', id: pageIndex.get(trail.page_id)?.canonical_url ?? trail.page_id },
        summary:
          `This trail passes through ${repeated.map(pathOf).join(', ')} more than once: ` +
          `${urls.map(pathOf).join(' > ')}. A breadcrumb describes a path from the site root to this ` +
          `page, so it cannot revisit a page it has already passed through — anything walking the ` +
          `trail as a tree either loops or gives up.`,
        expected: 'Each page appearing at most once in a trail.',
        observed: [
          {
            value: urls.map(pathOf).join(' > '),
            observation_count: 1,
            page_count: 1,
            provenance: provenanceOf([trail.list], pageIndex),
          },
        ],
        pages_affected: 1,
        coverage_qualified: false,
        remediation:
          'Correct whichever crumb repeats — usually a parent category that also appears as an ancestor.',
        tradeoff: null,
        pattern: 'trail revisits a page',
        aggregate_title: 'breadcrumb trails visit the same page twice',
        page_ids: [trail.page_id],
      });
    }

    // The cross-trail form: follow parent edges and look for a loop.
    const parents = new Map<string, string>();
    for (const { urls } of sequences) {
      for (let index = 1; index < urls.length; index += 1) {
        const child = urls[index];
        const parent = urls[index - 1];
        if (child === undefined || parent === undefined || child === parent) continue;
        if (!parents.has(child)) parents.set(child, parent);
      }
    }

    const settled = new Set<string>();
    for (const start of parents.keys()) {
      if (settled.has(start)) continue;

      const path: string[] = [];
      const onPath = new Set<string>();
      let current: string | undefined = start;

      while (current !== undefined && !settled.has(current)) {
        if (onPath.has(current)) {
          const loop = [...path.slice(path.indexOf(current)), current];
          const key = [...loop].sort().join('|');
          if (!reported.has(key)) {
            reported.add(key);
            findings.push({
              finding_id: findingId('breadcrumb.cycle', key),
              check: 'breadcrumb.cycle',
              severity: 'error',
              origin: 'check',
              title: 'Breadcrumb parents form a loop across pages',
              subject: { kind: 'site', id: loop[0] ?? start },
              summary:
                `Following breadcrumb parents from ${pathOf(loop[0] ?? start)} leads back to where it ` +
                `started: ${loop.map(pathOf).join(' > ')}. No single trail is wrong, which is why a ` +
                `per-page validator passes all of them — but taken together they describe a site with ` +
                `no root, and nothing can walk it to the top.`,
              expected: 'Breadcrumb parents forming a tree, terminating at the site root.',
              observed: [
                {
                  value: loop.map(pathOf).join(' > '),
                  observation_count: loop.length,
                  page_count: loop.length,
                  provenance: [],
                },
              ],
              pages_affected: loop.length,
              coverage_qualified: false,
              remediation:
                'Decide which of these pages is the ancestor and correct the trail on the other(s).',
              tradeoff: null,
            });
          }
          break;
        }
        onPath.add(current);
        path.push(current);
        current = parents.get(current);
      }

      for (const url of path) settled.add(url);
    }

    return findings;
  },
};

// --- breadcrumb.multiple-parents ---------------------------------------------

/**
 * One URL, different parents.
 *
 * Two distinct root causes, distinguished because the fix differs completely and
 * `04` rule 5 says one root cause is one finding:
 *
 *   - **Competing trails on one page.** Two generators each emit a
 *     `BreadcrumbList` and they disagree. Found on one corpus site: 56 pages
 *     carry a themed trail (`Home > Shop > …`, `item` as a literal, names
 *     present) *and* a second unlabelled one rooted at `/shop` with `item` as
 *     `{"@id"}` and no `name` on any crumb. One plugin too many, one fix.
 *   - **Disagreement across pages.** Page A and page B place the same URL under
 *     different parents. That is a taxonomy problem, not a plugin problem.
 */
const multipleParents: Check = {
  id: 'breadcrumb.multiple-parents',
  group: 'breadcrumb',
  run(context) {
    const { sequences } = trailContext(context);
    const findings: Finding[] = [];

    // url -> parent url -> the pages asserting it
    const parentClaims = new Map<string, Map<string, Set<string>>>();
    // Pages carrying more than one trail, for the competing-generator case.
    const trailsPerPage = new Map<string, number>();

    for (const { trail, urls } of sequences) {
      trailsPerPage.set(trail.page_id, (trailsPerPage.get(trail.page_id) ?? 0) + 1);
      for (let index = 1; index < urls.length; index += 1) {
        const child = urls[index];
        const parent = urls[index - 1];
        if (child === undefined || parent === undefined || child === parent) continue;
        const byParent = parentClaims.get(child) ?? new Map<string, Set<string>>();
        const pages = byParent.get(parent) ?? new Set<string>();
        pages.add(trail.page_id);
        byParent.set(parent, pages);
        parentClaims.set(child, byParent);
      }
    }

    for (const [child, byParent] of parentClaims) {
      if (byParent.size < 2) continue;

      const claimPages = new Set<string>();
      for (const pages of byParent.values()) for (const page of pages) claimPages.add(page);

      // Did the disagreement arise on a single page carrying two trails, or
      // between pages? Same symptom, different cause, different remediation.
      const competing = [...claimPages].some((page) => (trailsPerPage.get(page) ?? 0) > 1);

      const observed: Observed[] = [...byParent.entries()]
        .sort(([, left], [, right]) => right.size - left.size)
        .map(([parent, pages]) => ({
          value: pathOf(parent),
          observation_count: pages.size,
          page_count: pages.size,
          provenance: [],
        }));

      findings.push({
        finding_id: findingId('breadcrumb.multiple-parents', child),
        check: 'breadcrumb.multiple-parents',
        severity: 'warning',
        origin: 'check',
        title: competing
          ? 'Two breadcrumb trails disagree about where this page sits'
          : 'One page is given different breadcrumb parents',
        subject: { kind: 'page', id: child },
        summary: competing
          ? `${pathOf(child)} is placed under ${byParent.size} different parents — ` +
            `${[...byParent.keys()].map(pathOf).join(' and ')} — by trails emitted on the same page. ` +
            `Two generators are each publishing a BreadcrumbList and they do not agree. Both are ` +
            `individually valid, so per-page validation passes them, but a consumer has no way to ` +
            `choose and the site's structure reads differently depending on which it takes.`
          : `${pathOf(child)} is placed under ${byParent.size} different parents — ` +
            `${[...byParent.keys()].map(pathOf).join(' and ')} — depending on which page's trail you ` +
            `read. A breadcrumb asserts where a page sits in the site, and these assertions conflict.`,
        expected:
          'One parent per page, asserted consistently wherever the page appears in a trail.',
        observed,
        pages_affected: claimPages.size,
        coverage_qualified: false,
        remediation: competing
          ? 'Disable breadcrumb output in one of the two plugins or themes emitting it.'
          : 'Pick the correct parent and make every trail that includes this page agree.',
        tradeoff: null,
        pattern: competing ? 'competing trails on one page' : 'parents disagree across pages',
        // "subjects", not "pages": the aggregate's own `pages_affected` is the
        // union across constituents and is routinely larger, so saying "pages"
        // here put two contradictory numbers in one finding.
        aggregate_title: competing
          ? 'subjects carry two breadcrumb trails that disagree'
          : 'subjects are given conflicting breadcrumb parents',
        page_ids: [...claimPages],
      });
    }

    return findings;
  },
};

// --- breadcrumb.broken-trail-item --------------------------------------------

/**
 * A crumb pointing at a page that is not there.
 *
 * **Reports non-200 only, and the deleted half is the interesting part.** `04`
 * specifies "non-200, *or absent from the crawl entirely*", and the second
 * clause turned out to be rule 3 wearing a disguise.
 *
 * Measured: it fired on 5 of 22 sites. On `headwall-hosting.com` it named four
 * targets — `/information/`, `/guides/`, `/plugins/`, `/a-web-guys-blog/` — and
 * none of them had **a single frontier entry**. The crawl was sitemap-driven: 47
 * URLs discovered, 47 queued, 47 fetched, `coverage.complete: true`. Those are
 * ordinary section landing pages that the sitemap does not list, so the crawler
 * never saw them and has no evidence either way.
 *
 * `coverage.complete` means "we fetched everything we discovered", **not** "we
 * saw every URL on the site". Reading it as the latter produced a confident
 * report that four live pages did not exist. An absence claim is only as good as
 * the coverage, and here the coverage could not support the claim at all — no
 * threshold or qualifier fixes that, so the variant is gone.
 *
 * What remains is purely observational: we fetched it, the server said no.
 *
 * Off-site crumbs are skipped for the same reason — we do not fetch other
 * people's hosts, so we know nothing about them.
 */
const brokenTrailItem: Check = {
  id: 'breadcrumb.broken-trail-item',
  group: 'breadcrumb',
  run(context) {
    const { sequences } = trailContext(context);
    const { siteHost } = context;

    const byUrl = new Map<string, PageRecord>();
    for (const page of context.pages) {
      const canonical = tryCanonicaliseUrl(page.canonical_url);
      if (canonical.ok) byUrl.set(canonical.url, page);
    }

    const broken = new Map<string, { status: number; pages: Set<string> }>();

    for (const { trail, urls } of sequences) {
      for (const url of urls) {
        let host: string;
        try {
          host = new URL(url).host;
        } catch {
          continue;
        }
        if (host !== siteHost) continue;

        // Never crawled is never a finding — see the note above.
        const page = byUrl.get(url);
        if (page === undefined || page.http_status === null || page.http_status === 200) continue;

        const record = broken.get(url) ?? { status: page.http_status, pages: new Set<string>() };
        record.pages.add(trail.page_id);
        broken.set(url, record);
      }
    }

    return [...broken.entries()].map(([url, record]) => ({
      finding_id: findingId('breadcrumb.broken-trail-item', url),
      check: 'breadcrumb.broken-trail-item',
      severity: 'warning' as const,
      origin: 'check' as const,
      title: `A breadcrumb links to a page returning ${record.status}`,
      subject: { kind: 'page' as const, id: url },
      summary:
        `${record.pages.size} breadcrumb trail(s) link to ${pathOf(url)}, which returned ` +
        `HTTP ${record.status} when crawled. The trail tells consumers this is an ancestor of the ` +
        `current page, and it cannot be reached.`,
      expected: 'Every crumb linking to a page that exists and returns 200.',
      observed: [
        {
          value: url,
          observation_count: record.pages.size,
          page_count: record.pages.size,
          provenance: [],
        },
      ],
      pages_affected: record.pages.size,
      coverage_qualified: false,
      remediation: 'Restore the page, or repoint the trail at one that exists.',
      tradeoff: null,
      pattern: `crumb target returns ${record.status}`,
      aggregate_title: 'breadcrumb targets return an error status',
      page_ids: [...record.pages],
    }));
  },
};

// --- breadcrumb.inconsistent-depth -------------------------------------------

/**
 * The same URL at different depths in different trails.
 *
 * Weaker than `multiple-parents` and deliberately an opportunity: a page
 * legitimately reachable by two routes will sit at two depths, and that is a
 * navigation choice rather than a defect. What it costs is a stable answer to
 * "how deep is this page", which is the thing breadcrumbs exist to convey.
 *
 * Suppressed wherever a louder check already explains the same thing (rule 5):
 *
 *   - **`multiple-parents`** — two parents put a page at two depths by
 *     definition, and that finding says why.
 *   - **`cycle`** — a trail that repeats a page necessarily lists it at two
 *     depths. One corpus site emits `/ > /blog/ > /blog/ > <post>` on 24
 *     pages, which showed up here as "/blog/ appears at depths 2 and 3". True,
 *     and a second bill for one problem.
 */
const inconsistentDepth: Check = {
  id: 'breadcrumb.inconsistent-depth',
  group: 'breadcrumb',
  run(context) {
    const { sequences } = trailContext(context);
    const findings: Finding[] = [];

    const depths = new Map<string, Map<number, Set<string>>>();
    const parents = new Map<string, Set<string>>();
    /** URLs `breadcrumb.cycle` is already reporting. */
    const repeatedInTrail = new Set<string>();

    for (const { trail, urls } of sequences) {
      const seenHere = new Set<string>();
      for (const url of urls) {
        if (seenHere.has(url)) repeatedInTrail.add(url);
        seenHere.add(url);
      }

      urls.forEach((url, index) => {
        const byDepth = depths.get(url) ?? new Map<number, Set<string>>();
        const pages = byDepth.get(index + 1) ?? new Set<string>();
        pages.add(trail.page_id);
        byDepth.set(index + 1, pages);
        depths.set(url, byDepth);

        const parent = index === 0 ? null : urls[index - 1];
        if (parent !== null && parent !== undefined && parent !== url) {
          const known = parents.get(url) ?? new Set<string>();
          known.add(parent);
          parents.set(url, known);
        }
      });
    }

    for (const [url, byDepth] of depths) {
      if (byDepth.size < 2) continue;
      // Already reported, with a better explanation, by a louder check.
      if ((parents.get(url)?.size ?? 0) > 1) continue;
      if (repeatedInTrail.has(url)) continue;

      const affected = new Set<string>();
      for (const pages of byDepth.values()) for (const page of pages) affected.add(page);

      const observed: Observed[] = [...byDepth.entries()]
        .sort(([left], [right]) => left - right)
        .map(([depth, pages]) => ({
          value: `depth ${depth}`,
          observation_count: pages.size,
          page_count: pages.size,
          provenance: [],
        }));

      findings.push({
        finding_id: findingId('breadcrumb.inconsistent-depth', url),
        check: 'breadcrumb.inconsistent-depth',
        severity: 'opportunity',
        origin: 'check',
        title: 'One page appears at different depths in different trails',
        subject: { kind: 'page', id: url },
        summary:
          `${pathOf(url)} appears at ${byDepth.size} different depths — ` +
          `${[...byDepth.keys()].sort((left, right) => left - right).join(' and ')} — across ` +
          `${affected.size} trail(s), while always keeping the same parent. Nothing is broken; a page ` +
          `reachable by two routes will do this. But breadcrumbs exist to tell a consumer how deep a ` +
          `page sits, and this site gives two answers.`,
        expected: null,
        observed,
        pages_affected: affected.size,
        coverage_qualified: false,
        remediation:
          'Emit one canonical trail per page, from the route you want treated as primary.',
        tradeoff:
          'A page genuinely reachable by several routes has no single true depth. Consistency helps ' +
          'consumers; matching the route the visitor actually took helps people. This tool cannot ' +
          'settle which matters more for your site.',
        pattern: 'page sits at more than one depth',
        aggregate_title: 'subjects appear at inconsistent breadcrumb depths',
        page_ids: [...affected],
      });
    }

    return findings;
  },
};

// --- breadcrumb.missing ------------------------------------------------------

/**
 * A page whose parent carries a breadcrumb but which carries none itself.
 *
 * Framed against the *tree we actually observed*, not against a guess: a page is
 * only reported when some other page's trail names it as a crumb, which means
 * the site itself asserts the page has a place in the hierarchy — and then the
 * page declines to say so. Deriving parents from URL path segments instead would
 * fire on every one-off page on the site.
 *
 * Gated on complete coverage (rule 3) and reported once for the whole site, not
 * once per page: this is a single generator setting on any site where it fires.
 */
const missing: Check = {
  id: 'breadcrumb.missing',
  group: 'breadcrumb',
  run(context) {
    const { sequences } = trailContext(context);
    if (context.partialCoverage) return [];

    const pagesWithTrail = new Set(sequences.map(({ trail }) => trail.page_id));
    if (pagesWithTrail.size === 0) return [];

    // Every URL some trail claims a place for, and the parent it claimed.
    const placed = new Map<string, string>();
    for (const { urls } of sequences) {
      for (let index = 1; index < urls.length; index += 1) {
        const child = urls[index];
        const parent = urls[index - 1];
        if (child !== undefined && parent !== undefined) placed.set(child, parent);
      }
    }

    const byUrl = new Map<string, PageRecord>();
    for (const page of context.pages) {
      const canonical = tryCanonicaliseUrl(page.canonical_url);
      if (canonical.ok) byUrl.set(canonical.url, page);
    }

    const silent: PageRecord[] = [];
    for (const [url, parentUrl] of placed) {
      const page = byUrl.get(url);
      if (page === undefined || page.http_status !== 200) continue;
      if (pagesWithTrail.has(page.page_id)) continue;
      // The parent must itself carry a trail, or this says nothing.
      const parentPage = byUrl.get(parentUrl);
      if (parentPage === undefined || !pagesWithTrail.has(parentPage.page_id)) continue;
      silent.push(page);
    }

    if (silent.length === 0) return [];

    return [
      {
        finding_id: findingId('breadcrumb.missing', 'site'),
        check: 'breadcrumb.missing',
        severity: 'opportunity',
        origin: 'check',
        title: `${silent.length} page(s) sit in the breadcrumb tree but publish no trail`,
        subject: { kind: 'site', id: 'site' },
        summary:
          `${silent.length} of ${context.pages.length} pages are named as a crumb in another page's ` +
          `breadcrumb trail — so the site asserts they have a place in the hierarchy — yet they ` +
          `publish no BreadcrumbList of their own. Their parents do. A consumer landing on one of ` +
          `these pages directly cannot tell where it sits.`,
        expected: 'A breadcrumb trail on every page that has a place in the hierarchy.',
        ...sampleObserved(
          silent.map((page) => ({
            value: pathOf(page.canonical_url),
            observation_count: 1,
            page_count: 1,
            provenance: [],
          })),
        ),
        pages_affected: silent.length,
        // False, and it cannot be otherwise: this check returns early when
        // coverage is partial, so a finding only exists on a complete crawl.
        // It said `true` until 2026-08-22, which rendered as "this finding
        // depends on pages that were not all fetched" beneath a summary table
        // reading "564 of 564 discovered" — two statements in one report that
        // could not both be true.
        coverage_qualified: false,
        remediation:
          'Most breadcrumb plugins emit trails per post type — check the types these pages use are enabled.',
        tradeoff: null,
        page_ids: silent.map((page) => page.page_id),
      },
    ];
  },
};

export const BREADCRUMB_CHECKS: Check[] = [
  cycle,
  multipleParents,
  brokenTrailItem,
  inconsistentDepth,
  missing,
];
