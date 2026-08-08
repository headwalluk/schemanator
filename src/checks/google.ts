/**
 * Group `google` — Google's rich-result required and recommended fields.
 *
 * The one group in this tool that reports **per-page** defects, and it exists
 * because Search Console reports a class of problem nothing else here can see:
 * markup that is valid, internally consistent, repeated identically sitewide,
 * and still ineligible for the rich result it was written for.
 *
 * ## Why this is not the per-page validator the non-goals rule out
 *
 * `04` rules out per-page validity and attributes it to validator.schema.org.
 * The attribution was wrong, and the correction is what makes room for this
 * group: validator.schema.org checks **vocabulary** validity — is this property
 * legal on this type. It has nothing to say about Google's requirements. Google
 * does, in the Rich Results Test, one URL at a time, by hand.
 *
 * So the boundary splits. Vocabulary validity stays out, rich-result *previews*
 * stay out, and what comes in is a documented publisher policy applied across a
 * whole site at once with block-and-pointer provenance — which is a thing no
 * existing tool does, rather than a reimplementation of one that does.
 *
 * ## Rule 2 applies with the sign flipped, and that is deliberate
 *
 * Everywhere else in this tool, repetition is silence and only divergence
 * speaks. Here a generator omitting `review` on all 252 of a site's products is
 * exactly the finding — one setting, one fix — so the *rule* survives while the
 * *conclusion* inverts: it is still reported once rather than 252 times, and it
 * is still one root cause, but the cause is the repetition itself.
 *
 * For the same reason this is the one group that evaluates **per observation**
 * rather than per entity, and the only place where partiality is not silenced.
 * Google evaluates a page, not an `@id`. One corpus `LocalBusiness` `@id` has
 * two observations, one carrying `address` and one not; that is a real defect
 * on a real page even though the statements union at site level, and grouping
 * by `@id` hid it completely.
 */

import fs from 'node:fs';
import path from 'node:path';

import type { ExtractedNode } from '../extract/types.ts';
import { packageRoot } from '../runtime.ts';
import {
  findingId,
  indexPagesById,
  provenanceOf,
  type Check,
  type CheckContext,
  type Finding,
} from './framework.ts';
import type { EntityGraph } from './graph.ts';
import { bareTypeName, closure, type Hierarchy } from './hierarchy.ts';

// --- the rules file ----------------------------------------------------------

export interface GoogleTypeRule {
  /** Judged wherever found, versus only when reached from an entry type. */
  entry: boolean;
  source: string;
  required: string[];
  /** Each inner array is a set of which at least one must be present. */
  oneOf: string[][];
  /** Required unless something else in the graph points at this node. */
  requiredUnlessReferenced: string[];
  recommended: string[];
  /** Properties walked to reach nested types that carry their own rules. */
  follow: string[];
}

export interface GoogleRules {
  schemaVersion: number;
  retrieved: string;
  types: Map<string, GoogleTypeRule>;
}

interface RawTypeRule {
  entry?: unknown;
  source?: unknown;
  required?: unknown;
  one_of?: unknown;
  required_unless_referenced?: unknown;
  recommended?: unknown;
  follow?: unknown;
}

function stringArray(value: unknown, context: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    throw new Error(`${context} must be an array of strings`);
  }
  return value as string[];
}

/**
 * Parse and validate. Strict and throwing, for the reason `cardinality.ts`
 * gives: a typo that silently degraded this to "no type has any requirement"
 * would produce a clean, confident, empty report, which is the worst failure
 * available to a tool whose output people act on.
 */
