/**
 * The entity graph: nodes grouped by resolved `@id`, ready for checks.
 *
 * This is where `04`'s four rules are enforced once, rather than in every
 * check. Getting any of them wrong here breaks everything downstream, and each
 * one was learned the hard way.
 */

import type { ExtractedNode } from '../extract/types.ts';
import { isUrlValuedProperty, loadHierarchy, type Hierarchy } from './hierarchy.ts';

/** Rule 1: a bare `{"@id": …}` is a pointer, not a statement about the entity. */
export function isReferenceValue(value: unknown): value is { '@id': string } {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  return (
    keys.length === 1 &&
    keys[0] === '@id' &&
    typeof (value as { '@id': unknown })['@id'] === 'string'
  );
}

/**
 * Rule 1 again, at node level: an observation must actually *say* something.
 *
 * A node carrying only a type and no properties is a stub. Counting it as an
 * observation makes every property look partial — the M0 error that turned 3
 * findings into 15.
 *
 * **And it must say what the thing *is*.** An untyped `{"@id": …, "name": …}`
 * is a *label*, not a description. The commonest instance by far is a
 * breadcrumb trail item:
 *
 * ```json
 * {"@type": "ListItem", "item": {"@id": "…/inkjet-paper/", "name": "Inkjet Paper"}}
 * ```
 *
 * That `name` is the crumb text for a position in a trail — deliberately short,
 * because that is what breadcrumbs are for — and it is not a claim that the
 * entity's name is "Inkjet Paper". The page's own `CollectionPage` node names
 * it something closer to "Inkjet Paper | FREE NEXT DAY DELIVERY", and comparing
 * the two produced **56 false contradictions on one site**, every one of them a
 * breadcrumb label against a page title.
 *
 * Every generator that emits breadcrumbs does this, so it is systemic rather
 * than a quirk of one site. Requiring a type is the narrowest rule that fixes
 * it, and it costs nothing real: a node describing an entity says what kind of
 * entity it is.
 */
export function isSubstantiveObservation(node: ExtractedNode): boolean {
  return node.types.length > 0 && Object.keys(node.props).length > 0;
}

export interface EntityGroup {
  node_id: string;
  /** The `@id` as written, when it differed. Amendment C. */
  raw_id: string | null;
  observations: ExtractedNode[];
  /** Distinct pages the entity was observed on. */
  pages: Set<string>;
}

export interface EntityGraph {
  /** Named entities only, keyed by resolved `@id`. */
  groups: Map<string, EntityGroup>;
  /**
   * Every node by id, named and blank, for dereferencing.
   *
   * **Deduplicated by `@id`, which makes it the wrong thing to iterate.** A
   * named node repeated across 150 pages collapses to one entry here, so a check
   * that walks `index.values()` sees one observation and silently misses 149.
   * That is correct for its purpose — following a reference to *an* example of
   * the node — and wrong for anything counting, scanning or collecting.
   *
   * Walk {@link EntityGraph.allNodes} for those. The distinction cost a
   * shakedown round: `graph.orphan-node` built its reference set from here and
   * reported every nested `PostalAddress` on 6 sites as unreferenced, because
   * only one page's parent survived to point at them.
   */
  index: Map<string, ExtractedNode>;
  /** Every node as extracted, including repeats of one `@id` across pages. */
  allNodes: readonly ExtractedNode[];
  /**
   * `@id`s referenced from **entity-reference positions** only.
   *
   * Deliberately not "every `@id` seen": schema.org types URLs as `@id`, so
   * `target`, `url` and `sameAs` values look exactly like entity references
   * after expansion. Counting them raised 38 false dangling references on one
   * corpus site, every one a WordPress `#respond` comment anchor.
   */
  referenced: Set<string>;
  /**
   * Every `@id` appearing in any value position, url-valued properties included.
   *
   * The opposite question to {@link EntityGraph.referenced}, and both are
   * needed. "Is this a dangling entity reference?" must ignore url-valued
   * properties or it invents findings; "is anything at all pointing at this
   * node?" must include them or it invents different ones — every
   * `potentialAction.target` `EntryPoint` looked orphaned until this existed.
   */
  referencedAnywhere: Set<string>;
  totalNodes: number;
}

