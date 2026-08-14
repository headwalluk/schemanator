/**
 * The check engine.
 *
 * Every check is a pure function over the graph plus page records. No I/O, no
 * fetching, no HTML (`04`). That makes each one testable against a handful of
 * nodes, and means a check can never depend on how the tool was installed.
 */

import type { ExtractedNode } from '../extract/types.ts';
import { canonicaliseUrl } from '../url/canonical.ts';
import type { PageRecord } from '../store/workdir.ts';
import { isFunctional, loadCardinalityRules } from './cardinality.ts';
import { buildGraph, denote, shortIri, valueKey, type EntityGraph } from './graph.ts';
import { loadHierarchy, typeSetRelation } from './hierarchy.ts';
import {
  isBenignMediaHost,
  isMediaProperty,
  loadValueHeuristics,
  matchPlaceholder,
} from './values.ts';
import { BREADCRUMB_CHECKS } from './breadcrumb.ts';
import { GOOGLE_CHECKS, loadGoogleRules } from './google.ts';
import { CONTENT_CHECKS } from './content.ts';
import { PAGE_CHECKS } from './page.ts';
import { INDEXING_CHECKS } from './indexing.ts';
import { ROBOTS_CHECKS, loadAiCrawlers, type RobotsFile } from './robots.ts';
import { SYNTAX_CHECKS } from './syntax.ts';
import { STRUCTURE_CHECKS } from './structure.ts';
import {
  findingId,
  indexPagesById,
  provenanceOf,
  sampleObserved,
  type Check,
  type CheckContext,
  type Finding,
  type Observed,
  type Severity,
} from './framework.ts';

export type { Check, CheckContext, Finding, Observed, Provenance, Severity } from './framework.ts';

// --- entity.contradiction ----------------------------------------------------

const contradiction: Check = {
  id: 'entity.contradiction',
  group: 'entity',
  run({ graph, pages, rules, silenced }) {
    const findings: Finding[] = [];
    const pageIndex = indexPagesById(pages);

    for (const group of graph.groups.values()) {
      if (group.observations.length < 2) continue;

      const properties = new Set(group.observations.flatMap((node) => Object.keys(node.props)));

      for (const property of properties) {
        const buckets = new Map<string, ExtractedNode[]>();
        for (const node of group.observations) {
          const values = node.props[property];
          if (values === undefined) continue;
          const key = valueKey(values, graph);
          buckets.set(key, [...(buckets.get(key) ?? []), node]);
        }

        if (buckets.size < 2) {
          // Present on some observations and absent on others, but never
          // divergent: class 2 partiality. Counted, never listed (`04`).
          const present = [...buckets.values()].reduce((sum, nodes) => sum + nodes.length, 0);
          if (present > 0 && present < group.observations.length) {
            silenced['entity.partiality'] = (silenced['entity.partiality'] ?? 0) + 1;
          }
          continue;
        }

        if (!isFunctional(property, rules)) {
          // Divergent, but the property is legitimately plural. Silence.
          silenced['entity.multi-valued-divergence'] =
            (silenced['entity.multi-valued-divergence'] ?? 0) + 1;
          continue;
        }

        const observed: Observed[] = [...buckets.entries()]
          .sort(([, left], [, right]) => right.length - left.length)
          .map(([key, nodes]) => ({
            value: key,
            observation_count: nodes.length,
            page_count: new Set(nodes.map((node) => node.page_id)).size,
            provenance: provenanceOf(nodes, pageIndex),
          }));

        const short = shortIri(property);

        // Nearly one distinct value per observation is not a contradiction
        // between a few variants — the property is *page-scoped*, taking a new
        // value on every page it appears on. Same evidence, different problem,
        // and a completely different fix.
        //
        // Found in the shakedown: one corpus site's logo ImageObject carries
        // the current page URL as its `url` on all 150 pages (with Yoast's
        // placeholder caption "My Website" — the logo was never configured),
        // and another gives its organisation logo a page-rooted
        // `#organizationLogo` id on all 41. Reporting either as "150 different
        // values" is true and useless.
        if (buckets.size >= 5 && buckets.size >= group.observations.length * 0.9) {
          findings.push({
            finding_id: findingId('entity.page-scoped-value', `${group.node_id}|${property}`),
            check: 'entity.page-scoped-value',
            severity: 'error',
            origin: 'check',
            title: `${short} takes a different value on every page`,
            subject: { kind: 'entity', id: group.node_id, property },
            summary:
              `This entity is published sitewide, but its ${short} changes on every page — ` +
              `${buckets.size} distinct values across ${group.observations.length} observations. That is ` +
              `not a disagreement between a few variants; the property is page-scoped, so the entity has ` +
              `no stable ${short} at all and nothing downstream can rely on it.`,
            expected: `One ${short} for this entity, identical on every page.`,
            ...sampleObserved(observed),
            pages_affected: group.pages.size,
            coverage_qualified: false,
            remediation:
              `Set ${short} from a site-level value rather than the current page. A generator emitting ` +
              `the page URL here usually means the underlying setting was never configured.`,
            tradeoff: null,
          });
          continue;
        }
        findings.push({
          finding_id: findingId(contradiction.id, `${group.node_id}|${property}`),
          check: contradiction.id,
          severity: 'error',
          origin: 'check',
          title: `${short} has ${buckets.size} different values under one @id`,
          subject: { kind: 'entity', id: group.node_id, property },
          summary:
            `The same @id carries ${buckets.size} different values for ${short} across ` +
            `${group.observations.length} observations on ${group.pages.size} pages. Nothing reconciles ` +
            `these, so a consumer's view of the entity depends on which page it saw.`,
          expected: `One ${short} value across all observations of this @id.`,
          ...sampleObserved(observed),
          pages_affected: group.pages.size,
          coverage_qualified: false,
          remediation: `Emit a single ${short} for this entity, on every page that describes it.`,
          tradeoff: null,
          pattern: property,
          page_ids: [...group.pages],
        });
      }
    }
    return findings;
  },
};

