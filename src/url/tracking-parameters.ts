/**
 * `data/tracking-parameters.json`: the query parameters that identify one
 * click, campaign or visitor.
 *
 * One list with two readers. Canonicalisation strips these parameters, so a
 * tagged URL is the same page as the clean one; `url.tracking-parameter`
 * reports internal links that carry them.
 */

import fs from 'node:fs';
import path from 'node:path';

import { packageRoot } from '../runtime.ts';

const MATCH_KINDS = ['exact', 'prefix'] as const;
type MatchKind = (typeof MATCH_KINDS)[number];

export interface TrackingParameter {
  /** Lowercase. A prefix such as `utm_` when `match` is `prefix`. */
  name: string;
  match: MatchKind;
  operator: string;
  source: string;
}

export interface TrackingParameters {
  schemaVersion: number;
  parameters: TrackingParameter[];
}

const isMatchKind = (value: unknown): value is MatchKind =>
  typeof value === 'string' && (MATCH_KINDS as readonly string[]).includes(value);

/** Validate `data/tracking-parameters.json`; throws naming the file and the entry. */
export function parseTrackingParameters(json: string, source = '<inline>'): TrackingParameters {
  let raw: { schema_version?: unknown; parameters?: unknown };
  try {
    raw = JSON.parse(json) as typeof raw;
  } catch (error) {
    throw new Error(
      `${source}: not valid JSON — ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }

  if (typeof raw.schema_version !== 'number') {
    throw new Error(`${source}: missing "schema_version"`);
  }
  if (!Array.isArray(raw.parameters)) throw new Error(`${source}: missing "parameters" array`);
  if (raw.parameters.length === 0) throw new Error(`${source}: "parameters" is empty`);

  const seen = new Set<string>();
  const parameters = raw.parameters.map((entry, index): TrackingParameter => {
    const record = (typeof entry === 'object' && entry !== null ? entry : {}) as Record<
      string,
      unknown
    >;
    const where = `${source}: parameters[${index}]`;
    const name = record['name'];
    if (typeof name !== 'string' || name === '') throw new Error(`${where} needs a "name"`);
    if (name !== name.toLowerCase()) throw new Error(`${where} "name" must be lowercase`);
    if (seen.has(name)) throw new Error(`${where} repeats "${name}"`);
    seen.add(name);
    if (!isMatchKind(record['match'])) {
      throw new Error(`${where} needs "match" of ${MATCH_KINDS.join(' | ')}`);
    }
    if (typeof record['operator'] !== 'string') {
      throw new Error(`${where} needs an "operator"`);
    }
    if (typeof record['source'] !== 'string' || !record['source'].startsWith('https://')) {
      throw new Error(`${where} must cite its "source" as an https:// URL`);
    }
    return { name, match: record['match'], operator: record['operator'], source: record['source'] };
  });

  return { schemaVersion: raw.schema_version, parameters };
}

let cached: TrackingParameters | null = null;

/** The shipped rules file, parsed once; or the file at `configPath`. */
export function loadTrackingParameters(configPath?: string): TrackingParameters {
  if (configPath === undefined && cached !== null) return cached;
  const target = configPath ?? path.join(packageRoot(), 'data', 'tracking-parameters.json');
  const parsed = parseTrackingParameters(fs.readFileSync(target, 'utf8'), target);
  if (configPath === undefined) cached = parsed;
  return parsed;
}

/** Whether a decoded query key is a tracking parameter, compared lowercase. */
export function isTrackingParameter(key: string, rules: TrackingParameters): boolean {
  const lower = key.toLowerCase();
  return rules.parameters.some((parameter) =>
    parameter.match === 'exact' ? lower === parameter.name : lower.startsWith(parameter.name),
  );
}
