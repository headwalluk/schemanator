/**
 * The JSON-LD document loader.
 *
 * `jsonld.js` resolves `@context` by fetching it. Left alone, extracting a
 * 100-page crawl means 100+ requests to schema.org for a file that changes a
 * few times a year — unacceptable from a tool whose first principle is
 * politeness, and it makes extraction fail outright when offline.
 *
 * So the loader is **static and closed**. schema.org is served from
 * `data/schema-context.json`; anything else is refused, and the refusal becomes
 * a `syntax.unresolvable-context` finding (`04`) rather than a silent fetch.
 *
 * Refusing rather than fetching is deliberate. Fetching arbitrary URLs named by
 * crawled third-party content is a request-forgery shape we do not need, and a
 * crawl that quietly depends on some stranger's server being up is not
 * reproducible. If real sites turn out to need it, add an explicit opt-in.
 */

import fs from 'node:fs';
import path from 'node:path';

import { packageRoot } from '../runtime.ts';

/**
 * Every spelling of the schema.org context seen in the wild.
 *
 * `03` calls this out and it is not hypothetical: http and https both appear,
 * with and without the trailing slash, and a loader that matches only one
 * spelling fails on any mixed-vintage site.
 */
const SCHEMA_ORG_ALIASES = [
  'http://schema.org',
  'http://schema.org/',
  'https://schema.org',
  'https://schema.org/',
  'http://www.schema.org',
  'http://www.schema.org/',
  'https://www.schema.org',
  'https://www.schema.org/',
  'http://schema.org/docs/jsonldcontext.json',
  'https://schema.org/docs/jsonldcontext.json',
];

export class UnresolvableContextError extends Error {
  readonly url: string;

  constructor(url: string) {
    super(
      `refusing to fetch remote context ${url}. Only the bundled schema.org context is available; ` +
        'a crawl that depends on a third-party server being reachable is not reproducible.',
    );
    this.name = 'UnresolvableContextError';
    this.url = url;
  }
}

let cachedContext: unknown = null;

function schemaContext(): unknown {
  if (cachedContext !== null) return cachedContext;

  const target = path.join(packageRoot(), 'data', 'schema-context.json');
  const parsed = JSON.parse(fs.readFileSync(target, 'utf8')) as { context?: unknown };
  if (parsed.context === undefined) throw new Error(`${target}: missing "context" key`);

  cachedContext = { '@context': parsed.context };
  return cachedContext;
}

interface RemoteDocument {
  contextUrl: null;
  document: unknown;
  documentUrl: string;
}

/** A `jsonld.js` documentLoader that never touches the network. */
export function staticDocumentLoader(url: string): Promise<RemoteDocument> {
  const normalised = url.replace(/#.*$/, '');
  if (SCHEMA_ORG_ALIASES.includes(normalised)) {
    return Promise.resolve({ contextUrl: null, document: schemaContext(), documentUrl: url });
  }
  return Promise.reject(new UnresolvableContextError(url));
}

/** True when this URL is one we can serve without the network. */
export function isBundledContext(url: string): boolean {
  return SCHEMA_ORG_ALIASES.includes(url.replace(/#.*$/, ''));
}