// --- entity.type-narrowing / entity.type-conflict ---------------------------

function typeChecks(context: CheckContext, wantConflict: boolean): Finding[] {
  const { graph, pages, hierarchy } = context;
  const findings: Finding[] = [];
  const pageIndex = indexPagesById(pages);

  for (const group of graph.groups.values()) {
    if (group.observations.length < 2) continue;

    const buckets = new Map<string, ExtractedNode[]>();
    for (const node of group.observations) {
      const key = [...node.types].sort().join('|');
      if (key === '') continue;
      buckets.set(key, [...(buckets.get(key) ?? []), node]);
    }
    if (buckets.size < 2) continue;

    const sets = [...buckets.keys()].map((key) => key.split('|'));
    let sawConflict = false;
    for (let left = 0; left < sets.length; left += 1) {
      for (let right = left + 1; right < sets.length; right += 1) {
        if (typeSetRelation(sets[left] ?? [], sets[right] ?? [], hierarchy) === 'conflict')
          sawConflict = true;
      }
    }
    if (sawConflict !== wantConflict) continue;

    const observed: Observed[] = [...buckets.entries()]
      .sort(([, l], [, r]) => r.length - l.length)
      .map(([key, nodes]) => ({
        value: key.split('|').map(shortIri).join(', '),
        observation_count: nodes.length,
        page_count: new Set(nodes.map((node) => node.page_id)).size,
        provenance: provenanceOf(nodes, pageIndex),
      }));

    findings.push(
      wantConflict
        ? {
            finding_id: findingId('entity.type-conflict', group.node_id),
            check: 'entity.type-conflict',
            severity: 'error',
            origin: 'check',
            title: 'One @id declared as unrelated types',
            subject: { kind: 'entity', id: group.node_id },
            summary:
              `The same @id is declared with type sets that have no subclass relation, so no single ` +
              `entity can satisfy them all. Note schema.org declares no formal disjointness — this is ` +
              `our judgement, not the vocabulary's.`,
            expected: 'One consistent type, or a set where each is a refinement of the others.',
            observed,
            pages_affected: group.pages.size,
            coverage_qualified: false,
            remediation: 'Split these into separate @ids, or correct whichever type is wrong.',
            tradeoff: null,
          }
        : {
            finding_id: findingId('entity.type-narrowing', group.node_id),
            check: 'entity.type-narrowing',
            severity: 'opportunity',
            origin: 'check',
            title: 'One @id described more richly on some pages than others',
            subject: { kind: 'entity', id: group.node_id },
            summary:
              `The same @id carries a more specific type on some pages than others. Nothing is ` +
              `logically inconsistent — the richer set refines the leaner one — but nothing unions ` +
              `them either, so a consumer arriving on a lean page sees the thinner entity.`,
            expected: null,
            observed,
            pages_affected: group.pages.size,
            coverage_qualified: false,
            remediation: 'Consider emitting the richer type and its properties sitewide.',
            tradeoff:
              'Content-matching (mark up only what the page displays) versus entity consistency ' +
              '(one @id means one entity however you reach it). This tool cannot settle that from ' +
              'crawl data — it is a question about consumer behaviour.',
          },
    );
  }
  return findings;
}

const typeNarrowing: Check = {
  id: 'entity.type-narrowing',
  group: 'entity',
  run: (context) => typeChecks(context, false),
};

const typeConflict: Check = {
  id: 'entity.type-conflict',
  group: 'entity',
  run: (context) => typeChecks(context, true),
};

// --- graph.dangling-reference ------------------------------------------------

const dangling: Check = {
  id: 'graph.dangling-reference',
  group: 'graph',
  run({ graph, partialCoverage }) {
    const findings: Finding[] = [];

    for (const reference of graph.referenced) {
      if (reference.startsWith('_:')) continue;
      if (graph.index.has(reference)) continue;
      // A URL referenced as a value but never defined as a node is normal —
      // `url` and `logo` expand to @id-typed values. Only flag references that
      // look like entity ids, i.e. carrying a fragment.
      if (!reference.includes('#')) continue;

      findings.push({
        finding_id: findingId(dangling.id, reference),
        check: dangling.id,
        severity: 'warning',
        origin: 'check',
        title: 'Reference to an entity that is defined nowhere',
        subject: { kind: 'entity', id: reference },
        summary:
          `Something references ${reference} as a property value, but no page in this crawl defines ` +
          `it. Syntactically valid, so every per-page validator passes it.`,
        expected: `A node defining ${reference} somewhere on the site.`,
        observed: [],
        pages_affected: 0,
        coverage_qualified: partialCoverage,
        remediation: 'Define the entity, or remove the reference.',
        tradeoff: null,
      });
    }
    return findings;
  },
};

// --- graph.identity-fracture -------------------------------------------------

/** `@id`-typed values, which is how `url` and `sameAs` arrive after expansion. */
function idsOf(node: ExtractedNode, property: string): string[] {
  return (node.props[property] ?? [])
    .map((value) =>
      value !== null && typeof value === 'object' && '@id' in value ? String(value['@id']) : null,
    )
    .filter((value): value is string => value !== null);
}

