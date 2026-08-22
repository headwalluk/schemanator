/**
 * The remaining `entity`, `graph`, `url` and `coverage` checks.
 *
 * Grouped in one module because each is small and none warrants a file. They
 * share nothing but the framework; the `04` group they belong to is on each
 * check's `group` field, which is what the report and `--disable-group` use.
 *
 * Every threshold here was chosen against the 22-site corpus rather than by
 * taste, and the measurements are recorded next to the check that uses them.
 */

import type { ExtractedNode } from '../extract/types.ts';
import type { PageRecord } from '../store/workdir.ts';
import { tryCanonicaliseUrl } from '../url/canonical.ts';
import { isFunctional } from './cardinality.ts';
import {
  findingId,
  indexPagesById,
  provenanceOf,
  sampleObserved,
  type Check,
  type Finding,
} from './framework.ts';
import { denote, shortIri } from './graph.ts';
import { bareTypeName, closure } from './hierarchy.ts';

const NAME = 'http://schema.org/name';
const LOGO = 'http://schema.org/logo';
const SAME_AS = 'http://schema.org/sameAs';

// --- entity.multi-value ------------------------------------------------------

/**
 * Two values for a single-valued property, on **one** page.
 *
 * Distinct from `entity.contradiction`, which is the cross-page form: this one
 * is visible in a single document and validator.schema.org passes it anyway,
 * because schema.org permits any property to repeat. The functional list is our
 * judgement, and it is the same list both checks depend on.
 *
 * *Zero instances across the 22-site corpus.* Unit-tested only, and therefore
 * untriggered rather than validated — recorded as a known risk in the tracker.
 */
const multiValue: Check = {
  id: 'entity.multi-value',
  group: 'entity',
  run({ graph, pages, rules }) {
    const pageIndex = indexPagesById(pages);
    const findings: Finding[] = [];

    for (const node of graph.allNodes) {
      for (const [property, values] of Object.entries(node.props)) {
        if (values.length < 2 || !isFunctional(property, rules)) continue;

        // Compare what the values denote. Two byte-different spellings of the
        // same blank node are one value, not two (`04` rule 6).
        const distinct = new Set(values.map((value) => JSON.stringify(denote(value, graph))));
        if (distinct.size < 2) continue;

        const short = shortIri(property);
        findings.push({
          finding_id: findingId('entity.multi-value', `${node.node_id}|${property}`),
          check: 'entity.multi-value',
          severity: 'warning',
          origin: 'check',
          title: `${short} carries ${distinct.size} values on one page`,
          subject: { kind: 'entity', id: node.node_id, property },
          summary:
            `This entity publishes ${distinct.size} values for ${short} in a single block. ` +
            `schema.org permits any property to repeat, so a per-page validator passes this — but ` +
            `${short} identifies the entity, and two answers on one page leave a consumer to pick.`,
          expected: `One ${short} per entity.`,
          ...sampleObserved(
            [...distinct].map((value) => ({
              value,
              observation_count: 1,
              page_count: 1,
              provenance: provenanceOf([node], pageIndex),
            })),
          ),
          pages_affected: 1,
          coverage_qualified: false,
          remediation: `Emit a single ${short}, or use a property that is genuinely multi-valued.`,
          tradeoff: null,
          pattern: property,
          page_ids: [node.page_id],
        });
      }
    }

    return findings;
  },
};

// --- graph.relative-id -------------------------------------------------------

/**
 * An entity published under a **fragment-only** `@id`.
 *
 * `"@id": "#organization"` resolves against the page URL, so the same markup on
 * 150 pages declares 150 distinct entities and nothing can merge them. That is
 * the failure `00` calls "the trap that bites hardest".
 *
 * **Root-relative is not the same thing and must not be reported.** The corpus
 * contains 56 nodes with a relative `@id`, every one of them `"/shop"` on a
 * single site. A root-relative path resolves to the *same* absolute IRI
 * on every page, so no fracture occurs and there is nothing to fix. Only a
 * fragment-only id — or one with no path at all — varies by the page it sits on.
 *
 * One finding covers all N pages, never N findings (`00`, amendment C).
 */
