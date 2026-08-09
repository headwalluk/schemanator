/**
 * URL canonicalisation.
 *
 * This is not a utility detail. The whole tool is about identity: if two
 * spellings of one page land in two directories, schemanator reports phantom
 * contradictions. See `dev-notes/02-crawler-requirements.md`.
 *
 * The rule that catches people out is what we deliberately do NOT normalise:
 * trailing slash, `www` vs bare host, and `http` vs `https` are all preserved
 * exactly as given, because the divergence between them is itself a finding.
 * Helpfully collapsing them would destroy the signal we exist to report.
 */

/** Query parameters stripped by default. `utm_*` is matched by prefix. */
export const DEFAULT_TRACKING_PARAMS: readonly string[] = [
  'fbclid',
  'gclid',
  'msclkid',
  'mc_cid',
  'mc_eid',
  '_ga',
  '_gl',
  'igshid',
  'ttclid',
  'twclid',
];

/** Prefixes stripped by default. */
export const DEFAULT_TRACKING_PREFIXES: readonly string[] = ['utm_'];

export interface CanonicaliseOptions {
  /** Exact-match parameter names to strip. Defaults to {@link DEFAULT_TRACKING_PARAMS}. */
  trackingParams?: readonly string[];
  /** Parameter name prefixes to strip. Defaults to {@link DEFAULT_TRACKING_PREFIXES}. */
  trackingPrefixes?: readonly string[];
  /** Sort remaining query parameters by key. Default true; `--no-sort-query` disables. */
  sortQuery?: boolean;
  /** Base URL for resolving a relative input. */
  base?: string;
}

export class UrlCanonicalisationError extends Error {
  readonly input: string;

  constructor(input: string, reason: string) {
    super(`cannot canonicalise ${JSON.stringify(input)}: ${reason}`);
    this.name = 'UrlCanonicalisationError';
    this.input = input;
  }
}

/** RFC 3986 unreserved set. Percent-encoding these is legal but non-canonical. */
const UNRESERVED = /^[A-Za-z0-9\-._~]$/;

/**
 * Decode percent-encodings of unreserved characters; uppercase the hex of
 * everything else. `%7Efoo%2fbar` becomes `~foo%2Fbar`.
 *
 * Deliberately byte-oriented and left alone on anything malformed: `%zz` and a
 * bare trailing `%` are passed through untouched rather than throwing. Broken
 * encoding in a sitemap is the site's problem to report, not ours to crash on.
 */
function normalisePercentEncoding(component: string): string {
  return component.replace(/%[0-9A-Fa-f]{2}/g, (match) => {
    const character = String.fromCharCode(Number.parseInt(match.slice(1), 16));
    return UNRESERVED.test(character) ? character : match.toUpperCase();
  });
}

interface QueryPair {
  rawKey: string;
  decodedKey: string;
  rawValue: string | undefined;
}

function parseQuery(search: string): QueryPair[] {
  const withoutPrefix = search.startsWith('?') ? search.slice(1) : search;
  if (withoutPrefix === '') return [];

  return withoutPrefix
    .split('&')
    .filter((segment) => segment !== '')
    .map((segment) => {
      const separatorIndex = segment.indexOf('=');
      const rawKey = separatorIndex === -1 ? segment : segment.slice(0, separatorIndex);
      const rawValue = separatorIndex === -1 ? undefined : segment.slice(separatorIndex + 1);

      // Decode the key only for tracking-parameter matching. `utm%5Fsource`
      // and `utm_source` are the same parameter and both appear in the wild.
      let decodedKey: string;
      try {
        decodedKey = decodeURIComponent(rawKey);
      } catch {
        decodedKey = rawKey;
      }

      return { rawKey, decodedKey, rawValue };
    });
}

function serialiseQuery(pairs: readonly QueryPair[]): string {
  return pairs
    .map((pair) => {
      const key = normalisePercentEncoding(pair.rawKey);
      if (pair.rawValue === undefined) return key;
      return `${key}=${normalisePercentEncoding(pair.rawValue)}`;
    })
    .join('&');
}

/**
 * Canonicalise a URL for storage, hashing and comparison.
 *
 * @throws {UrlCanonicalisationError} on unparseable input or a non-HTTP scheme.
 */