const NAME = 'http://schema.org/name';
const URL_PROP = 'http://schema.org/url';
const SAME_AS = 'http://schema.org/sameAs';

const identityFracture: Check = {
  id: 'graph.identity-fracture',
  group: 'graph',
  run({ graph, pages, hierarchy }) {
    const findings: Finding[] = [];
    const pageIndex = indexPagesById(pages);

    // Index by name first. Pairwise over every entity is O(n²) and a large site
    // has thousands; entities sharing a name are the only candidates anyway.
    // Matching is case-folded, but the original spelling is kept for display —
    // quoting "acme network" back at an operator who wrote "Acme Network"
    // reads like a bug in the report.
    const byName = new Map<
      string,
      typeof graph.groups extends Map<string, infer G> ? G[] : never
    >();
    const displayName = new Map<string, string>();
    for (const group of graph.groups.values()) {
      for (const node of group.observations) {
        for (const raw of node.props[NAME] ?? []) {
          if (raw === null || typeof raw !== 'object' || !('@value' in raw)) continue;
          const original = String(raw['@value']).trim();
          const folded = original.toLowerCase();
          if (folded === '') continue;
          if (!displayName.has(folded)) displayName.set(folded, original);
          const existing = byName.get(folded) ?? [];
          if (!existing.includes(group)) byName.set(folded, [...existing, group]);
        }
      }
    }

    const reported = new Set<string>();

    for (const [name, candidates] of byName) {
      if (candidates.length < 2) continue;

      for (let left = 0; left < candidates.length; left += 1) {
        for (let right = left + 1; right < candidates.length; right += 1) {
          const a = candidates[left];
          const b = candidates[right];
          if (a === undefined || b === undefined) continue;

          // Signal 1: compatible types. Unrelated types mean different things
          // that happen to share a label — "Support" is a plausible name for
          // several entities on one site.
          const typesA = [...new Set(a.observations.flatMap((node) => node.types))];
          const typesB = [...new Set(b.observations.flatMap((node) => node.types))];
          if (typesA.length === 0 || typesB.length === 0) continue;
          if (typeSetRelation(typesA, typesB, hierarchy) === 'conflict') continue;

          // Signal 2: a corroborating identifier. Name alone is never enough.
          const urlsA = new Set(a.observations.flatMap((node) => idsOf(node, URL_PROP)));
          const urlsB = new Set(b.observations.flatMap((node) => idsOf(node, URL_PROP)));
          const sameAsA = new Set(a.observations.flatMap((node) => idsOf(node, SAME_AS)));
          const sameAsB = new Set(b.observations.flatMap((node) => idsOf(node, SAME_AS)));

          const urlMatch = [...urlsA].some((url) => urlsB.has(url));
          const sameAsMatch = [...sameAsA].some((url) => sameAsB.has(url));
          if (!urlMatch && !sameAsMatch) continue;

          const key = [a.node_id, b.node_id].sort().join('|');
          if (reported.has(key)) continue;
          reported.add(key);

          findings.push({
            finding_id: findingId(identityFracture.id, key),
            check: identityFracture.id,
            severity: 'error',
            origin: 'check',
            title: 'One entity published under two different @ids',
            subject: { kind: 'entity', id: a.node_id },
            summary:
              `Two @ids describe what appears to be the same entity — both named "${displayName.get(name) ?? name}", with ` +
              `compatible types and ${urlMatch ? 'the same url' : 'overlapping sameAs links'}. Nothing ` +
              `can merge them, so the entity's identity is forked and no consumer sees the whole of it. ` +
              `Both nodes are individually valid, which is why per-page validators pass this.`,
            expected: 'One @id for one real-world entity, referenced from everywhere else.',
            observed: [a, b].map((group) => ({
              value: group.node_id,
              observation_count: group.observations.length,
              page_count: group.pages.size,
              provenance: provenanceOf(group.observations, pageIndex),
            })),
            pages_affected: new Set([...a.pages, ...b.pages]).size,
            coverage_qualified: false,
            remediation:
              'Pick one @id, and make everything that referenced the other point at it instead.',
            tradeoff: null,
            // Two @ids differing only in fragment, repeated across pages, is one
            // generator behaviour rather than N site problems.
            page_ids: [...new Set([...a.pages, ...b.pages])],
            pattern: [a.node_id, b.node_id]
              .map((id) => (id.includes('#') ? `#${id.split('#')[1] ?? ''}` : '(no fragment)'))
              .sort()
              .join(' vs '),
          });
        }
      }
    }
    return findings;
  },
};

// --- url.canonical-mismatch --------------------------------------------------

