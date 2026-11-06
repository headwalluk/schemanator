/**
 * `url.file-sharing-script` — pages loading a script from a personal
 * file-sharing or paste host, as named by `data/file-sharing-hosts.json`.
 *
 * A presence claim over `page_facts.external_scripts`, which extraction reads
 * from `<script src>` attributes only. It never fetches or reads the script:
 * the finding is where the code comes from, not what it does.
 */

import fs from 'node:fs';
import path from 'node:path';

import { packageRoot } from '../runtime.ts';
import type { PageRecord } from '../store/workdir.ts';
import { dedupeByUrl } from './indexing.ts';
import { findingId, sampleObserved, type Check, type Finding } from './framework.ts';

const FILE_SHARING_SCRIPT = 'url.file-sharing-script';

/** The suffix WordPress appends to an enqueue handle to make the element's `id`. */
const WORDPRESS_HANDLE_SUFFIX = '-js';

const MATCH_KINDS = ['exact', 'suffix'] as const;
type MatchKind = (typeof MATCH_KINDS)[number];

export interface FileSharingHost {
  /** Lowercase hostname. With `suffix`, also every subdomain of it. */
  host: string;
  match: MatchKind;
  service: string;
  why: string;
}

export interface FileSharingHosts {
  schemaVersion: number;
  hosts: FileSharingHost[];
}

const isMatchKind = (value: unknown): value is MatchKind =>
  typeof value === 'string' && (MATCH_KINDS as readonly string[]).includes(value);

/** Validate `data/file-sharing-hosts.json`; throws naming the file and the entry. */
export function parseFileSharingHosts(json: string, source = '<inline>'): FileSharingHosts {
  let raw: { schema_version?: unknown; hosts?: unknown };
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
  if (!Array.isArray(raw.hosts)) throw new Error(`${source}: missing "hosts" array`);
  if (raw.hosts.length === 0) throw new Error(`${source}: "hosts" is empty`);

  const seen = new Set<string>();
  const hosts = raw.hosts.map((entry, index): FileSharingHost => {
    const record = (typeof entry === 'object' && entry !== null ? entry : {}) as Record<
      string,
      unknown
    >;
    const where = `${source}: hosts[${index}]`;
    const host = record['host'];
    if (typeof host !== 'string' || host === '') throw new Error(`${where} needs a "host"`);
    // A scheme, path or port here would never equal a parsed hostname, so the
    // entry would silently match nothing.
    if (!/^[a-z0-9.-]+$/.test(host) || host.startsWith('.') || host.endsWith('.')) {
      throw new Error(`${where} "host" must be a bare lowercase hostname, got "${host}"`);
    }
    if (seen.has(host)) throw new Error(`${where} repeats "${host}"`);
    seen.add(host);
    if (!isMatchKind(record['match'])) {
      throw new Error(`${where} needs "match" of ${MATCH_KINDS.join(' | ')}`);
    }
    const service = record['service'];
    if (typeof service !== 'string' || service === '') {
      throw new Error(`${where} needs a "service"`);
    }
    const why = record['why'];
    if (typeof why !== 'string' || why === '') throw new Error(`${where} needs a "why"`);
    return { host, match: record['match'], service, why };
  });

  return { schemaVersion: raw.schema_version, hosts };
}

let cached: FileSharingHosts | null = null;

/** The shipped rules file, parsed once; or the file at `configPath`. */
export function loadFileSharingHosts(configPath?: string): FileSharingHosts {
  if (configPath === undefined && cached !== null) return cached;
  const target = configPath ?? path.join(packageRoot(), 'data', 'file-sharing-hosts.json');
  const parsed = parseFileSharingHosts(fs.readFileSync(target, 'utf8'), target);
  if (configPath === undefined) cached = parsed;
  return parsed;
}

/** The rule a hostname falls under, or null. */
export function fileSharingHost(hostname: string, rules: FileSharingHosts): FileSharingHost | null {
  const lower = hostname.toLowerCase();
  return (
    rules.hosts.find((rule) =>
      rule.match === 'exact'
        ? lower === rule.host
        : lower === rule.host || lower.endsWith(`.${rule.host}`),
    ) ?? null
  );
}

/**
 * Origin and path, which is the reported value.
 *
 * The query is dropped because `?ver=` can change on every request, and
 * `--since` compares `observed[].value`: kept, the finding would read as
 * Changed on every run of an unchanged site.
 */
function scriptKey(src: string): string {
  const parsed = URL.parse(src);
  return parsed === null ? src : `${parsed.origin}${parsed.pathname}`;
}

interface ScriptSeen {
  key: string;
  id: string | null;
  pageIds: Set<string>;
  /** Every value seen for each query parameter, across pages. */
  queryValues: Map<string, Set<string>>;
}

/** Record one page's query string against the script it loads. */
function noteQuery(script: ScriptSeen, src: string): void {
  const parsed = URL.parse(src);
  if (parsed === null) return;
  for (const [name, value] of parsed.searchParams) {
    const values = script.queryValues.get(name) ?? new Set<string>();
    values.add(value);
    script.queryValues.set(name, values);
  }
}

