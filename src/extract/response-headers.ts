/**
 * The response headers lifted from `meta.json` onto the page record.
 *
 * The crawl stores every header a page was served with; the manifest carries
 * only these, because `sites` reads it whole and nothing else is checked.
 */

/** Header names as the fetcher stores them: lowercase, per the Fetch API. */
export const HEADER = {
  contentSecurityPolicy: 'content-security-policy',
  strictTransportSecurity: 'strict-transport-security',
  referrerPolicy: 'referrer-policy',
  contentTypeOptions: 'x-content-type-options',
  frameOptions: 'x-frame-options',
  permissionsPolicy: 'permissions-policy',
  robotsTag: 'x-robots-tag',
} as const;

export type RecordedHeader = (typeof HEADER)[keyof typeof HEADER];

const RECORDED: ReadonlySet<string> = new Set(Object.values(HEADER));

/** The recorded subset of a full header map, keys lowercased. */
export function selectRecordedHeaders(headers: Record<string, string>): Record<string, string> {
  const selected: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (RECORDED.has(lower)) selected[lower] = value;
  }
  return selected;
}

/** The `headers` object of a parsed `meta.json`; throws naming the file when it is malformed. */
export function headersFromMeta(meta: unknown, file: string): Record<string, string> | null {
  if (typeof meta !== 'object' || meta === null || Array.isArray(meta)) {
    throw new Error(`${file}: expected a JSON object`);
  }
  const headers = (meta as { headers?: unknown }).headers;
  if (headers === undefined) return null;
  if (typeof headers !== 'object' || headers === null || Array.isArray(headers)) {
    throw new Error(`${file}: "headers" must be an object`);
  }

  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (typeof value !== 'string') {
      throw new Error(`${file}: header "${name}" must be a string`);
    }
    result[name] = value;
  }
  return result;
}

/** X-Robots-Tag directives that take a `name: value` argument, so are not a user-agent prefix. */
const ROBOTS_ARGUMENT_DIRECTIVES: ReadonlySet<string> = new Set([
  'unavailable_after',
  'max-snippet',
  'max-image-preview',
  'max-video-preview',
]);

/**
 * Whether an X-Robots-Tag value says `noindex` (or `none`) to every crawler.
 *
 * A `googlebot:`-style prefix scopes the directives after it to that crawler,
 * and is skipped, matching how only `<meta name="robots">` is read.
 */
export function robotsTagNoindex(value: string | undefined): boolean {
  let scopedTo: string | null = null;
  let noindex = false;
  for (const part of (value ?? '').split(',')) {
    let directive = part.trim().toLowerCase();
    const prefixed = /^([a-z0-9_-]+)\s*:\s*(.*)$/.exec(directive);
    if (prefixed !== null && !ROBOTS_ARGUMENT_DIRECTIVES.has(prefixed[1] ?? '')) {
      scopedTo = prefixed[1] ?? null;
      directive = prefixed[2] ?? '';
    }
    if (scopedTo === null && (directive === 'noindex' || directive === 'none')) noindex = true;
  }
  return noindex;
}
