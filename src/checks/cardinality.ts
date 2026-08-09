/**
 * The functional-property list.
 *
 * `dev-notes/00` calls this list "the product", and it is not overstating it:
 * without it, `entity.contradiction` cannot tell a genuine contradiction from a
 * property that is simply plural, and every downstream check inherits the
 * ambiguity.
 *
 * The list is a **policy assertion informed by data**, not a discovery. See the
 * `_method` note in `data/functional-properties.json`: measurement can rule a
 * property out (it was observed carrying two values) but never in (never seeing
 * two proves nothing).
 *
 * **Unlisted properties are multi-valued, and therefore silent.** The cost of a
 * missing functional property is one unreported finding; the cost of a wrongly
 * functional one is a false contradiction on every site that uses it
 * legitimately. Those are not symmetric.
 */

import fs from 'node:fs';
import path from 'node:path';

import { packageRoot } from '../runtime.ts';

export type Cardinality = 'functional' | 'multi-valued';

export interface PropertyRule {
  cardinality: Cardinality;
  /** `observed` — the corpus proved it. `asserted` — our policy. */
  basis: 'observed' | 'asserted';
  note?: string;
}

export interface CardinalityRules {
  schemaVersion: number;
  defaultCardinality: Cardinality;
  properties: Map<string, PropertyRule>;
}

/**
 * `03` requires schema.org IRIs be normalised to `https://` before comparison.
 * Both spellings are in the wild and expand to different IRIs, so a lookup that
 * skips this silently misses every site with mixed-vintage markup.
 */
export function normalisePropertyIri(iri: string): string {
  return iri.replace(/^http:\/\/schema\.org\//, 'https://schema.org/');
}

interface RawFile {
  schema_version?: unknown;
  default_cardinality?: unknown;
  properties?: Record<string, { cardinality?: unknown; basis?: unknown; note?: unknown }>;
}

function isCardinality(value: unknown): value is Cardinality {
  return value === 'functional' || value === 'multi-valued';
}

/**
 * Parse and validate the rules file.
 *
 * Validation is strict and throws: a typo that silently degrades every entity
 * check to "everything is plural" would produce a clean, confident, empty
 * report — the worst possible failure for a tool whose output people act on.
 */
export function parseCardinalityRules(json: string, source = '<inline>'): CardinalityRules {
  let raw: RawFile;
  try {
    raw = JSON.parse(json) as RawFile;
  } catch (error) {
    throw new Error(
      `${source}: not valid JSON — ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }

  if (typeof raw.schema_version !== 'number') {
    throw new Error(`${source}: missing or non-numeric "schema_version"`);
  }
  if (!isCardinality(raw.default_cardinality)) {
    throw new Error(`${source}: "default_cardinality" must be "functional" or "multi-valued"`);
  }
  if (raw.properties === undefined || typeof raw.properties !== 'object') {
    throw new Error(`${source}: missing "properties" object`);
  }

  const properties = new Map<string, PropertyRule>();
  for (const [iri, entry] of Object.entries(raw.properties)) {
    if (!isCardinality(entry.cardinality)) {
      throw new Error(
        `${source}: ${iri} has invalid "cardinality" ${JSON.stringify(entry.cardinality)}`,
      );
    }
    if (entry.basis !== 'observed' && entry.basis !== 'asserted') {
      throw new Error(`${source}: ${iri} has invalid "basis" ${JSON.stringify(entry.basis)}`);
    }
    properties.set(normalisePropertyIri(iri), {
      cardinality: entry.cardinality,
      basis: entry.basis,
      ...(typeof entry.note === 'string' ? { note: entry.note } : {}),
    });
  }

  return {
    schemaVersion: raw.schema_version,
    defaultCardinality: raw.default_cardinality,
    properties,
  };
}

let cached: CardinalityRules | null = null;

/** Load the shipped rules, or an operator override via `configPath`. */
export function loadCardinalityRules(configPath?: string): CardinalityRules {
  if (configPath === undefined && cached !== null) return cached;

  const target = configPath ?? path.join(packageRoot(), 'data', 'functional-properties.json');
  const rules = parseCardinalityRules(fs.readFileSync(target, 'utf8'), target);

  if (configPath === undefined) cached = rules;
  return rules;
}

/** Is a divergence in this property a contradiction, or just plurality? */
export function isFunctional(iri: string, rules: CardinalityRules): boolean {
  const rule = rules.properties.get(normalisePropertyIri(iri));
  return (rule?.cardinality ?? rules.defaultCardinality) === 'functional';
}

/** Why the list says what it says — for the `remediation` text in a finding. */
export function cardinalityRule(iri: string, rules: CardinalityRules): PropertyRule | undefined {
  return rules.properties.get(normalisePropertyIri(iri));
}