export function parseGoogleRules(json: string, source = '<inline>'): GoogleRules {
  let raw: { schema_version?: unknown; retrieved?: unknown; types?: Record<string, RawTypeRule> };
  try {
    raw = JSON.parse(json) as typeof raw;
  } catch (error) {
    throw new Error(`${source}: not valid JSON — ${error instanceof Error ? error.message : String(error)}`);
  }

  if (typeof raw.schema_version !== 'number') throw new Error(`${source}: missing "schema_version"`);
  if (raw.types === undefined || typeof raw.types !== 'object') {
    throw new Error(`${source}: missing "types" object`);
  }

  const types = new Map<string, GoogleTypeRule>();
  for (const [name, entry] of Object.entries(raw.types)) {
    if (typeof entry.entry !== 'boolean') {
      throw new Error(`${source}: ${name} must declare "entry" as a boolean`);
    }
    if (typeof entry.source !== 'string') {
      throw new Error(`${source}: ${name} must cite its "source" — a rule nobody can check is not a rule`);
    }

    const oneOfRaw = entry.one_of ?? [];
    if (!Array.isArray(oneOfRaw)) throw new Error(`${source}: ${name}.one_of must be an array`);
    const oneOf = oneOfRaw.map((set, index) => {
      const parsed = stringArray(set, `${source}: ${name}.one_of[${index}]`);
      if (parsed.length < 2) {
        throw new Error(`${source}: ${name}.one_of[${index}] needs at least two alternatives`);
      }
      return parsed;
    });

    types.set(name, {
      entry: entry.entry,
      source: entry.source,
      required: stringArray(entry.required, `${source}: ${name}.required`),
      oneOf,
      requiredUnlessReferenced: stringArray(
        entry.required_unless_referenced,
        `${source}: ${name}.required_unless_referenced`,
      ),
      recommended: stringArray(entry.recommended, `${source}: ${name}.recommended`),
      follow: stringArray(entry.follow, `${source}: ${name}.follow`),
    });
  }

  if (types.size === 0) throw new Error(`${source}: "types" is empty`);

  return {
    schemaVersion: raw.schema_version,
    retrieved: typeof raw.retrieved === 'string' ? raw.retrieved : 'unknown',
    types,
  };
}

let cached: GoogleRules | null = null;

export function loadGoogleRules(configPath?: string): GoogleRules {
  if (configPath === undefined && cached !== null) return cached;

  const target = configPath ?? path.join(packageRoot(), 'data', 'google-rich-results.json');
  const rules = parseGoogleRules(fs.readFileSync(target, 'utf8'), target);

  if (configPath === undefined) cached = rules;
  return rules;
}

// --- reading values off a node ----------------------------------------------

/**
 * Both spellings, because `03` normalises schema.org IRIs to `https://` but
 * mixed-vintage markup arrives as `http://` and expands to a different IRI. A
 * lookup that picks one silently misses every site on the other.
 */
function valuesOf(node: ExtractedNode, field: string): readonly unknown[] {
  return node.props[`https://schema.org/${field}`] ?? node.props[`http://schema.org/${field}`] ?? [];
}

/** Nodes reached through a property. `graph.index` is the right map here: the
 * question is "what does this reference point at", which is exactly what it is
 * deduplicated for. */
function targetsOf(node: ExtractedNode, field: string, graph: EntityGraph): ExtractedNode[] {
  const targets: ExtractedNode[] = [];
  for (const value of valuesOf(node, field)) {
    if (value === null || typeof value !== 'object') continue;
    const id = (value as Record<string, unknown>)['@id'];
    if (typeof id !== 'string') continue;
    const target = graph.index.get(id);
    if (target !== undefined) targets.push(target);
  }
  return targets;
}

/**
 * Is a field satisfied? Supports one level of dotted path, which is how Google
 * writes genuine alternatives — `price` or `priceSpecification.price`.
 *
 * An empty string counts as **present**. `value.empty` already reports that,
 * and one defect billed under two checks costs an operator more than it tells
 * them.
 */
function isPresent(node: ExtractedNode, expression: string, graph: EntityGraph): boolean {
  const dot = expression.indexOf('.');
  if (dot === -1) return valuesOf(node, expression).length > 0;

  const head = expression.slice(0, dot);
  const tail = expression.slice(dot + 1);
  return targetsOf(node, head, graph).some((target) => valuesOf(target, tail).length > 0);
}

/**
 * The most specific rule in a node's class closure.
 *
 * Not "every rule that matches": `AggregateOffer` is a subclass of `Offer`, and
 * judging one by the other's requirements produced five false positives on the
 * corpus — an AggregateOffer carries `lowPrice` where an Offer carries `price`,
 * and was reported as missing a required field it should never have been asked
 * for. `AggregateRating` under `Rating` is the same shape.
 *
 * Specificity is closure size: a subclass's closure strictly contains its
 * parent's, so the larger closure is the more specific type.
 */
export function ruleFor(
  types: readonly string[],
  rules: GoogleRules,
  hierarchy: Hierarchy,
): { typeName: string; rule: GoogleTypeRule } | null {
  const candidates = [...closure(types, hierarchy)].filter((name) => rules.types.has(name));
  if (candidates.length === 0) return null;

  candidates.sort((left, right) => {
    const bySpecificity = closure([right], hierarchy).size - closure([left], hierarchy).size;
    // Ties are broken by name so the choice is deterministic rather than
    // dependent on Set iteration order.
    return bySpecificity !== 0 ? bySpecificity : left.localeCompare(right);
  });

  const typeName = candidates[0];
  const rule = typeName === undefined ? undefined : rules.types.get(typeName);
  if (typeName === undefined || rule === undefined) return null;
  return { typeName, rule };
}