const canonicalMismatch: Check = {
  id: 'url.canonical-mismatch',
  group: 'url',
  run({ pages }) {
    const findings: Finding[] = [];

    for (const page of pages) {
      if (page.declared_canonical === null) continue;

      // Canonicalise both sides. A first pass over the corpus found four
      // mismatches and two were percent-encoding hex case (`%EF%B8%8F` versus
      // `%ef%b8%8f`) rather than real divergence.
      let declared: string;
      let crawled: string;
      try {
        declared = canonicaliseUrl(page.declared_canonical);
        crawled = canonicaliseUrl(page.canonical_url);
      } catch {
        continue;
      }
      if (declared === crawled) continue;

      findings.push({
        finding_id: findingId(canonicalMismatch.id, page.page_id),
        check: canonicalMismatch.id,
        severity: 'warning',
        origin: 'check',
        title: 'Declared canonical differs from the URL served',
        subject: { kind: 'page', id: page.canonical_url },
        summary:
          `This page was served at ${page.canonical_url} but declares its canonical as ` +
          `${page.declared_canonical}. Where those disagree, entity identity fractures: schema url ` +
          `and @id values on this page may point somewhere the page itself disclaims.`,
        expected: `A canonical matching the URL served, or a redirect to the declared one.`,
        observed: [
          { value: crawled, observation_count: 1, page_count: 1, provenance: [] },
          { value: declared, observation_count: 1, page_count: 1, provenance: [] },
        ],
        pages_affected: 1,
        coverage_qualified: false,
        remediation: 'Make the canonical agree with the served URL, or serve a redirect.',
        tradeoff: null,
        page_ids: [page.page_id],
        pattern: (() => {
          const left = new URL(crawled);
          const right = new URL(declared);
          if (left.host !== right.host) return 'different host';
          if (left.search !== right.search) return 'different query string';
          return 'different path';
        })(),
      });
    }
    return findings;
  },
};

// --- value.placeholder / value.empty / url.* ---------------------------------

/** Walk every literal and `@id` string on every node, with its property. */
function eachValue(
  graph: EntityGraph,
  visit: (node: ExtractedNode, property: string, text: string, kind: 'literal' | 'id') => void,
): void {
  for (const node of graph.index.values()) {
    for (const [property, values] of Object.entries(node.props)) {
      for (const value of values) {
        if (value === null || typeof value !== 'object') continue;
        const object = value as Record<string, unknown>;
        if (typeof object['@value'] === 'string')
          visit(node, property, object['@value'], 'literal');
        else if (typeof object['@id'] === 'string') visit(node, property, object['@id'], 'id');
      }
    }
  }
}

const placeholderValue: Check = {
  id: 'value.placeholder',
  group: 'value',
  run({ graph, pages, heuristics }) {
    const pageIndex = indexPagesById(pages);
    const hits = new Map<
      string,
      { rule: string; label: string; text: string; nodes: ExtractedNode[] }
    >();

    eachValue(graph, (node, property, text) => {
      const rule = matchPlaceholder(text, heuristics);
      if (rule === null) return;
      const key = `${property}|${text.trim().toLowerCase()}`;
      const existing = hits.get(key);
      if (existing === undefined) {
        hits.set(key, { rule: property, label: rule.label, text: text.trim(), nodes: [node] });
      } else {
        existing.nodes.push(node);
      }
    });

    return [...hits.entries()].map(([key, hit]) => {
      const short = shortIri(hit.rule);
      return {
        finding_id: findingId(placeholderValue.id, key),
        check: placeholderValue.id,
        severity: 'error' as const,
        origin: 'check' as const,
        title: `${short} is a placeholder value`,
        subject: { kind: 'site' as const, id: 'site', property: hit.rule },
        summary:
          `${short} is "${hit.text}", which is a ${hit.label}. This is published to consumers as fact ` +
          `on ${new Set(hit.nodes.map((node) => node.page_id)).size} page(s) — it almost always means the ` +
          `underlying setting was never filled in.`,
        expected: `A real ${short} for this site.`,
        observed: [
          {
            value: hit.text,
            observation_count: hit.nodes.length,
            page_count: new Set(hit.nodes.map((node) => node.page_id)).size,
            provenance: provenanceOf(hit.nodes, pageIndex),
          },
        ],
        pages_affected: new Set(hit.nodes.map((node) => node.page_id)).size,
        coverage_qualified: false,
        remediation: `Set a real ${short} in the site or plugin settings.`,
        tradeoff: null,
        pattern: 'placeholder value',
        aggregate_title: 'values are unfilled placeholders',
        page_ids: [...new Set(hit.nodes.map((node) => node.page_id))],
      };
    });
  },
};

const emptyValue: Check = {
  id: 'value.empty',
  group: 'value',
  run({ graph, pages }) {
    const pageIndex = indexPagesById(pages);
    const byProperty = new Map<string, ExtractedNode[]>();

    eachValue(graph, (node, property, text, kind) => {
      if (kind !== 'literal' || text.trim() !== '') return;
      byProperty.set(property, [...(byProperty.get(property) ?? []), node]);
    });

    return [...byProperty.entries()].map(([property, nodes]) => {
      const short = shortIri(property);
      const pageCount = new Set(nodes.map((node) => node.page_id)).size;
      return {
        finding_id: findingId(emptyValue.id, property),
        check: emptyValue.id,
        severity: 'error' as const,
        origin: 'check' as const,
        title: `${short} is published as an empty string`,
        subject: { kind: 'site' as const, id: 'site', property },
        summary:
          `${short} is emitted with an empty value on ${pageCount} page(s). An empty string is worse ` +
          `than an absent property: absence says nothing, whereas "" asserts that the value exists and ` +
          `is blank. Consumers have to decide what that means, and they will not agree.`,
        expected: `Either a real ${short}, or the property omitted entirely.`,
        observed: [
          {
            value: '(empty string)',
            observation_count: nodes.length,
            page_count: pageCount,
            provenance: provenanceOf(nodes, pageIndex),
          },
        ],
        pages_affected: pageCount,
        coverage_qualified: false,
        remediation: `Fill in ${short}, or stop emitting it when there is nothing to say.`,
        tradeoff: null,
        // Rule 5. A blank PostalAddress is six empty properties with one cause:
        // one corpus site publishes every address field empty on 17 pages.
        // Six entries invite six edits; one names the block that is unfilled.
        pattern: 'published as an empty string',
        aggregate_title: 'properties are published as empty strings',
        page_ids: [...new Set(nodes.map((node) => node.page_id))],
      };
    });
  },
};