/** How each varying query parameter varied, e.g. "`ver` differs on every page"; empty when none did. */
function queryVariation(script: ScriptSeen): string[] {
  return [...script.queryValues.entries()]
    .filter(([, values]) => values.size > 1)
    .map(([name, values]) =>
      values.size === script.pageIds.size
        ? `\`${name}\` differs on every page`
        : `\`${name}\` takes ${values.size} values across ${script.pageIds.size} pages`,
    );
}

interface HostSeen {
  rule: FileSharingHost;
  host: string;
  scripts: Map<string, ScriptSeen>;
  pages: Map<string, PageRecord>;
}

/** One finding for one file-sharing host. */
function hostFinding(seen: HostSeen): Finding {
  const scripts = [...seen.scripts.values()].sort(
    (left, right) => right.pageIds.size - left.pageIds.size || left.key.localeCompare(right.key),
  );
  const varies = scripts.some((script) => queryVariation(script).length > 0);
  const variationNote = varies
    ? ' Its query string changes from page to page, so the URL is generated per request: every ' +
      'visit fetches the file afresh, and no copy is cached that could be compared later.'
    : '';
  const handles = [
    ...new Set(
      scripts
        .map((script) => script.id)
        .filter((id): id is string => id !== null && id.endsWith(WORDPRESS_HANDLE_SUFFIX))
        .map((id) => id.slice(0, -WORDPRESS_HANDLE_SUFFIX.length)),
    ),
  ];
  const handleNote =
    handles.length === 0
      ? ''
      : ` The element id ${handles.map((handle) => `\`${handle}-js\``).join(', ')} is the form ` +
        `WordPress gives a script enqueued under the handle ` +
        `${handles.map((handle) => `\`${handle}\``).join(', ')}, so some theme or plugin code on ` +
        `the server is adding it.`;
  const searchFor =
    handles.length === 0
      ? `\`${seen.host}\``
      : `\`${seen.host}\` and ${handles.map((handle) => `\`${handle}\``).join(', ')}`;
  const pageCount = seen.pages.size;

  return {
    finding_id: findingId(FILE_SHARING_SCRIPT, seen.host),
    check: FILE_SHARING_SCRIPT,
    severity: 'warning',
    origin: 'check',
    title: `Script loaded from ${seen.rule.service} (${seen.host}) on ${pageCount} page(s)`,
    subject: { kind: 'site', id: seen.host },
    summary:
      `${pageCount} page(s) load ${scripts.length} script(s) from ${seen.host}, which serves ` +
      `files uploaded to a ${seen.rule.service} account. That is a file-sharing service, not a ` +
      `CDN: whoever holds the account can change what every visitor's browser runs, at any ` +
      `time, with no release and no trace on this site. Plugins, themes and tracking services ` +
      `publish their scripts on their own domains or on a CDN.${variationNote}${handleNote} ` +
      `**This is not a malware verdict** — schemanator does not fetch or read the script — but ` +
      `if nobody responsible for the site recognises it, treat the site as possibly compromised.`,
    expected: "Scripts served from this site, its own CDN, or the vendor's own domain.",
    ...sampleObserved(
      scripts.map((script) => {
        const notes = [
          ...(script.id === null ? [] : [`id "${script.id}"`]),
          ...queryVariation(script),
        ];
        return {
          value: script.key,
          ...(notes.length === 0 ? {} : { detail: notes.join(', ') }),
          observation_count: script.pageIds.size,
          page_count: script.pageIds.size,
          provenance: [],
        };
      }),
    ),
    pages_affected: pageCount,
    coverage_qualified: false,
    remediation:
      `Find what adds it: search the theme, plugin and must-use plugin files for ${searchFor}, ` +
      `and the database too, since header and footer script settings, widgets and options ` +
      `can all hold injected markup. If nobody recognises it, run a malware scan and review ` +
      `recently modified files and administrator accounts before removing it, because removing ` +
      `the tag leaves whatever put it there. If it is recognised, move the file onto this site ` +
      `or the vendor's CDN and load it from there.`,
    tradeoff: null,
    page_ids: [...seen.pages.keys()],
  };
}

const fileSharingScript: Check = {
  id: FILE_SHARING_SCRIPT,
  group: 'url',
  run({ pages, fileSharingHosts }) {
    const byHost = new Map<string, HostSeen>();
    const fetched = dedupeByUrl(
      pages.filter((page) => page.http_status === 200 && page.page_facts !== null),
    );

    for (const page of fetched) {
      for (const script of page.page_facts?.external_scripts ?? []) {
        const rule = fileSharingHost(script.host, fileSharingHosts);
        if (rule === null) continue;

        const seen = byHost.get(script.host) ?? {
          rule,
          host: script.host,
          scripts: new Map<string, ScriptSeen>(),
          pages: new Map<string, PageRecord>(),
        };
        const key = scriptKey(script.src);
        const entry = seen.scripts.get(key) ?? {
          key,
          id: script.id,
          pageIds: new Set<string>(),
          queryValues: new Map<string, Set<string>>(),
        };
        entry.pageIds.add(page.page_id);
        noteQuery(entry, script.src);
        seen.scripts.set(key, entry);
        seen.pages.set(page.page_id, page);
        byHost.set(script.host, seen);
      }
    }

    return [...byHost.values()]
      .sort((left, right) => left.host.localeCompare(right.host))
      .map(hostFinding);
  },
};

export const FILE_SHARING_CHECKS: readonly Check[] = [fileSharingScript];