const relativeId: Check = {
  id: 'graph.relative-id',
  group: 'graph',
  run({ graph, pages }) {
    const pageIndex = indexPagesById(pages);
    const byRawId = new Map<string, ExtractedNode[]>();

    for (const node of graph.allNodes) {
      const raw = node.raw_id;
      if (raw === null || !raw.startsWith('#')) continue;
      byRawId.set(raw, [...(byRawId.get(raw) ?? []), node]);
    }

    return [...byRawId.entries()].map(([raw, nodes]) => {
      const pageIds = new Set(nodes.map((node) => node.page_id));
      const resolved = new Set(nodes.map((node) => node.node_id));
      return {
        finding_id: findingId('graph.relative-id', raw),
        check: 'graph.relative-id',
        severity: 'warning' as const,
        origin: 'check' as const,
        title: `@id "${raw}" resolves to a different entity on every page`,
        subject: { kind: 'entity' as const, id: raw },
        summary:
          `This entity is published with the fragment-only @id "${raw}" on ${pageIds.size} page(s). ` +
          `A fragment resolves against the page it appears on, so the same markup declares ` +
          `${resolved.size} distinct entities rather than one, and nothing downstream can merge them. ` +
          `Every page looks correct on its own, which is why this survives per-page validation.`,
        expected: `An absolute @id — one IRI naming this entity, identical on every page.`,
        ...sampleObserved(
          [...resolved].map((id) => ({
            value: id,
            observation_count: 1,
            page_count: 1,
            provenance: provenanceOf(
              nodes.filter((node) => node.node_id === id),
              pageIndex,
            ),
          })),
        ),
        pages_affected: pageIds.size,
        coverage_qualified: false,
        remediation: `Publish an absolute @id, for example https://<your site>/${raw}.`,
        tradeoff: null,
        page_ids: [...pageIds],
      };
    });
  },
};

// --- graph.orphan-node -------------------------------------------------------

/**
 * A node defined, never referenced, and incapable of standing alone.
 *
 * **`04` predicted "low confidence, high noise risk" and understated it.** The
 * check took three passes against the corpus to become trustworthy, and every
 * false-positive class was invisible from reading the code:
 *
 * 1. **The obvious rule fires 1,480 times and is wrong every time.**
 *    "Unreferenced and not a page-root type" flags `Article` (492),
 *    `NewsArticle` (275), `Product` (245), `Event` (200) — page *subjects*.
 *    Nothing links to them precisely because they are what the page is about.
 * 2. **`graph.referenced` is the wrong set.** It deliberately excludes
 *    url-valued properties, because counting them raised 38 false dangling
 *    references. Reusing it here reported every `potentialAction.target`
 *    `EntryPoint` as an orphan — 150 on one site — when each is referenced
 *    perfectly well. Orphan detection needs "referenced from anywhere at all",
 *    which is the opposite question, so it builds its own set.
 * 3. **`BreadcrumbList` is a page-root type** — `04` says so explicitly — but it
 *    sits under `ItemList → Intangible`, so no closure rule excludes it.
 *
 * The surviving rule asks the only question that separates dead markup from a
 * page subject: **can this node mean anything on its own?** A `PostalAddress`
 * nobody references is dead markup. An `Article`, a `Service` or a `Product`
 * nobody references is the page. Structured values — addresses, geo
 * coordinates, opening hours, offers, ratings — cannot stand alone by
 * construction, and that is exactly the set worth reporting.
 *
 * Narrowed this way the check finds **nothing** across all 22 sites. That is the
 * honest outcome: correct and untriggered beats noisy and wrong, and `04` now
 * records the evidence so nobody re-widens it without reading this first.
 */

/** Types that are the page, not part of it. `04` names the first three. */
const PAGE_ROOT_TYPES = new Set(['WebPage', 'WebSite', 'BreadcrumbList']);

/**
 * Only these are reportable. Each is meaningless unless something points at it.
 *
 * `StructuredValue` covers `PostalAddress`, `GeoCoordinates`,
 * `OpeningHoursSpecification`, `QuantitativeValue` and `MonetaryAmount`; the
 * other two are the same shape without the shared ancestor.
 */
const DEPENDENT_ANCESTORS = ['StructuredValue', 'Offer', 'Rating'];