const insecureSelfReference: Check = {
  id: 'url.insecure-self-reference',
  group: 'url',
  run({ graph, pages, siteHost }) {
    const pageIndex = indexPagesById(pages);
    // Only meaningful when the site itself is served over https.
    const httpsSite = pages.some((page) => page.canonical_url.startsWith('https://'));
    if (!httpsSite) return [];

    const bare = siteHost.replace(/^www\./, '');
    const hits = new Map<string, ExtractedNode[]>();

    eachValue(graph, (node, _property, text, kind) => {
      if (kind !== 'id' || !text.startsWith('http://')) return;
      let host: string;
      try {
        host = new URL(text).host.toLowerCase();
      } catch {
        return;
      }
      if (host !== bare && host !== `www.${bare}` && !host.endsWith(`.${bare}`)) return;
      hits.set(text, [...(hits.get(text) ?? []), node]);
    });

    return [...hits.entries()].map(([url, nodes]) => ({
      finding_id: findingId(insecureSelfReference.id, url),
      check: insecureSelfReference.id,
      severity: 'warning' as const,
      origin: 'check' as const,
      title: 'Schema points at this site over insecure http',
      subject: { kind: 'site' as const, id: url },
      summary:
        `${url} refers to this site over http, but the site is served over https. Those are different ` +
        `IRIs, so anything consuming the graph sees two identities for one resource — the scheme ` +
        `divergence this tool deliberately refuses to normalise away so it can be reported.`,
      expected: 'The https spelling, matching how the site is actually served.',
      observed: [
        {
          value: url,
          observation_count: nodes.length,
          page_count: new Set(nodes.map((node) => node.page_id)).size,
          provenance: provenanceOf(nodes, pageIndex),
        },
      ],
      pages_affected: new Set(nodes.map((node) => node.page_id)).size,
      coverage_qualified: false,
      remediation: 'Update the value to https.',
      tradeoff: null,
      pattern: 'insecure self-reference',
      page_ids: [...new Set(nodes.map((node) => node.page_id))],
    }));
  },
};

const foreignMediaHost: Check = {
  id: 'url.foreign-media-host',
  group: 'url',
  run({ graph, siteHost, heuristics }) {
    const byHost = new Map<
      string,
      { urls: Set<string>; nodes: ExtractedNode[]; properties: Set<string> }
    >();

    eachValue(graph, (node, property, text, kind) => {
      if (kind !== 'id' || !isMediaProperty(property, heuristics)) return;
      let host: string;
      try {
        host = new URL(text).host;
      } catch {
        return;
      }
      if (isBenignMediaHost(host, siteHost, heuristics)) return;

      const record = byHost.get(host) ?? {
        urls: new Set<string>(),
        nodes: [],
        properties: new Set<string>(),
      };
      record.urls.add(text);
      record.nodes.push(node);
      record.properties.add(shortIri(property));
      byHost.set(host, record);
    });

    return [...byHost.entries()].map(([host, record]) => ({
      finding_id: findingId(foreignMediaHost.id, host),
      check: foreignMediaHost.id,
      // A warning, not an error: we deliberately do not fetch off-site media,
      // so we cannot know whether it resolves. What we can say is that this
      // site's images depend on somebody else's server.
      severity: 'warning' as const,
      origin: 'check' as const,
      title: `Media served from ${host}, which is not this site`,
      subject: { kind: 'site' as const, id: host },
      summary:
        `${record.urls.size} media URL(s) on ${host} are referenced as ${[...record.properties].join(', ')}. ` +
        `That host is neither this site, a subdomain of it, nor a recognised CDN, so these images depend ` +
        `on a third party. Left over from a migration this is a common cause of silently broken images — ` +
        `**schemanator does not fetch off-site media, so it cannot tell you whether these resolve.**`,
      expected: 'Media hosted on this site, a subdomain of it, or a recognised CDN.',
      ...sampleObserved(
        [...record.urls].map((url) => ({
          value: url,
          observation_count: 1,
          page_count: 1,
          provenance: [],
        })),
      ),
      pages_affected: new Set(record.nodes.map((node) => node.page_id)).size,
      coverage_qualified: false,
      remediation:
        'Check whether these files exist in the media library and repoint them, or remove the references.',
      tradeoff: null,
    }));
  },
};

// --- coverage.competing-syntax -----------------------------------------------

/**
 * Microdata types named in the summary sentence, before it says "and others".
 *
 * A sentence, not a list: the `observed` rows below carry the full sample. Six
 * ranked types is where the prose stops scanning as a sentence — one corpus site
 * declares 14, and naming all of them buries the count that matters.
 */
const TYPES_IN_SENTENCE = 6;
const ABSENT_TYPES_IN_SENTENCE = 4;

/**
 * Microdata sitting alongside a purpose-built JSON-LD graph.
 *
 * Site-level, one finding. Both corpus sites carrying microdata carry it on
 * every page; per-page this would emit 242 findings saying only "these two
 * things coexist" — the drowning rule 2 exists to prevent.
 *
 * **The types are read from this site, never cited from another.** Until 1.1.0
 * the summary named `WPHeader`, `SiteNavigationElement` and `Blog` — types
 * measured on two corpus sites — as an illustration of what microdata usually
 * turns out to be. It read as though they had been found on the site in hand,
 * and an agent consuming the report repeated them as fact about a site where
 * nothing had checked.
 *
 * `microdata_types` was already extracted per page and then discarded before it
 * reached the manifest. Now it is kept, so the finding can name what is actually
 * there and say which of it the JSON-LD already covers — the distinction that
 * tells an operator whether they are looking at dilution or at duplication.
 */
