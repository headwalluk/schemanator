/**
 * Regenerate `data/schema-context.json` from schema.org.
 *
 * Maintenance script, sibling of `fetch-schema-hierarchy.ts`. Same reasoning,
 * plus one that is specific and urgent:
 *
 * **`jsonld.js` fetches `https://schema.org/` for every document by default.**
 * Extracting a 500-page crawl would mean 500+ requests to schema.org for a file
 * that changes a few times a year. That is unacceptable behaviour from a tool
 * whose first principle is politeness (`02`), and it would make extraction
 * fail entirely when offline.
 *
 *   node tools/fetch-schema-context.ts
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const SOURCE = 'https://schema.org/docs/jsonldcontext.json';
const OUTPUT = path.resolve('data', 'schema-context.json');

const response = await fetch(SOURCE, {
  headers: { accept: 'application/ld+json, application/json' },
});
if (!response.ok) throw new Error(`${SOURCE} returned HTTP ${response.status}`);

const body = await response.text();
const context = JSON.parse(body) as Record<string, unknown>;

if (context['@context'] === undefined) {
  throw new Error(`${SOURCE}: no "@context" key — schema.org may have changed the document shape`);
}

const artefact = {
  schema_version: 1,

  _license: [
    'Derived from the schema.org vocabulary, licensed CC BY-SA 3.0 —',
    'https://schema.org/docs/terms.html. NOT covered by this repository’s',
    'AGPL-3.0. See NOTICE.',
    '',
    'Regenerate with: node tools/fetch-schema-context.ts',
  ],
  license: 'CC BY-SA 3.0',
  license_url: 'http://creativecommons.org/licenses/by-sa/3.0/',
  attribution: 'schema.org — https://schema.org/',
  source: SOURCE,
  source_sha256: createHash('sha256').update(body).digest('hex'),
  retrieved: new Date().toISOString().slice(0, 10),

  context: context['@context'],
};

await fs.writeFile(OUTPUT, `${JSON.stringify(artefact, null, 1)}\n`);

const bytes = (await fs.stat(OUTPUT)).size;
process.stderr.write(
  `wrote ${OUTPUT}\n  ${Object.keys(context['@context'] as object).length} context terms, ${(bytes / 1024).toFixed(1)} KB\n`,
);