const orphanNode: Check = {
  id: 'graph.orphan-node',
  group: 'graph',
  run({ graph, pages, hierarchy, partialCoverage }) {
    const pageIndex = indexPagesById(pages);
    const byType = new Map<string, ExtractedNode[]>();

    for (const node of graph.allNodes) {
      if (node.types.length === 0 || Object.keys(node.props).length === 0) continue;
      if (graph.referencedAnywhere.has(node.node_id)) continue;

      const bare = node.types.map(bareTypeName);
      if (bare.some((type) => PAGE_ROOT_TYPES.has(type))) continue;

      const ancestors = closure(node.types, hierarchy);
      if (!DEPENDENT_ANCESTORS.some((type) => ancestors.has(type))) continue;

      const key = bare.sort().join(', ');
      byType.set(key, [...(byType.get(key) ?? []), node]);
    }

    return [...byType.entries()].map(([types, nodes]) => {
      const pageIds = new Set(nodes.map((node) => node.page_id));
      return {
        finding_id: findingId('graph.orphan-node', types),
        check: 'graph.orphan-node',
        severity: 'opportunity' as const,
        origin: 'check' as const,
        title: `${types} published but referenced by nothing`,
        subject: { kind: 'site' as const, id: types },
        summary:
          `${nodes.length} ${types} node(s) across ${pageIds.size} page(s) are defined but never ` +
          `referenced by any other node. A ${types} only means something as part of another entity — ` +
          `unlike an Article or a Product, it cannot be what a page is about — so nothing consumes ` +
          `these and they add weight without adding meaning.`,
        expected: `Every ${types} referenced by the entity it belongs to.`,
        ...sampleObserved(
          nodes.map((node) => ({
            value: node.node_id,
            observation_count: 1,
            page_count: 1,
            provenance: provenanceOf([node], pageIndex),
          })),
        ),
        pages_affected: pageIds.size,
        coverage_qualified: partialCoverage,
        remediation: `Reference it from the entity it describes, or stop emitting it.`,
        tradeoff: null,
        pattern: 'defined but never referenced',
        aggregate_title: 'node types are published but referenced by nothing',
        page_ids: [...pageIds],
      };
    });
  },
};

// --- graph.blank-node-entity -------------------------------------------------

/**
 * A substantial entity published with no `@id` at all.
 *
 * Nothing can reference it and nothing can merge it, so N pages publishing "the
 * same" author or organisation publish N anonymous entities as far as any
 * consumer is concerned. That is precisely the whole-site failure this tool
 * exists to surface, and it is invisible per page: each document is valid.
 *
 * *Corpus evidence: 605 instances — 302 `Person`, 286 `Organization`, 17
 * `Product`/`SoftwareApplication`.* Reported once per type rather than once per
 * node (rule 5): it is one generator setting, however many pages it touches.
 */
const SUBSTANTIAL_ANCESTORS = ['Organization', 'Person', 'Product'];

const blankNodeEntity: Check = {
  id: 'graph.blank-node-entity',
  group: 'graph',
  run({ graph, hierarchy }) {
    const byType = new Map<string, ExtractedNode[]>();

    for (const node of graph.allNodes) {
      if (!node.is_blank || Object.keys(node.props).length === 0) continue;

      const ancestors = closure(node.types, hierarchy);
      if (!SUBSTANTIAL_ANCESTORS.some((type) => ancestors.has(type))) continue;

      const key = node.types.map(bareTypeName).sort().join(', ');
      byType.set(key, [...(byType.get(key) ?? []), node]);
    }

    return [...byType.entries()].map(([types, nodes]) => {
      const pageIds = new Set(nodes.map((node) => node.page_id));
      const names = new Set(
        nodes.flatMap((node) =>
          (node.props[NAME] ?? [])
            .map((value) =>
              value !== null && typeof value === 'object' && '@value' in value
                ? String(value['@value']).trim()
                : null,
            )
            .filter((value): value is string => value !== null && value !== ''),
        ),
      );

      return {
        finding_id: findingId('graph.blank-node-entity', types),
        check: 'graph.blank-node-entity',
        severity: 'opportunity' as const,
        origin: 'check' as const,
        title: `${nodes.length} ${types} entities are published with no @id`,
        subject: { kind: 'site' as const, id: types },
        summary:
          `${nodes.length} ${types} node(s) across ${pageIds.size} page(s) carry no @id. Without one ` +
          `nothing can reference them and nothing can merge them, so ` +
          `${names.size === 1 ? `what is almost certainly one ${types} — "${[...names][0]}" — ` : `these `}` +
          `appear to a consumer as ${nodes.length} separate anonymous entities. Each page is valid ` +
          `on its own; the loss only shows when you look at the site as a whole.`,
        expected: `A stable @id on every ${types}, identical wherever it appears.`,
        // These are distinct *names*, not pages. Claiming "on 1 page(s)" beside
        // a finding that says 28 invites the reader to distrust the count; zero
        // renders as no claim at all, which is the honest reading.
        ...sampleObserved(
          [...names].map((name) => ({
            value: name,
            observation_count: 1,
            page_count: 0,
            provenance: [],
          })),
        ),
        pages_affected: pageIds.size,
        coverage_qualified: false,
        remediation:
          `Give each ${types} an absolute @id and reference it, rather than repeating the whole ` +
          `entity inline on every page.`,
        tradeoff: null,
        pattern: 'substantial entity with no @id',
        aggregate_title: 'entity types are published with no @id',
        page_ids: [...pageIds],
      };
    });
  },
};