export function buildGraph(nodes: readonly ExtractedNode[], hierarchy?: Hierarchy): EntityGraph {
  const vocabulary = hierarchy ?? loadHierarchy();
  const groups = new Map<string, EntityGroup>();
  const index = new Map<string, ExtractedNode>();
  const referenced = new Set<string>();
  const referencedAnywhere = new Set<string>();

  for (const node of nodes) {
    index.set(node.node_id, node);

    for (const [property, values] of Object.entries(node.props)) {
      for (const value of values) collectReferences(value, referencedAnywhere);
      // A URL-valued property holds a URL, not a pointer to a node. Its absence
      // from the graph says nothing at all.
      if (isUrlValuedProperty(property, vocabulary)) continue;
      for (const value of values) collectReferences(value, referenced);
    }

    // Blank nodes cannot participate in `@id` collision checks — their ids are
    // positional and per-page by construction (`01`).
    if (node.is_blank || !isSubstantiveObservation(node)) continue;

    const group = groups.get(node.node_id) ?? {
      node_id: node.node_id,
      raw_id: node.raw_id,
      observations: [],
      pages: new Set<string>(),
    };
    group.observations.push(node);
    group.pages.add(node.page_id);
    if (group.raw_id === null && node.raw_id !== null) group.raw_id = node.raw_id;
    groups.set(node.node_id, group);
  }

  return {
    groups,
    index,
    allNodes: nodes,
    referenced,
    referencedAnywhere,
    totalNodes: nodes.length,
  };
}

function collectReferences(value: unknown, into: Set<string>): void {
  if (Array.isArray(value)) {
    for (const item of value) collectReferences(item, into);
    return;
  }
  if (value === null || typeof value !== 'object') return;

  const object = value as Record<string, unknown>;
  if (typeof object['@id'] === 'string') into.add(object['@id']);
  if (Array.isArray(object['@list']))
    for (const item of object['@list']) collectReferences(item, into);
}

/**
 * Rule 4: compare what a value **denotes**, not how it is labelled.
 *
 * A blank-node id embeds `page_id`, so a byte-identical nested address gets a
 * different id on every page. Comparing ids raised six contradictions across
 * the M0 corpus, five of them false; comparing denotation raised one, the real
 * finding.
 *
 * A **named** `@id` is the opposite case: the IRI *is* the identity, so it is
 * compared as-is and never dereferenced. Following it would collapse two
 * genuinely different entities that happen to share a property value.
 */
export function denote(value: unknown, graph: EntityGraph, depth = 0): unknown {
  if (depth > 6) return { '@truncated': true };

  if (Array.isArray(value)) return value.map((item) => denote(item, graph, depth + 1));
  if (value === null || typeof value !== 'object') return value;

  const object = value as Record<string, unknown>;

  if (isReferenceValue(object)) {
    const id = object['@id'];
    if (!id.startsWith('_:')) return { '@id': id };

    const target = graph.index.get(id);
    if (target === undefined) return { '@dangling': true };

    return {
      '@types': [...target.types].sort(),
      '@props': Object.fromEntries(
        Object.entries(target.props)
          .sort(([left], [right]) => (left < right ? -1 : 1))
          .map(([key, values]) => [key, denote(values, graph, depth + 1)]),
      ),
    };
  }

  if (Array.isArray(object['@list'])) {
    return { '@list': object['@list'].map((item) => denote(item, graph, depth + 1)) };
  }

  return object;
}

/**
 * A comparable key for a property's values on one observation.
 *
 * Rule: compare as a **set**, always. `sameAs: [A, B]` and `[B, A]` are the
 * same statement and must never register as divergence (`00`, class 4).
 */
export function valueKey(values: readonly unknown[], graph: EntityGraph): string {
  return JSON.stringify(values.map((value) => JSON.stringify(denote(value, graph))).sort());
}

/** Short display form. Full IRIs internally, short names only at display time. */
export function shortIri(iri: string): string {
  return iri.replace(/^https?:\/\/schema\.org\//, '').replace(/^.*[/#]/, '');
}
