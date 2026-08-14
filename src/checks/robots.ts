/**
 * Group `robots` — can a machine fetch the site at all?
 *
 * Stage 1 of `07`: the first thing that can stop a consumer, before indexing,
 * before extraction, before anything else. If `robots.txt` says no, nothing
 * downstream matters.
 *
 * ## Why this parses the raw file rather than reusing the crawler's policy
 *
 * `crawl/robots.parsed.json` records what the *crawl* needed — which rules
 * applied to our own user agent, the crawl delay, the sitemap list. It does not
 * keep the per-agent groups, because nothing needed them until now.
 *
 * The raw file is stored verbatim at `crawl/robots.txt` (`02` requires it), and
 * these checks read that. Re-parsing is cheap and keeps the crawler's policy
 * code focused on the one question it exists to answer.
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

import { packageRoot } from '../runtime.ts';
import { findingId, sampleObserved, type Check, type Finding } from './framework.ts';

// --- the crawler list --------------------------------------------------------

export type CrawlerPurpose = 'training' | 'retrieval' | 'both';

export interface AiCrawler {
  token: string;
  operator: string;
  purpose: CrawlerPurpose;
  source: string;
  note?: string;
}

export interface AiCrawlers {
  schemaVersion: number;
  crawlers: AiCrawler[];
}

function isPurpose(value: unknown): value is CrawlerPurpose {
  return value === 'training' || value === 'retrieval' || value === 'both';
}

/** Strict and throwing, for `cardinality.ts`'s reason: a silently empty list checks nothing. */
export function parseAiCrawlers(json: string, source = '<inline>'): AiCrawlers {
  let raw: { schema_version?: unknown; crawlers?: unknown };
  try {
    raw = JSON.parse(json) as typeof raw;
  } catch (error) {
    throw new Error(
      `${source}: not valid JSON — ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }

  if (typeof raw.schema_version !== 'number')
    throw new Error(`${source}: missing "schema_version"`);
  if (!Array.isArray(raw.crawlers)) throw new Error(`${source}: missing "crawlers" array`);
  if (raw.crawlers.length === 0) throw new Error(`${source}: "crawlers" is empty`);

  const crawlers = raw.crawlers.map((entry, index): AiCrawler => {
    const record = entry as Record<string, unknown>;
    const where = `${source}: crawlers[${index}]`;
    if (typeof record['token'] !== 'string') throw new Error(`${where} needs a "token"`);
    if (typeof record['operator'] !== 'string') throw new Error(`${where} needs an "operator"`);
    if (!isPurpose(record['purpose'])) {
      throw new Error(`${where} needs "purpose" of training | retrieval | both`);
    }
    if (typeof record['source'] !== 'string') {
      throw new Error(`${where} must cite its "source" — an unciteable token is folklore`);
    }
    return {
      token: record['token'],
      operator: record['operator'],
      purpose: record['purpose'],
      source: record['source'],
      ...(typeof record['note'] === 'string' ? { note: record['note'] } : {}),
    };
  });

  return { schemaVersion: raw.schema_version, crawlers };
}

let cached: AiCrawlers | null = null;

export function loadAiCrawlers(configPath?: string): AiCrawlers {
  if (configPath === undefined && cached !== null) return cached;
  const target = configPath ?? path.join(packageRoot(), 'data', 'ai-crawlers.json');
  const parsed = parseAiCrawlers(fs.readFileSync(target, 'utf8'), target);
  if (configPath === undefined) cached = parsed;
  return parsed;
}

// --- parsing robots.txt ------------------------------------------------------

export interface RobotsGroup {
  /** Lower-cased tokens. A group may name several agents. */
  agents: string[];
  disallow: string[];
  allow: string[];
}

export interface RobotsFile {
  /** Verbatim, as served. Null when the file was absent or unreadable. */
  text: string | null;
  groups: RobotsGroup[];
  sitemaps: string[];
}

/**
 * Parse `robots.txt` into its user-agent groups.
 *
 * Grouping follows RFC 9309: consecutive `User-agent` lines accumulate into one
 * group, and the first rule line closes the agent list. The next `User-agent`
 * after a rule starts a fresh group.
 *
 * **A file may repeat an agent in several groups, and real ones do.** One corpus
 * site's `robots.txt` carries two separate `User-agent: *` blocks — the site's
 * own, and a second appended inside a `# START YOAST BLOCK` marker. Taking "the
 * first matching group" would silently ignore half the file, so every matching
 * group is returned and callers union them.
 */
export function parseRobotsTxt(text: string): RobotsFile {
  const groups: RobotsGroup[] = [];
  const sitemaps: string[] = [];

  let current: RobotsGroup | null = null;
  let expectingAgents = false;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, '').trim();
    if (line === '') continue;

    const colon = line.indexOf(':');
    if (colon === -1) continue;
    const field = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();

    if (field === 'sitemap') {
      if (value !== '') sitemaps.push(value);
      continue;
    }

    if (field === 'user-agent') {
      if (current === null || !expectingAgents) {
        current = { agents: [], disallow: [], allow: [] };
        groups.push(current);
        expectingAgents = true;
      }
      if (value !== '') current.agents.push(value.toLowerCase());
      continue;
    }

    if (field === 'disallow' || field === 'allow') {
      if (current === null) continue;
      expectingAgents = false;
      // An empty `Disallow:` means "nothing is disallowed" and must not be
      // recorded as a rule — it is the idiom for allowing everything.
      if (value !== '') current[field === 'disallow' ? 'disallow' : 'allow'].push(value);
    }
  }

  return { text, groups, sitemaps };
}

/** Groups naming this agent *specifically*, ignoring the wildcard. */
function specificGroupsFor(robots: RobotsFile, token: string): RobotsGroup[] {
  const wanted = token.toLowerCase();
  return robots.groups.filter((group) => group.agents.includes(wanted));
}

/** Does any rule in these groups block the whole site? */
function blocksEverything(groups: readonly RobotsGroup[]): boolean {
  return groups.some(
    (group) => group.disallow.includes('/') && !group.allow.some((rule) => rule === '/'),
  );
}

/**
 * Read the `robots.txt` a crawl stored verbatim, and parse it.
 *
 * Needs no network: `02` requires the file to be kept, so this works on any
 * crawl old enough to have one. **Absence returns null, never an empty
 * permissive file** — the checks must be able to tell "no rules" from "we do
 * not know", and `02` is emphatic that an unreadable robots.txt is not
 * permission.
 */
export async function readStoredRobots(crawlDir: string): Promise<RobotsFile | null> {
  try {
    return parseRobotsTxt(await fsp.readFile(path.join(crawlDir, 'robots.txt'), 'utf8'));
  } catch {
    return null;
  }
}

// --- robots.ai-crawler-blocked ----------------------------------------------

/**
 * AI crawlers disallowed.
 *
 * **A Warning, and the wording matters more than the rule.** Blocking these is a
 * legitimate choice and increasingly a common one. The finding exists because
 * the choice is usually *inherited* — WordPress security and SEO plugins add
 * these blocks by default — so an operator often does not know it is there.
 * Making an unexamined default visible is the whole value; confirming it and
 * moving on is a perfectly good outcome, and the summary says so.
 *
 * *Untriggered across the 22-site corpus.* Measured 2026-08-09: no site mentions
 * any AI crawler at all. Recorded in `00` alongside the other checks that have
 * never seen a true positive.
 */
const aiCrawlerBlocked: Check = {
  id: 'robots.ai-crawler-blocked',
  group: 'robots',
  run({ robots, aiCrawlers }) {
    if (robots === null || robots.text === null) return [];

    const blocked = aiCrawlers.crawlers.filter((crawler) => {
      // Only a group naming the crawler counts. A site with `User-agent: *` and
      // `Disallow: /` is not "blocking AI crawlers" — it is blocking everything,
      // which is a different and much larger finding that belongs elsewhere.
      const specific = specificGroupsFor(robots, crawler.token);
      return specific.length > 0 && blocksEverything(specific);
    });

    if (blocked.length === 0) return [];

    const retrieval = blocked.filter((crawler) => crawler.purpose !== 'training');
    const findings: Finding[] = [];

    findings.push({
      finding_id: findingId(
        'robots.ai-crawler-blocked',
        blocked
          .map((c) => c.token)
          .sort()
          .join(','),
      ),
      check: 'robots.ai-crawler-blocked',
      severity: 'warning',
      origin: 'check',
      title: `robots.txt blocks ${blocked.length} AI crawler(s)`,
      subject: { kind: 'site', id: 'robots.txt' },
      summary:
        `${blocked.length} AI crawler(s) are disallowed in robots.txt: ` +
        `${blocked.map((crawler) => `${crawler.token} (${crawler.operator})`).join(', ')}. ` +
        `**This may be exactly what you intended, and if so there is nothing to do.** It is ` +
        `reported because the block is more often inherited than chosen — WordPress security ` +
        `and SEO plugins add these by default — and an unexamined default is worth seeing once.` +
        (retrieval.length === 0
          ? ` Every one of these is a training crawler, so this does not affect whether an ` +
            `assistant can answer questions about the site today.`
          : ` ${retrieval.length} of them (${retrieval.map((c) => c.token).join(', ')}) fetch pages ` +
            `to answer a user's question *at the time they ask it* — often because that user asked ` +
            `about this site. Blocking those makes the site invisible at the moment somebody is ` +
            `actively looking for it, which is usually not what was intended.`),
      expected: null,
      observed: blocked.map((crawler) => ({
        value: crawler.token,
        detail: `${crawler.operator}, ${crawler.purpose}${crawler.note === undefined ? '' : ` (${crawler.note})`}`,
        observation_count: 1,
        page_count: 0,
        provenance: [],
      })),
      pages_affected: 0,
      coverage_qualified: false,
      remediation:
        'Decide whether each block is deliberate. If it is, nothing needs changing and this ' +
        'finding can be silenced with --disable robots.ai-crawler-blocked. Sources for every ' +
        `token are in data/ai-crawlers.json.`,
      tradeoff:
        'This tool has no opinion on whether AI crawlers should be allowed. It reports the ' +
        'setting because it is frequently a plugin default rather than a decision, and the ' +
        'operator is the only one who can say which it is here.',
    });

    return findings;
  },
};

// --- robots.resource-blocked -------------------------------------------------

/** Paths whose blocking stops a renderer seeing the page it is judging. */
const RESOURCE_HINTS = [
  { pattern: /\.css(\$|$)|\/css\//i, what: 'CSS' },
  { pattern: /\.js(\$|$)|\/js\//i, what: 'JavaScript' },
  { pattern: /wp-content\/themes/i, what: 'theme assets' },
  { pattern: /wp-includes/i, what: 'core assets' },
];

/**
 * CSS or JS disallowed for everyone.
 *
 * Google renders pages before judging them. A theme directory blocked in
 * robots.txt means the renderer sees an unstyled skeleton, and layout-dependent
 * conclusions — what is above the fold, what is visible — are drawn from
 * something no human ever sees.
 *
 * Restricted to wildcard groups on purpose: a rule aimed at one badly-behaved
 * scraper is not this problem.
 */
const resourceBlocked: Check = {
  id: 'robots.resource-blocked',
  group: 'robots',
  run({ robots }) {
    if (robots === null || robots.text === null) return [];

    const wildcard = robots.groups.filter((group) => group.agents.includes('*'));
    const hits: { rule: string; what: string }[] = [];

    for (const group of wildcard) {
      for (const rule of group.disallow) {
        // An explicit Allow for the same path is the documented fix, and sites
        // that have already applied it must not be told to apply it again.
        if (group.allow.some((allowed) => rule.startsWith(allowed))) continue;
        for (const hint of RESOURCE_HINTS) {
          if (hint.pattern.test(rule)) hits.push({ rule, what: hint.what });
        }
      }
    }

    if (hits.length === 0) return [];

    return [
      {
        finding_id: findingId(
          'robots.resource-blocked',
          hits
            .map((hit) => hit.rule)
            .sort()
            .join(','),
        ),
        check: 'robots.resource-blocked',
        severity: 'warning',
        origin: 'check',
        title: 'robots.txt blocks assets a renderer needs',
        subject: { kind: 'site', id: 'robots.txt' },
        summary:
          `${hits.length} rule(s) in robots.txt disallow ${[...new Set(hits.map((hit) => hit.what))].join(', ')} ` +
          `for all user agents. Google renders a page before judging it, so blocking these means ` +
          `it sees an unstyled skeleton — and any conclusion that depends on layout is drawn from ` +
          `something no visitor ever sees.`,
        expected: 'CSS, JavaScript and theme assets reachable by crawlers.',
        observed: hits.map((hit) => ({
          value: `Disallow: ${hit.rule}`,
          detail: hit.what,
          observation_count: 1,
          page_count: 0,
          provenance: [],
        })),
        pages_affected: 0,
        coverage_qualified: false,
        remediation:
          'Add an Allow rule for the asset paths, or narrow the Disallow. Blocking wp-admin is ' +
          'fine and normal; blocking wp-content/themes or wp-includes is not.',
        tradeoff: null,
      },
    ];
  },
};

// --- robots.sitemap-missing --------------------------------------------------

/**
 * Sitemaps were found, but `robots.txt` does not name them.
 *
 * Only reported when the crawl found a sitemap **by probing**, because that is
 * the case where the evidence is unambiguous: the sitemap exists, and the file
 * that is supposed to advertise it does not. A site with no sitemap at all is a
 * different finding and is not this one.
 */
const sitemapMissing: Check = {
  id: 'robots.sitemap-missing',
  group: 'robots',
  run({ robots, sitemapsFound }) {
    if (robots === null || robots.text === null) return [];
    if (sitemapsFound.length === 0) return [];
    if (robots.sitemaps.length > 0) return [];

    return [
      {
        finding_id: findingId('robots.sitemap-missing', 'site'),
        check: 'robots.sitemap-missing',
        severity: 'opportunity',
        origin: 'check',
        title: 'robots.txt does not name the sitemap',
        subject: { kind: 'site', id: 'robots.txt' },
        summary:
          `This site has ${sitemapsFound.length} sitemap(s), found by probing well-known paths, and ` +
          `robots.txt carries no Sitemap: directive. Nothing is broken — the major search engines ` +
          `probe the same paths — but a crawler that does not guess has no way to find them, and ` +
          `the directive is one line.`,
        expected: 'A Sitemap: line in robots.txt for each sitemap or sitemap index.',
        ...sampleObserved(
          sitemapsFound.map((url) => ({
            value: url,
            observation_count: 1,
            page_count: 0,
            provenance: [],
          })),
        ),
        pages_affected: 0,
        coverage_qualified: false,
        remediation: `Add "Sitemap: ${sitemapsFound[0] ?? '<url>'}" to robots.txt.`,
        tradeoff: null,
      },
    ];
  },
};

export const ROBOTS_CHECKS: Check[] = [aiCrawlerBlocked, resourceBlocked, sitemapMissing];