// --- url.trailing-slash-drift ------------------------------------------------

/**
 * Both `/foo` and `/foo/` published for the same resource.
 *
 * Canonicalisation deliberately does **not** normalise this (`02`) precisely so
 * this check can see it: to a consumer doing string comparison they are two
 * different IRIs, so an entity referenced both ways forks in two.
 */
const trailingSlashDrift: Check = {
  id: 'url.trailing-slash-drift',
  group: 'url',
  run({ graph }) {
    const seen = new Map<string, Set<string>>();

    const record = (text: string): void => {
      const canonical = tryCanonicaliseUrl(text);
      if (!canonical.ok) return;
      let parsed: URL;
      try {
        parsed = new URL(canonical.url);
      } catch {
        return;
      }
      // The root path is `/` and has no slashless spelling; skip it.
      if (parsed.pathname === '/' || parsed.pathname === '') return;

      const stripped = parsed.pathname.replace(/\/+$/, '');
      const key = `${parsed.protocol}//${parsed.host}${stripped}${parsed.search}`;
      const variants = seen.get(key) ?? new Set<string>();
      variants.add(canonical.url);
      seen.set(key, variants);
    };

    for (const node of graph.allNodes) {
      if (!node.node_id.startsWith('_:')) record(node.node_id);
      for (const values of Object.values(node.props)) {
        for (const value of values) {
          if (value === null || typeof value !== 'object') continue;
          const object = value as Record<string, unknown>;
          if (typeof object['@id'] === 'string' && !object['@id'].startsWith('_:')) {
            record(object['@id']);
          }
        }
      }
    }

    const drifted = [...seen.entries()].filter(([, variants]) => variants.size > 1);
    if (drifted.length === 0) return [];

    const observed = sampleObserved(
      drifted.map(([, variants]) => ({
        value: [...variants].join('  vs  '),
        observation_count: variants.size,
        page_count: 0,
        provenance: [],
      })),
    );

    return [
      {
        finding_id: findingId('url.trailing-slash-drift', 'site'),
        check: 'url.trailing-slash-drift',
        severity: 'opportunity',
        origin: 'check',
        title: `${drifted.length} URL(s) published both with and without a trailing slash`,
        subject: { kind: 'site', id: 'site' },
        summary:
          `${drifted.length} resource(s) appear in the graph under both spellings. These are ` +
          `different IRIs, so anything comparing them as strings — which is what consumers do — sees ` +
          `two resources where you meant one. Nothing is broken and no page is wrong; the identity is ` +
          `just split between two spellings.`,
        expected: 'One spelling per resource, matching whichever form the site serves.',
        ...observed,
        pages_affected: 0,
        coverage_qualified: false,
        remediation:
          'Pick the form your site actually serves and emit it everywhere, including in @id values.',
        tradeoff: null,
      },
    ];
  },
};

// --- coverage.type-gap -------------------------------------------------------

/**
 * A URL pattern where most pages carry a type and a minority do not.
 *
 * *"55 product pages, 3 have no `Product`."* The pattern is the first path
 * segment, which on every corpus site corresponds to a post type or taxonomy
 * (`/product/`, `/blog/`, `/product-category/`).
 *
 * Two thresholds, both answering `04`'s open question 5 — "too low and every
 * unique page is a finding":
 *
 *   - **Minimum group size 10.** Below that a "minority" is one or two pages and
 *     the pattern is not established enough to call anything a gap.
 *   - **Majority share 80%.** The type has to be the clear norm for the group
 *     before its absence reads as an omission rather than a mix.
 *
 * **And only types that describe what a page is *about*.** The first shakedown
 * ran without that restriction and produced 15 findings across 4 sites, most of
 * them meaningless: *"1 of 25 /vulnerability-writeups/ pages carry no `Thing`"*,
 * *"2 of 32 /features/ pages carry no `CommentAction`"*, *"1 of 25 … carry no
 * `WebPage`"*. Actions and page-structural types are emitted by the generator
 * for its own reasons and vary for reasons that have nothing to do with the
 * page's subject. Restricting to subject types cut it to the findings a person
 * would actually act on — a `/shop/` page with no `Offer`, a post with no
 * `BlogPosting`.
 *
 * Gated on complete coverage (rule 3): under a truncated crawl the pages missing
 * the type may simply be ones we never fetched, and the finding would be an
 * artefact of sampling.
 */