// --- the walk ----------------------------------------------------------------

type GapKind = 'required' | 'one-of' | 'recommended';

interface Gap {
  kind: GapKind;
  typeName: string;
  /** Display form. For `one-of`, the alternatives joined. */
  field: string;
  source: string;
  node: ExtractedNode;
}

/** Nested markup is shallow in practice; the cap is a cycle backstop, as in `denote()`. */
const MAX_DEPTH = 4;

function collectGaps(context: CheckContext): Gap[] {
  const { graph, google, hierarchy } = context;
  const gaps: Gap[] = [];

  const visit = (node: ExtractedNode, isEntry: boolean, depth: number, seen: Set<string>): void => {
    if (depth > MAX_DEPTH || seen.has(node.node_id)) return;
    seen.add(node.node_id);

    const match = ruleFor(node.types, google, hierarchy);
    if (match === null) return;
    const { typeName, rule } = match;

    // Reached at top level but only meaningful inside a parent. A stray Offer
    // is not a Google finding, and reporting one is how this check would start
    // inventing work.
    if (isEntry && !rule.entry) return;

    for (const field of rule.required) {
      if (!isPresent(node, field, graph)) {
        gaps.push({ kind: 'required', typeName, field, source: rule.source, node });
      }
    }

    // `itemReviewed` is required only on a Review that stands alone: nested
    // under the thing it reviews, the parent supplies the identity. The graph
    // already knows which, so this costs nothing and removes a whole class of
    // false positive on every site that nests its reviews properly.
    for (const field of rule.requiredUnlessReferenced) {
      if (graph.referencedAnywhere.has(node.node_id)) continue;
      if (!isPresent(node, field, graph)) {
        gaps.push({ kind: 'required', typeName, field, source: rule.source, node });
      }
    }

    for (const alternatives of rule.oneOf) {
      if (alternatives.some((field) => isPresent(node, field, graph))) continue;
      gaps.push({
        kind: 'one-of',
        typeName,
        field: alternatives.join(', '),
        source: rule.source,
        node,
      });
    }

    for (const field of rule.recommended) {
      if (!isPresent(node, field, graph)) {
        gaps.push({ kind: 'recommended', typeName, field, source: rule.source, node });
      }
    }

    for (const field of rule.follow) {
      for (const target of targetsOf(node, field, graph)) visit(target, false, depth + 1, seen);
    }
  };

  // `allNodes`, never `index`: this group counts observations, and `index` is
  // deduplicated by `@id` — the trap that hid a real missing `address` behind a
  // sibling observation that had one.
  for (const node of graph.allNodes) visit(node, true, 0, new Set());

  return gaps;
}

/**
 * One walk per report rather than one per check.
 *
 * Keyed on the context object, which `runChecks` builds once and hands to every
 * check, so the three checks below share a single pass over the graph.
 */
const GAP_CACHE = new WeakMap<CheckContext, Gap[]>();

function gapsFor(context: CheckContext): Gap[] {
  const existing = GAP_CACHE.get(context);
  if (existing !== undefined) return existing;
  const gaps = collectGaps(context);
  GAP_CACHE.set(context, gaps);
  return gaps;
}

// --- turning gaps into findings ----------------------------------------------

/** Instances named in `observed` before the reader has the idea. */
const OBSERVED_SAMPLE = 5;

interface Wording {
  title: (typeName: string, field: string) => string;
  summary: (typeName: string, field: string, nodes: number, pages: number) => string;
  expected: (typeName: string, field: string) => string;
  remediation: (typeName: string, field: string, source: string) => string;
  aggregateTitle: (typeName: string) => string;
  pattern: (typeName: string) => string;
  tradeoff: string | null;
}

function buildFindings(
  context: CheckContext,
  kind: GapKind,
  checkId: string,
  severity: Finding['severity'],
  wording: Wording,
): Finding[] {
  const pageIndex = indexPagesById(context.pages);

  const groups = new Map<string, Gap[]>();
  for (const gap of gapsFor(context)) {
    if (gap.kind !== kind) continue;
    const key = `${gap.typeName}|${gap.field}`;
    groups.set(key, [...(groups.get(key) ?? []), gap]);
  }

  return [...groups.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, group]) => {
      const first = group[0] as Gap;
      const { typeName, field, source } = first;
      const nodes = group.map((gap) => gap.node);
      const pageIds = new Set(nodes.map((node) => node.page_id));

      return {
        finding_id: findingId(checkId, key),
        check: checkId,
        severity,
        origin: 'check' as const,
        title: wording.title(typeName, field),
        subject: { kind: 'site' as const, id: typeName, property: field },
        summary: wording.summary(typeName, field, nodes.length, pageIds.size),
        expected: wording.expected(typeName, field),
        observed: nodes.slice(0, OBSERVED_SAMPLE).map((node) => ({
          value: node.node_id,
          observation_count: 1,
          page_count: 1,
          provenance: provenanceOf([node], pageIndex),
        })),
        pages_affected: pageIds.size,
        coverage_qualified: false,
        remediation: wording.remediation(typeName, field, source),
        tradeoff: wording.tradeoff,
        // Collapse within a type, never across: "Product is missing review" and
        // "LocalBusiness is missing image" are two decisions, and merging them
        // would produce an aggregate whose constituents share nothing but this
        // check's name.
        pattern: wording.pattern(typeName),
        aggregate_title: wording.aggregateTitle(typeName),
        page_ids: [...pageIds],
      };
    });
}