const competingSyntax: Check = {
  id: 'coverage.competing-syntax',
  group: 'coverage',
  run({ pages, graph }) {
    const microdataPages = pages.filter((page) => (page.extraction?.['microdata_items'] ?? 0) > 0);
    if (microdataPages.length === 0) return [];

    // Both sides must be short names before they can be compared. `itemtype` is
    // a raw attribute and arrives as a full IRI; node types are full IRIs too,
    // but of the `http://` spelling. Comparing either as-is matches nothing, and
    // the finding then claims every type is absent from the JSON-LD — including
    // `WebPage` on a site whose JSON-LD is mostly WebPage nodes.
    const jsonLdTypes = new Set<string>();
    for (const node of graph.allNodes)
      for (const type of node.types) jsonLdTypes.add(shortIri(type));

    // How many pages carry each microdata type, and does the JSON-LD say it too?
    const typePages = new Map<string, number>();
    for (const page of microdataPages) {
      for (const type of page.microdata_types ?? []) {
        const short = shortIri(type);
        typePages.set(short, (typePages.get(short) ?? 0) + 1);
      }
    }

    const ranked = [...typePages.entries()].sort(
      ([leftType, leftCount], [rightType, rightCount]) =>
        rightCount - leftCount || leftType.localeCompare(rightType),
    );
    const absent = ranked.filter(([type]) => !jsonLdTypes.has(type));

    // A crawl predating `microdata_types` has the counts but not the types.
    // Saying so beats inventing them, and re-running `analyse` fills it in.
    const measured = ranked.length > 0;

    const describe = measured
      ? `The microdata declares ${ranked.length} type(s): ` +
        `${ranked
          .slice(0, TYPES_IN_SENTENCE)
          .map(([type, count]) => `${type} (${count} page${count === 1 ? '' : 's'})`)
          .join(', ')}${ranked.length > TYPES_IN_SENTENCE ? ', and others' : ''}. ` +
        (absent.length === 0
          ? `Every one of them also appears in the JSON-LD, so the two syntaxes are describing the ` +
            `same things twice.`
          : `${absent.length} of them appear nowhere in the JSON-LD — ` +
            `${absent
              .slice(0, ABSENT_TYPES_IN_SENTENCE)
              .map(([type]) => type)
              .join(', ')}${absent.length > ABSENT_TYPES_IN_SENTENCE ? ', and others' : ''} — ` +
            `which is the signature of theme boilerplate rather than a competing description of your ` +
            `business.`)
      : `This crawl predates per-page microdata type recording, so the types are not known. ` +
        `Re-run \`schemanator analyse\` to fill them in — it needs no network.`;

    return [
      {
        finding_id: findingId(competingSyntax.id, 'site'),
        check: competingSyntax.id,
        severity: 'opportunity',
        origin: 'check',
        title: 'Microdata sits alongside the JSON-LD graph',
        subject: { kind: 'site', id: 'site' },
        summary:
          `${microdataPages.length} of ${pages.length} pages emit microdata as well as JSON-LD. ` +
          `${describe} The entity-level comparison — whether the two syntaxes ever *disagree* about ` +
          `one entity — has not been performed.`,
        expected: null,
        ...sampleObserved(
          measured
            ? ranked.map(([type, count]) => ({
                value: type,
                detail: jsonLdTypes.has(type) ? 'also in the JSON-LD' : 'not in the JSON-LD',
                observation_count: count,
                page_count: count,
                provenance: [],
              }))
            : [
                {
                  value: `microdata on ${microdataPages.length} page(s), types not recorded`,
                  observation_count: microdataPages.length,
                  page_count: microdataPages.length,
                  provenance: [],
                },
              ],
        ),
        pages_affected: microdataPages.length,
        coverage_qualified: true,
        remediation:
          'If it comes from the theme, most themes offer a switch to disable it. Otherwise confirm it ' +
          'agrees with the JSON-LD, or drop one of the two.',
        tradeoff: null,
      },
    ];
  },
};

// --- coverage.no-structured-data ---------------------------------------------

const noStructuredData: Check = {
  id: 'coverage.no-structured-data',
  group: 'coverage',
  run({ pages, partialCoverage }) {
    const bare = pages.filter(
      (page) =>
        page.http_status === 200 && page.extraction !== null && page.extraction['nodes'] === 0,
    );
    if (bare.length === 0) return [];

    return [
      {
        finding_id: findingId(noStructuredData.id, 'site'),
        check: noStructuredData.id,
        severity: 'opportunity',
        origin: 'check',
        title: `${bare.length} page(s) carry no structured data at all`,
        subject: { kind: 'site', id: 'site' },
        summary: `${bare.length} of ${pages.length} fetched pages emit no structured data.`,
        expected: null,
        // One row per page. This was a single row whose value was five URLs
        // glued together with newlines and an `observation_count` of the whole
        // set — a capped list wearing the costume of a complete one, which is
        // the fault this milestone is about.
        ...sampleObserved(
          bare.map((page) => ({
            value: page.canonical_url,
            observation_count: 1,
            page_count: 1,
            provenance: [],
          })),
        ),
        pages_affected: bare.length,
        coverage_qualified: partialCoverage,
        remediation: null,
        tradeoff: null,
      },
    ];
  },
};

