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

/** Origin and path: `?ver=` changes per request on some sites, and is not a different file. */
function scriptKey(src: string): string {
  const parsed = URL.parse(src);
  return parsed === null ? src : `${parsed.origin}${parsed.pathname}`;
}

interface ScriptSeen {
  src: string;
  id: string | null;
  pageIds: Set<string>;
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
    (left, right) => right.pageIds.size - left.pageIds.size || left.src.localeCompare(right.src),
  );
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
      `publish their scripts on their own domains or on a CDN.${handleNote} ` +
      `**This is not a malware verdict** — schemanator does not fetch or read the script — but ` +
      `if nobody responsible for the site recognises it, treat the site as possibly compromised.`,
    expected: "Scripts served from this site, its own CDN, or the vendor's own domain.",
    ...sampleObserved(
      scripts.map((script) => ({
        value: script.src,
        detail:
          script.id === null
            ? `on ${script.pageIds.size} page(s)`
            : `id "${script.id}", on ${script.pageIds.size} page(s)`,
        observation_count: script.pageIds.size,
        page_count: script.pageIds.size,
        provenance: [],
      })),
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
          src: script.src,
          id: script.id,
          pageIds: new Set<string>(),
        };
        entry.pageIds.add(page.page_id);
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