const TYPE_GAP_MIN_GROUP = 10;
const TYPE_GAP_MAJORITY = 0.8;

/**
 * Types whose absence is worth reporting: the ones that say what a page is
 * about. The inverse of `graph.orphan-node`'s question, and for the same reason.
 */
const SUBJECT_ANCESTORS = [
  'CreativeWork',
  'Product',
  'Event',
  'Organization',
  'Person',
  'Place',
  'Service',
  'Offer',
];

/** Emitted by the generator about the page itself, not about its subject. */
const NON_SUBJECT_TYPES = new Set([
  'Thing',
  'WebPage',
  'WebSite',
  'BreadcrumbList',
  'CollectionPage',
  'ItemPage',
  'SearchResultsPage',
  'ProfilePage',
  'ImageObject',
  'ListItem',
]);

function isSubjectType(type: string, hierarchy: Parameters<typeof closure>[1]): boolean {
  if (NON_SUBJECT_TYPES.has(type)) return false;
  const ancestors = closure([type], hierarchy);
  // Actions describe what can be done with a page, never what it is.
  if (ancestors.has('Action')) return false;
  return SUBJECT_ANCESTORS.some((ancestor) => ancestors.has(ancestor));
}

const typeGap: Check = {
  id: 'coverage.type-gap',
  group: 'coverage',
  run({ graph, pages, hierarchy, partialCoverage }) {
    if (partialCoverage) return [];

    const typesByPage = new Map<string, Set<string>>();
    for (const node of graph.allNodes) {
      const types = typesByPage.get(node.page_id) ?? new Set<string>();
      for (const type of node.types) types.add(bareTypeName(type));
      typesByPage.set(node.page_id, types);
    }

    // Group by first path segment.
    const groups = new Map<string, PageRecord[]>();
    for (const page of pages) {
      if (page.http_status !== 200) continue;
      let parts: string[];
      try {
        parts = new URL(page.canonical_url).pathname.split('/').filter(Boolean);
      } catch {
        continue;
      }
      const segment = parts[0] ?? '';
      if (segment === '') continue;
      // The section's own index page is not a member of the section. `/shop/`
      // is not a product, and `/vulnerability-writeups/` is not a writeup —
      // both were reported as gaps in the first shakedown, and both are just
      // archive pages doing their job.
      if (parts.length === 1) continue;
      groups.set(segment, [...(groups.get(segment) ?? []), page]);
    }

    const findings: Finding[] = [];

    for (const [segment, members] of groups) {
      if (members.length < TYPE_GAP_MIN_GROUP) continue;

      const counts = new Map<string, PageRecord[]>();
      for (const page of members) {
        for (const type of typesByPage.get(page.page_id) ?? []) {
          counts.set(type, [...(counts.get(type) ?? []), page]);
        }
      }

      for (const [type, carrying] of counts) {
        if (!isSubjectType(type, hierarchy)) continue;
        const share = carrying.length / members.length;
        if (share < TYPE_GAP_MAJORITY || share >= 1) continue;

        const carryingIds = new Set(carrying.map((page) => page.page_id));
        const gap = members.filter((page) => !carryingIds.has(page.page_id));

        findings.push({
          finding_id: findingId('coverage.type-gap', `${segment}|${type}`),
          check: 'coverage.type-gap',
          severity: 'opportunity',
          origin: 'check',
          title: `${gap.length} of ${members.length} /${segment}/ pages carry no ${type}`,
          subject: { kind: 'site', id: `/${segment}/` },
          summary:
            `${carrying.length} of ${members.length} pages under /${segment}/ publish a ${type}, and ` +
            `${gap.length} do not. Where a type is the norm for a section, the pages without it are ` +
            `usually an oversight rather than a decision — but this tool cannot read the page, so it ` +
            `may simply be that these pages are genuinely something else.`,
          expected: `A ${type} on every /${segment}/ page, if that is what they are.`,
          ...sampleObserved(
            gap.map((page) => ({
              value: page.canonical_url,
              observation_count: 1,
              page_count: 1,
              provenance: [],
            })),
          ),
          pages_affected: gap.length,
          // False, and it cannot be otherwise: this check returns early when
          // coverage is partial, so a finding only exists on a complete crawl.
          // It said `true` until 2026-08-22, which rendered as "this finding
          // depends on pages that were not all fetched" beneath a summary table
          // reading "564 of 564 discovered" — two statements in one report that
          // could not both be true.
          coverage_qualified: false,
          remediation: `Check why these pages differ from the other ${carrying.length} in the section.`,
          tradeoff: null,
          pattern: `${type} missing from part of a section`,
          aggregate_title: 'sections have pages missing their usual type',
          page_ids: gap.map((page) => page.page_id),
        });
      }
    }

    return findings;
  },
};