/**
 * `entity.page-scoped-value` has no entry here: it is raised by
 * `entity.contradiction`, which is the only check with the evidence to tell the
 * two apart. Disabling `entity.contradiction` disables both.
 */
export const ALL_CHECKS: Check[] = [
  contradiction,
  typeNarrowing,
  typeConflict,
  dangling,
  identityFracture,
  canonicalMismatch,
  placeholderValue,
  emptyValue,
  insecureSelfReference,
  foreignMediaHost,
  competingSyntax,
  noStructuredData,
  ...STRUCTURE_CHECKS,
  ...BREADCRUMB_CHECKS,
  ...SYNTAX_CHECKS,
  ...GOOGLE_CHECKS,
  ...ROBOTS_CHECKS,
  ...INDEXING_CHECKS,
  ...CONTENT_CHECKS,
  ...PAGE_CHECKS,
];

const SEVERITY_ORDER: Record<Severity, number> = { error: 0, warning: 1, opportunity: 2 };

/**
 * Which group wins when severity and page count tie.
 *
 * Severity sorts first and always will. This decides the order *within* a
 * severity, and it exists because the alternative buries the findings this tool
 * exists for. Sorting errors by `pages_affected` alone puts a routine
 * `page.title-missing` on 400 pages above an `entity.contradiction` on 3 — and
 * the contradiction is the rarer, harder-won finding that no other tool
 * produces. `07` records the reasoning; the short version:
 *
 * 1. **`syntax`** — a block that did not parse means every entity in it is
 *    *missing*, so every other finding was computed from an incomplete graph.
 *    Nothing is worth reading before this.
 * 2. **`entity`, `graph`** — the whole-site contradictions. The product.
 * 3. **`value`, `url`** — what the values say, and identity hygiene.
 * 4. **`breadcrumb`, `google`** — structure, and rich-result eligibility.
 * 5. **`indexing`, `robots`** — real, and the ones an operator is most likely to
 *    already know about from Search Console.
 * 6. **`coverage`** — mostly "you could publish more", the least urgent thing
 *    in any report.
 *
 * An unlisted group sorts last rather than first: a new group should have to
 * earn its position deliberately, not inherit the top of the report by
 * accident.
 */
const GROUP_ORDER: readonly string[] = [
  'syntax',
  'entity',
  'graph',
  'value',
  'url',
  'breadcrumb',
  'content',
  'page',
  'google',
  'indexing',
  'robots',
  'coverage',
];

function groupRank(check: string): number {
  const index = GROUP_ORDER.indexOf(check.split('.')[0] ?? '');
  return index === -1 ? GROUP_ORDER.length : index;
}

/** Below this, individual findings are more useful than a summary of them. */
const AGGREGATE_THRESHOLD = 3;

/** Instances listed inside an aggregate before it says "and N more". */
export const AGGREGATE_SAMPLE = 10;

/**
 * Collapse findings that are the same problem at different subjects.
 *
 * The shakedown produced 28 identity fractures on one site, every one a page
 * carrying both a `#webpage` and a `#collectionpage` node. All 28 were real —
 * and listing them separately is still the wrong report, because it is one
 * generator behaviour, one decision, and one fix. Twenty-eight entries invite
 * an operator (or an agent) to make twenty-eight edits.
 *
 * Aggregation is by `pattern`, which each check supplies and which deliberately
 * excludes the subject: what the findings have in common, never where they were
 * found.
 */
/**
 * How much a finding saw, including what its `observed` list left out.
 *
 * `observation_total` is set by `sampleObserved`, so it is present wherever a
 * list was capped. Where it is absent the list is the whole set and summing it
 * is exact — which is why the fallback is a sum rather than a guess.
 */
function observationsBehind(finding: Finding): number {
  return (
    finding.observation_total ??
    finding.observed.reduce((total, row) => total + row.observation_count, 0)
  );
}

