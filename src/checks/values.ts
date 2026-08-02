/**
 * Value heuristics: placeholders, and which hosts may legitimately serve media.
 *
 * Data file, not code (`data/value-heuristics.json`) — same reasoning as the
 * functional-property list. These get tuned for the life of the project, and an
 * operator with an unusual site needs to override them without a release.
 */

import fs from 'node:fs';
import path from 'node:path';

import { packageRoot } from '../runtime.ts';
import { bareTypeName } from './hierarchy.ts';

export interface PlaceholderRule {
  pattern: RegExp;
  label: string;
  basis: 'observed' | 'asserted';
  note?: string;
}

export interface ValueHeuristics {
  placeholders: PlaceholderRule[];
  benignMediaHosts: Set<string>;
  mediaProperties: Set<string>;
}

interface RawFile {
  schema_version?: unknown;
  placeholders?: { pattern?: unknown; label?: unknown; basis?: unknown; note?: unknown }[];
  benign_media_hosts?: unknown;
  media_properties?: unknown;
}

export function parseValueHeuristics(json: string, source = '<inline>'): ValueHeuristics {
  let raw: RawFile;
  try {
    raw = JSON.parse(json) as RawFile;
  } catch (error) {
    throw new Error(`${source}: not valid JSON — ${error instanceof Error ? error.message : String(error)}`);
  }
  if (typeof raw.schema_version !== 'number') throw new Error(`${source}: missing "schema_version"`);
  if (!Array.isArray(raw.placeholders)) throw new Error(`${source}: missing "placeholders" array`);

  const placeholders: PlaceholderRule[] = raw.placeholders.map((entry, index) => {
    if (typeof entry.pattern !== 'string') throw new Error(`${source}: placeholder ${index} has no "pattern"`);
    if (typeof entry.label !== 'string') throw new Error(`${source}: placeholder ${index} has no "label"`);
    if (entry.basis !== 'observed' && entry.basis !== 'asserted') {
      throw new Error(`${source}: placeholder ${index} has invalid "basis"`);
    }
    let pattern: RegExp;
    try {
      pattern = new RegExp(entry.pattern, 'i');
    } catch (error) {
      throw new Error(`${source}: placeholder ${index} has an invalid regex — ${String(error)}`);
    }
    return {
      pattern,
      label: entry.label,
      basis: entry.basis,
      ...(typeof entry.note === 'string' ? { note: entry.note } : {}),
    };
  });

  const list = (value: unknown): string[] =>
    Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];

  return {
    placeholders,
    benignMediaHosts: new Set(list(raw.benign_media_hosts).map((host) => host.toLowerCase())),
    mediaProperties: new Set(list(raw.media_properties)),
  };
}

let cached: ValueHeuristics | null = null;

export function loadValueHeuristics(): ValueHeuristics {
  if (cached !== null) return cached;
  const target = path.join(packageRoot(), 'data', 'value-heuristics.json');
  cached = parseValueHeuristics(fs.readFileSync(target, 'utf8'), target);
  return cached;
}

/**
 * Match against the **trimmed whole value**, never a substring.
 *
 * `power-plugins.com` sells a lorem ipsum generator, and substring matching
 * would tell it its own product name is a placeholder.
 */
export function matchPlaceholder(value: string, heuristics: ValueHeuristics): PlaceholderRule | null {
  const trimmed = value.trim();
  if (trimmed === '') return null;
  return heuristics.placeholders.find((rule) => rule.pattern.test(trimmed)) ?? null;
}

export function isMediaProperty(property: string, heuristics: ValueHeuristics): boolean {
  return heuristics.mediaProperties.has(bareTypeName(property));
}

/**
 * May this host serve media for this site?
 *
 * A subdomain of the site's own domain always may — `cdn.example.com` serving
 * `example.com`'s images is the normal shape of a CDN, and one corpus site does
 * exactly that for 35 URLs. Handled here rather than in the data file because
 * it depends on the site being crawled.
 */
export function isBenignMediaHost(host: string, siteHost: string, heuristics: ValueHeuristics): boolean {
  const candidate = host.toLowerCase();
  const site = siteHost.toLowerCase().replace(/^www\./, '');

  if (candidate === site || candidate === `www.${site}`) return true;
  if (candidate.endsWith(`.${site}`)) return true;
  if (heuristics.benignMediaHosts.has(candidate)) return true;

  // Suffix match for CDN families that use per-customer subdomains
  // (`d1234.cloudfront.net`, `acme.imgix.net`).
  return [...heuristics.benignMediaHosts].some((benign) => candidate.endsWith(`.${benign}`));
}