// --- coverage.missing-expected-entity ----------------------------------------

/**
 * Site-level absences a business site would normally have.
 *
 * `04` calls this "the check most likely to be annoying", and the one a language
 * model would do far better because it can read the visible content. So it is
 * deliberately narrow: three absences that are unambiguous from crawl data
 * alone, reported as one finding rather than three, and gated on complete
 * coverage because an absence claim is only as good as the coverage (rule 3).
 *
 * Nothing here guesses at what a page is *about*. "No `LocalBusiness` on a site
 * with a contact page" is exactly the kind of inference that needs the page
 * content, and it is left to the LLM layer in `05`.
 */
const missingExpectedEntity: Check = {
  id: 'coverage.missing-expected-entity',
  group: 'coverage',
  run({ graph, pages, hierarchy, partialCoverage }) {
    if (partialCoverage) return [];
    if (pages.filter((page) => page.http_status === 200).length === 0) return [];

    let hasOrganisation = false;
    let hasLogo = false;
    let hasSameAs = false;

    for (const node of graph.allNodes) {
      const ancestors = closure(node.types, hierarchy);
      if (ancestors.has('Organization')) {
        hasOrganisation = true;
        if ((node.props[LOGO] ?? []).length > 0) hasLogo = true;
      }
      if ((node.props[SAME_AS] ?? []).length > 0) hasSameAs = true;
    }

    const absences: { what: string; why: string }[] = [];
    if (!hasOrganisation) {
      absences.push({
        what: 'no Organization anywhere on the site',
        why:
          'nothing identifies who publishes this site, so no consumer can connect it to a knowledge ' +
          'panel, a brand, or any other mention of you',
      });
    } else if (!hasLogo) {
      absences.push({
        what: 'an Organization with no logo',
        why: 'the logo is what most consumers display alongside the name',
      });
    }
    if (!hasSameAs) {
      absences.push({
        what: 'no sameAs links anywhere',
        why:
          'sameAs is how a site says "this entity is also the one over there" — without it nothing ' +
          'links this site to its own profiles elsewhere',
      });
    }

    if (absences.length === 0) return [];

    return [
      {
        finding_id: findingId('coverage.missing-expected-entity', 'site'),
        check: 'coverage.missing-expected-entity',
        severity: 'opportunity',
        origin: 'check',
        title: `${absences.length} thing(s) a site like this usually publishes are absent`,
        subject: { kind: 'site', id: 'site' },
        summary:
          `Across the whole crawl: ${absences.map((absence) => absence.what).join('; ')}. These are ` +
          `absences rather than errors, and a site can have good reasons for any of them — this check ` +
          `only reports what is not there, and cannot read the page to know whether it should be.`,
        expected: null,
        observed: absences.map((absence) => ({
          value: absence.what,
          detail: absence.why,
          observation_count: 1,
          page_count: 0,
          provenance: [],
        })),
        pages_affected: 0,
        // False, and it cannot be otherwise: this check returns early when
        // coverage is partial, so a finding only exists on a complete crawl.
        // It said `true` until 2026-08-22, which rendered as "this finding
        // depends on pages that were not all fetched" beneath a summary table
        // reading "564 of 564 discovered" — two statements in one report that
        // could not both be true.
        coverage_qualified: false,
        remediation: 'Add whichever of these applies to your site.',
        tradeoff: null,
      },
    ];
  },
};

export const STRUCTURE_CHECKS: Check[] = [
  multiValue,
  relativeId,
  orphanNode,
  blankNodeEntity,
  trailingSlashDrift,
  typeGap,
  missingExpectedEntity,
];