function aggregate(findings: readonly Finding[]): Finding[] {
  const groups = new Map<string, Finding[]>();
  const passthrough: Finding[] = [];

  for (const finding of findings) {
    if (finding.pattern === undefined) {
      passthrough.push(finding);
      continue;
    }
    const key = `${finding.check}|${finding.pattern}`;
    groups.set(key, [...(groups.get(key) ?? []), finding]);
  }

  const result = [...passthrough];

  for (const [key, group] of groups) {
    const first = group[0];
    if (first === undefined) continue;

    if (group.length < AGGREGATE_THRESHOLD) {
      result.push(...group);
      continue;
    }

    result.push({
      ...first,
      finding_id: findingId(first.check, `aggregate|${first.pattern ?? ''}`),
      title:
        first.aggregate_title === undefined
          ? `${group.length} × ${first.title}`
          : `${group.length} ${first.aggregate_title}`,
      // `pages_affected` on an aggregate is the union of its constituents, so
      // it is routinely larger than the constituent count in the title. A
      // real report read "32 pages carry two breadcrumb trails" above
      // "Pages affected: 56", which invites the reader to distrust both numbers.
      // `aggregate_title` must therefore name what is being counted — subjects,
      // properties, entities — and never "pages".
      subject: { kind: 'site', id: 'site' },
      // "The individual subjects are listed below" was true of a five-subject
      // aggregate and false of a 154-subject one, where ten are listed. The
      // sentence has to know which it is: prose that overstates its own
      // evidence is the fault this milestone exists to remove, and an aggregate
      // is where the overstatement is largest.
      summary:
        `${group.length} subjects share this problem — ${first.pattern}. Reported once rather than ` +
        `${group.length} times: one generator behaviour, one fix. ` +
        (group.length > AGGREGATE_SAMPLE
          ? `${AGGREGATE_SAMPLE} of them are listed below.`
          : `The individual subjects are listed below.`) +
        `\n\n**Taking the first as an example:** ${first.summary}`,
      observed: group.slice(0, AGGREGATE_SAMPLE).map((finding) => ({
        // Name what actually varies between constituents. For a per-property
        // check that is the property; for a per-entity one, the entity.
        value:
          finding.subject.property === undefined
            ? finding.subject.id
            : shortIri(finding.subject.property),
        // What the constituent saw, not how many constituents this row is.
        //
        // It was hardcoded to 1, which gave the field a second meaning —
        // "one constituent finding" — and produced rows reading one
        // observation across 1,000 pages. `finding-volume.test.ts` caught it
        // and had to carry it as a written exemption, because the true total
        // was nowhere: `observed` was capped without saying so, and summing
        // the surviving rows undercounts by exactly what was dropped.
        // `observation_total` is that missing number, which is why this task
        // owned the exemption rather than neighbouring it.
        observation_count: observationsBehind(finding),
        page_count: finding.pages_affected,
        provenance: finding.observed[0]?.provenance ?? [],
      })),
      // Constituents past the sample. The summary used to say "see
      // report.json" for these, which was untrue — the JSON carries the same
      // ten rows. A cap that misdirects is worse than one that admits itself.
      omitted_count: Math.max(0, group.length - AGGREGATE_SAMPLE),
      observation_total: group.reduce((total, finding) => total + observationsBehind(finding), 0),
      pages_affected:
        new Set(group.flatMap((finding) => finding.page_ids ?? [])).size ||
        group[0]?.pages_affected ||
        0,
      instance_count: group.length,
      /**
       * The constituents' remediation is written for one subject, and inherited
       * verbatim it gives incomplete advice. A three-property `value.empty`
       * aggregate read "3 properties are published as empty strings" above
       * "Fill in postalCode" — somebody following that fixes one of three.
       *
       * The wording is kept, because it explains the fix, and scoped so it
       * reads as per-subject rather than as the whole job.
       */
      remediation:
        first.remediation === null
          ? null
          : // "listed above" was the same overstatement: 154 subjects, ten of
            // them listed. The job is all 154 either way, so naming the count
            // and dropping the claim about the list is both shorter and true.
            `${first.remediation} Apply this to each of the ${group.length} subjects.`,
      /**
       * Every constituent's trade-off, not the first one's.
       *
       * `...first` spreads the first finding's, which was harmless while a
       * whole check shared one trade-off and became wrong the moment they were
       * attached to properties instead: an `Offer` aggregate led by
       * `availability` — which has none — would silently drop the warning that
       * a stale `priceValidUntil` invalidates the offer. That is advice
       * disappearing because of the order a Map happened to iterate in.
       *
       * Distinct texts only. Constituents commonly share one, and printing it
       * twice reads as a fault in the report.
       */
      tradeoff:
        [...new Set(group.map((finding) => finding.tradeoff).filter((text) => text !== null))].join(
          '\n\n',
        ) || null,
      ...(first.pattern === undefined ? {} : { pattern: first.pattern }),
    });

    void key;
  }

  return result;
}

export interface RunChecksResult {
  findings: Finding[];
  silenced: Record<string, number>;
  checksRun: string[];
  checksDisabled: string[];
}

export function runChecks(options: {
  nodes: readonly ExtractedNode[];
  pages: PageRecord[];
  partialCoverage: boolean;
  disabled?: readonly string[];
  /**
   * The site's parsed `robots.txt`. Null when unavailable — an older crawl, or
   * a file that could not be read. Group `robots` reports nothing rather than
   * assuming permission, which `02` is emphatic about.
   */
  robots?: RobotsFile | null;
  /** Sitemaps the crawl found, however it found them. */
  sitemapsFound?: readonly string[];
}): RunChecksResult {
  const disabled = new Set(options.disabled ?? []);
  const silenced: Record<string, number> = {};

  // Derive the site host from what was actually crawled rather than taking it
  // on trust: the crawl may have followed a redirect to a different spelling.
  let siteHost = '';
  for (const page of options.pages) {
    try {
      siteHost = new URL(page.canonical_url).host;
      break;
    } catch {
      continue;
    }
  }

  const context: CheckContext = {
    graph: buildGraph(options.nodes),
    pages: options.pages,
    rules: loadCardinalityRules(),
    hierarchy: loadHierarchy(),
    heuristics: loadValueHeuristics(),
    google: loadGoogleRules(),
    robots: options.robots ?? null,
    aiCrawlers: loadAiCrawlers(),
    sitemapsFound: options.sitemapsFound ?? [],
    siteHost,
    partialCoverage: options.partialCoverage,
    silenced,
  };

  const findings: Finding[] = [];
  const run: string[] = [];

  for (const check of ALL_CHECKS) {
    if (disabled.has(check.id) || disabled.has(check.group)) continue;
    run.push(check.id);
    findings.push(...check.run(context));
  }

  const aggregated = aggregate(findings);

  aggregated.sort(
    (left, right) =>
      SEVERITY_ORDER[left.severity] - SEVERITY_ORDER[right.severity] ||
      groupRank(left.check) - groupRank(right.check) ||
      right.pages_affected - left.pages_affected ||
      left.check.localeCompare(right.check),
  );

  for (const finding of aggregated) {
    delete finding.page_ids;
    delete finding.observation_total;
  }

  return { findings: aggregated, silenced, checksRun: run, checksDisabled: [...disabled] };
}

export { denote };