export function canonicaliseUrl(input: string, options: CanonicaliseOptions = {}): string {
  const {
    trackingParams = DEFAULT_TRACKING_PARAMS,
    trackingPrefixes = DEFAULT_TRACKING_PREFIXES,
    sortQuery = true,
    base,
  } = options;

  // Leading/trailing whitespace is endemic in sitemap XML text nodes.
  const trimmed = input.trim();
  if (trimmed === '') throw new UrlCanonicalisationError(input, 'empty');

  let parsed: URL;
  try {
    // The WHATWG parser gives us scheme/host lowercasing, IDN-to-punycode,
    // default-port stripping and dot-segment resolution for free. Those four
    // are steps 1-3 of the spec in `02` and are not worth reimplementing.
    parsed = base === undefined ? new URL(trimmed) : new URL(trimmed, base);
  } catch {
    throw new UrlCanonicalisationError(input, 'unparseable');
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new UrlCanonicalisationError(input, `unsupported scheme ${parsed.protocol}`);
  }

  // Credentials are dropped rather than preserved. We never authenticate, and
  // carrying them would leak them into page ids, log lines and the manifest.
  const host = parsed.host;
  const path = normalisePercentEncoding(parsed.pathname);

  const trackingSet = new Set(trackingParams.map((name) => name.toLowerCase()));
  const retained = parseQuery(parsed.search).filter((pair) => {
    const key = pair.decodedKey.toLowerCase();
    if (trackingSet.has(key)) return false;
    return !trackingPrefixes.some((prefix) => key.startsWith(prefix.toLowerCase()));
  });

  if (sortQuery) {
    // Sort by key only, and rely on the sort being stable so that repeated
    // keys (`?tag=a&tag=b`) keep their relative order. Reordering those would
    // change meaning on any site that reads them positionally.
    retained.sort((left, right) =>
      left.decodedKey < right.decodedKey ? -1 : left.decodedKey > right.decodedKey ? 1 : 0,
    );
  }

  const query = serialiseQuery(retained);

  // The fragment is dropped: it is never sent to the server, so it cannot
  // identify a distinct response.
  return `${parsed.protocol}//${host}${path}${query === '' ? '' : `?${query}`}`;
}

/** Non-throwing wrapper, for the many places that must record a rejection and carry on. */
export function tryCanonicaliseUrl(
  input: string,
  options: CanonicaliseOptions = {},
): { ok: true; url: string } | { ok: false; reason: string } {
  try {
    return { ok: true, url: canonicaliseUrl(input, options) };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * True when two URLs are the same page under our rules.
 *
 * Note this is strict about the things `02` refuses to normalise: `/foo` and
 * `/foo/` are NOT the same page here, and neither are the `www` and bare-host
 * spellings. Callers wanting the looser comparison want a finding instead.
 */
export function sameCanonicalUrl(
  left: string,
  right: string,
  options: CanonicaliseOptions = {},
): boolean {
  const canonicalLeft = tryCanonicaliseUrl(left, options);
  const canonicalRight = tryCanonicaliseUrl(right, options);
  if (!canonicalLeft.ok || !canonicalRight.ok) return false;
  return canonicalLeft.url === canonicalRight.url;
}

/** The registrable host of a URL, for the per-host politeness queue. */
export function hostKey(url: string): string {
  return new URL(url).host;
}

/**
 * Coerce operator input into a URL. **CLI boundary only.**
 *
 * `schemanator headwall-hosting.com` should work — nobody types the scheme.
 * But this deliberately is NOT part of {@link canonicaliseUrl}, because that
 * function answers "are these the same resource?" and must stay strict. If
 * canonicalisation guessed at schemes, `example.com` and `https://example.com`
 * would compare equal, and `02` is emphatic that http/https divergence is a
 * finding rather than something to paper over.
 *
 * So: guess once, at the edge, where a human typed something. Everything
 * downstream — sitemap entries, `@id`s, `Location` headers — stays strict.
 *
 * Defaults to `https`. A site that is http-only will fail loudly, which is the
 * right outcome in 2026: it is worth the operator knowing.
 */
export function coerceToUrl(input: string): string {
  const trimmed = input.trim();
  if (trimmed === '') throw new UrlCanonicalisationError(input, 'empty');

  // Already carries a scheme — including one we will reject later.
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) return trimmed;

  // Protocol-relative.
  if (trimmed.startsWith('//')) return `https:${trimmed}`;

  return `https://${trimmed}`;
}

/**
 * Does this look like a hostname rather than a subcommand?
 *
 * Used to tell `schemanator crawl` (a command) from `schemanator example.com`
 * (a target). A hostname needs a dot or a scheme; a bare word is a command.
 */
export function looksLikeTarget(input: string): boolean {
  const trimmed = input.trim();
  return trimmed.includes('.') || trimmed.includes('://');
}