const SEARCH_CONSOLE_NOTE =
  'Search Console reports this against the page, with no pointer to the block or the node; ' +
  'the provenance below is what schemanator adds.';

const missingRequired: Check = {
  id: 'google.missing-required',
  group: 'google',
  run: (context) =>
    buildFindings(context, 'required', 'google.missing-required', 'error', {
      title: (typeName, field) => `${typeName} omits ${field}, which Google requires`,
      summary: (typeName, field, nodes, pages) =>
        `${nodes} ${typeName} node(s) across ${pages} page(s) carry no ${field}. Google lists it as ` +
        `required, so these nodes are not eligible for the rich result at all — and the markup is ` +
        `valid schema.org, which is why a vocabulary validator passes it and Search Console still ` +
        `reports an error. ${SEARCH_CONSOLE_NOTE}`,
      expected: (typeName, field) => `${field} on every ${typeName}.`,
      remediation: (typeName, field, source) =>
        `Emit ${field} on every ${typeName}. Google's requirements: ${source}`,
      pattern: (typeName) => `${typeName} is missing a field Google requires`,
      aggregateTitle: (typeName) => `fields Google requires for ${typeName} are absent`,
      tradeoff: null,
    }),
};

const incompleteAlternative: Check = {
  id: 'google.incomplete-alternative',
  group: 'google',
  run: (context) =>
    buildFindings(context, 'one-of', 'google.incomplete-alternative', 'error', {
      title: (typeName, field) => `${typeName} has none of ${field}`,
      summary: (typeName, field, nodes, pages) =>
        `Google requires at least one of ${field} on a ${typeName}, and ${nodes} node(s) across ` +
        `${pages} page(s) have none of them. Any one will do, which is why this is reported as a set ` +
        `rather than as several missing fields — the fix is one choice, not three. ${SEARCH_CONSOLE_NOTE}`,
      expected: (typeName, field) => `At least one of ${field} on every ${typeName}.`,
      remediation: (typeName, field, source) =>
        `Add whichever of ${field} the ${typeName} genuinely has. Google's requirements: ${source}`,
      pattern: (typeName) => `${typeName} satisfies none of a required set`,
      aggregateTitle: (typeName) => `required field sets are unsatisfied on ${typeName}`,
      tradeoff: null,
    }),
};

const missingRecommended: Check = {
  id: 'google.missing-recommended',
  group: 'google',
  run: (context) =>
    buildFindings(context, 'recommended', 'google.missing-recommended', 'opportunity', {
      title: (typeName, field) => `${typeName} omits ${field}, which Google recommends`,
      summary: (typeName, field, nodes, pages) =>
        `${nodes} ${typeName} node(s) across ${pages} page(s) carry no ${field}. Nothing is broken ` +
        `and the rich result can still appear — Google marks this as a warning rather than an error, ` +
        `and it is the shape of finding Search Console lists as an opportunity. Filling it in is what ` +
        `separates a bare result from a rich one. ${SEARCH_CONSOLE_NOTE}`,
      expected: (typeName, field) => `${field} on every ${typeName} that has one to give.`,
      remediation: (typeName, field, source) =>
        `Add ${field} where the ${typeName} genuinely has one. Google's recommendations: ${source}`,
      pattern: (typeName) => `${typeName} is missing a field Google recommends`,
      aggregateTitle: (typeName) => `fields Google recommends for ${typeName} are absent`,
      tradeoff:
        'Only add these where the underlying fact exists. Ratings nobody gave and reviews nobody ' +
        'wrote are a guidelines violation and risk a manual action, and a business reviewing itself ' +
        'is ineligible for the star treatment however the markup is written. This check reports an ' +
        'absence; it cannot tell whether you have anything true to put there.',
    }),
};

export const GOOGLE_CHECKS: Check[] = [missingRequired, incompleteAlternative, missingRecommended];
