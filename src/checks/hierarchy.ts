/**
 * The schema.org class hierarchy.
 *
 * Vendored, not fetched at runtime — see `tools/fetch-schema-hierarchy.ts` for
 * why. Data file: `data/schema-subclasses.json`, CC BY-SA 3.0, derived from
 * schema.org.
 *
 * Exists to answer one question: when two observations of the same `@id` carry
 * different types, is one a **refinement** of the other, or are they in
 * **conflict**? That is the difference between `entity.type-narrowing`
 * (opportunity) and `entity.type-conflict` (error), and getting it backwards
 * means either crying wolf or missing the real thing.
 */

import fs from 'node:fs';
import path from 'node:path';

import { packageRoot } from '../runtime.ts';

const SCHEMA_PREFIX = 'https://schema.org/';

export interface Hierarchy {
  /** Direct parents, keyed by bare class name. */
  parents: Map<string, string[]>;
  /**
   * Properties whose schema.org range includes `URL`.
   *
   * The discriminator `graph.dangling-reference` needs: after expansion,
   * `publisher: {"@id": "…/#org"}` and `target: {"@id": "…/#respond"}` are
   * identical in shape, and only the vocabulary knows one is an entity
   * reference and the other a page anchor.
   */
  urlValuedProperties: Set<string>;
  license: string;
  sourceSha256: string;
}

interface RawFile {
  schema_version?: unknown;
  license?: unknown;
  source_sha256?: unknown;
  subclasses?: Record<string, unknown>;
  url_valued_properties?: unknown;
}

export function parseHierarchy(json: string, source = '<inline>'): Hierarchy {
  let raw: RawFile;
  try {
    raw = JSON.parse(json) as RawFile;
  } catch (error) {
    throw new Error(`${source}: not valid JSON — ${error instanceof Error ? error.message : String(error)}`);
  }
  if (typeof raw.schema_version !== 'number') throw new Error(`${source}: missing "schema_version"`);
  if (raw.subclasses === undefined || typeof raw.subclasses !== 'object') {
    throw new Error(`${source}: missing "subclasses" object`);
  }

  const parents = new Map<string, string[]>();
  for (const [name, value] of Object.entries(raw.subclasses)) {
    if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
      throw new Error(`${source}: ${name} must map to an array of class names`);
    }
    parents.set(name, value as string[]);
  }

  const urlValued = Array.isArray(raw.url_valued_properties)
    ? raw.url_valued_properties.filter((entry): entry is string => typeof entry === 'string')
    : [];

  return {
    parents,
    urlValuedProperties: new Set(urlValued),
    license: typeof raw.license === 'string' ? raw.license : 'unknown',
    sourceSha256: typeof raw.source_sha256 === 'string' ? raw.source_sha256 : '',
  };
}

let cached: Hierarchy | null = null;

export function loadHierarchy(): Hierarchy {
  if (cached !== null) return cached;
  const target = path.join(packageRoot(), 'data', 'schema-subclasses.json');
  cached = parseHierarchy(fs.readFileSync(target, 'utf8'), target);
  return cached;
}

/**
 * Strip the schema.org IRI prefix. Types arrive from extraction as full IRIs;
 * the hierarchy is keyed on bare names because 924 repetitions of the same
 * prefix is 20 KB of nothing.
 *
 * `03` requires `http://schema.org` be normalised to `https://` first, so both
 * spellings are handled here rather than relying on the caller.
 */
export function bareTypeName(type: string): string {
  const normalised = type.replace(/^http:\/\/schema\.org\//, SCHEMA_PREFIX);
  return normalised.startsWith(SCHEMA_PREFIX) ? normalised.slice(SCHEMA_PREFIX.length) : normalised;
}

/**
 * Every ancestor of a type, inclusive of the type itself.
 *
 * Cycle-safe: schema.org should be acyclic, but a vendored file is data and
 * data can be wrong, and an infinite loop inside a check is a much worse
 * failure than a slightly odd classification.
 */
export function closure(types: readonly string[], hierarchy: Hierarchy): Set<string> {
  const seen = new Set<string>();
  const queue = types.map(bareTypeName);

  while (queue.length > 0) {
    const current = queue.pop();
    if (current === undefined || seen.has(current)) continue;
    seen.add(current);
    for (const parent of hierarchy.parents.get(current) ?? []) {
      if (!seen.has(parent)) queue.push(parent);
    }
  }
  return seen;
}

export function isSubClassOf(child: string, ancestor: string, hierarchy: Hierarchy): boolean {
  const target = bareTypeName(ancestor);
  const childName = bareTypeName(child);
  if (childName === target) return false;
  return closure([childName], hierarchy).has(target);
}

export type TypeSetRelation =
  /** Identical once expanded. Not a finding. */
  | 'same'
  /** One observation asserts strictly more than the other. `entity.type-narrowing`. */
  | 'refinement'
  /** Neither contains the other. `entity.type-conflict`. */
  | 'conflict';

/**
 * Compare two type sets by **closure containment**.
 *
 * This unifies two cases that look different in the raw markup but are the same
 * question, and getting it right matters — the first draft of `04` mis-filed
 * one of them:
 *
 *   - `LocalBusiness` versus `Organization` — a subclass refinement.
 *     `closure(LocalBusiness) ⊃ closure(Organization)`, so it is a refinement.
 *   - `[Organization, Person]` versus `Person` — *not* a subclass relation at
 *     all; `Person` and `Organization` are unrelated. But the closures still
 *     nest, because one observation simply asserts an extra type. Also a
 *     refinement.
 *
 * A genuine conflict is neither containing the other: `Product` versus
 * `Person`. One entity cannot be both, and that is an error rather than an
 * opportunity.
 *
 * Note schema.org declares no formal disjointness, so "conflict" is our
 * judgement, not the vocabulary's. Same posture as the functional-property
 * list: an assertion stricter than RDF, made because the divergence is worth
 * reporting.
 */
export function typeSetRelation(
  left: readonly string[],
  right: readonly string[],
  hierarchy: Hierarchy,
): TypeSetRelation {
  const leftClosure = closure(left, hierarchy);
  const rightClosure = closure(right, hierarchy);

  const leftInRight = [...leftClosure].every((type) => rightClosure.has(type));
  const rightInLeft = [...rightClosure].every((type) => leftClosure.has(type));

  if (leftInRight && rightInLeft) return 'same';
  if (leftInRight || rightInLeft) return 'refinement';
  return 'conflict';
}

/** The more specific of two nesting type sets, for report wording. */
export function moreSpecific(
  left: readonly string[],
  right: readonly string[],
  hierarchy: Hierarchy,
): readonly string[] | null {
  if (typeSetRelation(left, right, hierarchy) !== 'refinement') return null;
  return closure(left, hierarchy).size > closure(right, hierarchy).size ? left : right;
}

/**
 * Can a `{"@id": …}` under this property be a plain URL rather than an entity
 * reference? If so, its absence from the graph proves nothing.
 */
export function isUrlValuedProperty(property: string, hierarchy: Hierarchy): boolean {
  return hierarchy.urlValuedProperties.has(bareTypeName(property));
}
