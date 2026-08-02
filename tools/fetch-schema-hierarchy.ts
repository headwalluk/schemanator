/**
 * Regenerate `data/schema-subclasses.json` from schema.org.
 *
 * A **maintenance script**, not part of the tool. It is the only thing in this
 * repository that fetches a vocabulary, and it runs when we choose to refresh —
 * never at check time. `04` is explicit that checks read `nodes.jsonl` and
 * nothing else.
 *
 * Why vendor rather than fetch-and-cache at runtime:
 *
 *   - **Reproducibility.** `05` requires cross-run diffing for the fix-verify
 *     loop. If the hierarchy shifted under us between runs, a type-set could be
 *     reclassified from narrowing to conflict with no change to the site, and
 *     the diff would report findings as resolved and new. That is a silent,
 *     confusing failure of the thing the loop exists to prove.
 *   - **No network at check time.** Checks are pure functions over stored data.
 *   - **`npx` with no first-run download**, and offline operation.
 *
 * The pruned artefact is 31 KB against a 1.5 MB source — 98% of the vocabulary
 * is descriptions, examples and property definitions we do not need.
 *
 *   node tools/fetch-schema-hierarchy.ts
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const SOURCE = 'https://schema.org/version/latest/schemaorg-current-https.jsonld';
const OUTPUT = path.resolve('data', 'schema-subclasses.json');

function idsOf(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(idsOf);
  if (value !== null && typeof value === 'object') {
    const id = (value as Record<string, unknown>)['@id'];
    return typeof id === 'string' ? [id] : [];
  }
  return [];
}

const response = await fetch(SOURCE, { headers: { accept: 'application/ld+json' } });
if (!response.ok) throw new Error(`${SOURCE} returned HTTP ${response.status}`);

const body = await response.text();

// schema.org does not carry a version string inside the document, so pin on a
// content hash instead. That is strictly better for our purposes: it is
// verifiable, and it identifies exactly the bytes this artefact was derived
// from rather than a label that could be reused.
const sourceSha256 = createHash('sha256').update(body).digest('hex');
const lastModified = response.headers.get('last-modified');

const document = JSON.parse(body) as { '@graph': Record<string, unknown>[] };

const subclasses: Record<string, string[]> = {};

/**
 * Properties whose range includes `URL`.
 *
 * Needed because `graph.dangling-reference` cannot otherwise tell an entity
 * reference from a plain URL: schema.org types both as `@id`, so after
 * expansion `publisher: {"@id": "…/#org"}` and `target: {"@id": "…/#respond"}`
 * are indistinguishable by shape.
 *
 * The shakedown made the cost concrete — 38 false positives on one site, all
 * of them `target` pointing at a WordPress `#respond` comment anchor. A
 * hand-maintained blacklist would have papered over it; the vocabulary already
 * knows the answer.
 */
const urlValuedProperties: string[] = [];

for (const entry of document['@graph']) {
  const id = entry['@id'];
  if (typeof id !== 'string' || !id.startsWith('schema:')) continue;

  const types = idsOf(entry['@type']);
  const bare = id.slice('schema:'.length);

  if (types.includes('rdf:Property')) {
    if (idsOf(entry['schema:rangeIncludes']).includes('schema:URL')) urlValuedProperties.push(bare);
    continue;
  }

  if (!types.includes('rdfs:Class')) continue;

  const parents = idsOf(entry['rdfs:subClassOf'])
    .filter((parent) => parent.startsWith('schema:'))
    .map((parent) => parent.slice('schema:'.length))
    .sort();

  // Root classes carry no edges and are recoverable as "referenced but absent",
  // so omitting them keeps the file to what is actually needed.
  if (parents.length > 0) subclasses[bare] = parents;
}

const ordered = Object.fromEntries(Object.entries(subclasses).sort(([left], [right]) => (left < right ? -1 : 1)));

const artefact = {
  schema_version: 1,

  _license: [
    'The schema.org vocabulary is licensed under Creative Commons',
    'Attribution-ShareAlike 3.0 (CC BY-SA 3.0), per https://schema.org/docs/terms.html.',
    '',
    'This file is a DERIVATIVE of that vocabulary — the rdfs:subClassOf edges,',
    'with everything else removed — and is therefore also CC BY-SA 3.0. It is',
    'NOT covered by the AGPL-3.0 that applies to the rest of this repository.',
    'The two sit side by side as mere aggregation; neither licence reaches the',
    'other.',
    '',
    'Regenerate with: node tools/fetch-schema-hierarchy.ts',
  ],

  license: 'CC BY-SA 3.0',
  license_url: 'http://creativecommons.org/licenses/by-sa/3.0/',
  attribution: 'schema.org — https://schema.org/',
  source: SOURCE,
  source_sha256: sourceSha256,
  source_last_modified: lastModified,
  retrieved: new Date().toISOString().slice(0, 10),
  class_count: Object.keys(ordered).length,
  edge_count: Object.values(ordered).flat().length,
  url_valued_property_count: urlValuedProperties.length,

  subclasses: ordered,
  url_valued_properties: [...urlValuedProperties].sort(),
};

await fs.writeFile(OUTPUT, `${JSON.stringify(artefact, null, 1)}\n`);

const bytes = (await fs.stat(OUTPUT)).size;
process.stderr.write(
  `wrote ${OUTPUT}\n` +
    `  source sha256 ${sourceSha256.slice(0, 16)}…${lastModified === null ? '' : ` (Last-Modified: ${lastModified})`}\n` +
    `  ${Object.keys(ordered).length} classes with parents, ${Object.values(ordered).flat().length} edges\n` +
    `  ${urlValuedProperties.length} URL-valued properties\n` +
    `  ${(bytes / 1024).toFixed(1)} KB\n`,
);
