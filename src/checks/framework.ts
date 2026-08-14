/**
 * The shared vocabulary every check is written against.
 *
 * Extracted from `run.ts` once the catalogue outgrew a single file: breadcrumb,
 * syntax and the structural checks all need `Finding`, `findingId` and
 * `provenanceOf`, and importing them from `run.ts` — which in turn imports every
 * check module in order to assemble `ALL_CHECKS` — would be circular.
 *
 * Nothing here runs a check. It is types, plus the two helpers that must behave
 * identically across every check or the report stops being comparable: finding
 * ids (`05` needs them stable so a cross-run diff is a set operation) and
 * provenance capping (`01` makes provenance mandatory, `05` makes it bounded).
 */

import { createHash } from 'node:crypto';

import type { DuplicateEntry as SitemapDuplicate } from '../crawl/sitemaps.ts';
import type { ExtractedNode } from '../extract/types.ts';
import type { PageRecord } from '../store/workdir.ts';
import type { CardinalityRules } from './cardinality.ts';
import type { EntityGraph } from './graph.ts';
import type { GoogleRules } from './google.ts';
import type { AiCrawlers, RobotsFile } from './robots.ts';
import type { Hierarchy } from './hierarchy.ts';
import type { ValueHeuristics } from './values.ts';

export type { SitemapDuplicate };

export type Severity = 'error' | 'warning' | 'opportunity';

export interface Provenance {
  page_id: string;
  url: string;
  syntax: string;
  block: number;
  pointer: string;
}

export interface Observed {
  /**
   * What this row is about, and nothing else: a URL, an `@id`, a crawler token,
   * a robots rule, a title. **An identifier** — greppable, clickable,
   * comparable between runs.
   *
   * Until 1.12.0 nine checks appended an annotation to it — `— 2 nodes`,
   * `— 23 KB, 400 words`, `— OpenAI, training` — which cost all three of those
   * properties at once, and in one case duplicated a number the row already
   * carried in `page_count`. The annotation belongs in `detail`.
   */
  value: string;
  /**
   * The annotation: how big, how many, which kind. Optional, and never load-
   * bearing — a reader who ignores it still knows what the row names.
   *
   * `report/diff.ts` deliberately does not fingerprint it, which is half the
   * point of splitting it out. A `content.javascript-only` row read
   * `https://…/ — 23 KB, 400 words`, so a page gaining a paragraph reported the
   * finding as *changed* on every run. The problem had not changed; the page
   * had. Volatile annotation goes here, where the diff cannot see it.
   */
  detail?: string | null;
  observation_count: number;
  page_count: number;
  provenance: Provenance[];
}

/**
 * How many `observed` rows a finding lists before it stops.
 *
 * **One number, everywhere, on purpose.** Until 1.12.0 the catalogue capped
 * `observed` at 3, 5, 8, 10 and 15 across some two dozen call sites, every one a
 * bare literal. Asked why any of them was what it was, no answer survived: the
 * files written first say 5, the files written later say 10, and `indexing`'s 15
 * is the one place somebody wanted a working list rather than a sample. That is
 * drift, not judgement, and a decision nobody can review is exactly what the
 * *named constants carry their evidence* standard exists to stop.
 *
 * 10 because `AGGREGATE_SAMPLE` already lists 10 constituents for the same
 * reason at a different level, and two numbers doing one job is how the drift
 * started.
 *
 * **What makes the exact figure defensible is `omitted_count`, not the figure.**
 * A capped list that says nothing reads as a complete one — a reader who
 * disbelieved a correct summary because the evidence under it had been silently
 * truncated is what opened this whole milestone (`dev-notes/10`, finding 4). A
 * cap that declares itself is a sample; a cap that hides is a lie about the size
 * of the problem.
 */
export const OBSERVED_SAMPLE = 10;

/** `05`: three examples per row — a finding spanning 8,000 pages must stay readable. */
export const PROVENANCE_SAMPLE = 3;

/**
 * The `observed` half of a finding: the rows it lists, and the truth about the
 * ones it does not.
 *
 * Spread into the finding — `...sampleObserved(rows)` — so a check cannot take
 * the sample without recording what it dropped. That is the whole point of the
 * helper: slicing by hand is what produced a catalogue full of lists that looked
 * complete, and `sample-caps.test.ts` now refuses it.
 */
export interface ObservedSample {
  observed: Observed[];
  /** Rows beyond the ones listed. 0 when `observed` is the whole set. */
  omitted_count: number;
  /** Observations across *every* row, listed or not. Internal — see `Finding`. */
  observation_total: number;
}

export function sampleObserved(rows: readonly Observed[]): ObservedSample {
  return {
    observed: rows.slice(0, OBSERVED_SAMPLE),
    omitted_count: Math.max(0, rows.length - OBSERVED_SAMPLE),
    // Summed over all rows rather than the surviving ones: an aggregate asks its
    // constituents how much they saw, and a truncated constituent that answers
    // with its sample undercounts by however much it dropped.
    observation_total: rows.reduce((total, row) => total + row.observation_count, 0),
  };
}

export interface Finding {
  finding_id: string;
  check: string;
  severity: Severity;
  origin: 'check';
  title: string;
  subject: { kind: 'entity' | 'page' | 'site'; id: string; property?: string };
  summary: string;
  expected: string | null;
  observed: Observed[];
  /**
   * `observed` rows this finding has, and did not list.
   *
   * Optional here and never optional in the report: `buildReport` fills the
   * absent case with 0, so a consumer always has the number and a check with a
   * complete list does not have to say so in every constructor.
   */
  omitted_count?: number;
  /**
   * Observations behind this finding, including any in rows it did not list.
   *
   * Internal only — stripped before the report, like `page_ids`, and for the
   * same reason: it exists so aggregation can be honest about a constituent it
   * is summarising, not because a consumer asked for it. `pages_affected`
   * already carries the scale.
   */
  observation_total?: number;
  pages_affected: number;
  coverage_qualified: boolean;
  remediation: string | null;
  tradeoff: string | null;
  /**
   * Aggregation key within a check. Findings sharing one are the *same
   * problem* seen at different subjects, and get collapsed into one.
   *
   * Absent means "never aggregate this".
   */
  pattern?: string;
  /** Set on an aggregate: how many individual findings it stands for. */
  instance_count?: number;
  /**
   * Pages this finding touches. Internal only — stripped before the report, so
   * a finding spanning 8,000 pages does not carry 8,000 strings into the JSON.
   *
   * Exists so aggregation can UNION page sets. Summing `pages_affected` across
   * constituents double-counts: six empty address fields on the same 17 pages
   * reported as "102 pages affected" on a 79-page site, which is visibly wrong
   * and costs the reader's trust in every other number in the report.
   */
  page_ids?: string[];
  /**
   * Title to use when this finding is aggregated with others.
   *
   * `${count} × ${title}` reads correctly when the findings really are the same
   * thing at different subjects ("28 × One entity published under two @ids"),
   * and wrongly when the title names the subject: six different empty
   * properties became "6 × addressCountry is published as an empty string".
   */
  aggregate_title?: string;
}

export interface CheckContext {
  graph: EntityGraph;
  pages: PageRecord[];
  rules: CardinalityRules;
  hierarchy: Hierarchy;
  heuristics: ValueHeuristics;
  /** Google's rich-result requirements. Group `google` only. */
  google: GoogleRules;
  /**
   * The site's `robots.txt`, parsed into its user-agent groups.
   *
   * Null when the crawl predates it being read, or the file was absent. Checks
   * must treat null as "unknown", never as "permissive" — `02` is emphatic that
   * an unreadable robots.txt is not permission.
   */
  robots: RobotsFile | null;
  /** The AI crawler list. Group `robots` only. */
  aiCrawlers: AiCrawlers;
  /** Sitemaps the crawl actually found, however it found them. */
  sitemapsFound: readonly string[];
  /**
   * URLs listed more than once across the site's sitemaps.
   *
   * **Null means the crawl did not record it**, which is every crawl before
   * 1.12.0 — not "there were none". The distinction is the whole reason this is
   * nullable: a check that reads a missing measurement as a clean result
   * produces a confident, empty finding, and `01` is emphatic that this is the
   * worst outcome available to a tool people act on. Re-running `analyse` does
   * not help either; deduplication happens during discovery, so it takes a
   * re-crawl.
   */
  sitemapDuplicates: readonly SitemapDuplicate[] | null;
  /** The host being audited. Needed to tell own-domain media from foreign. */
  siteHost: string;
  /** True when the crawl did not cover the whole site. Gates absence claims (rule 3). */
  partialCoverage: boolean;
  silenced: Record<string, number>;
}

export interface Check {
  id: string;
  group: string;
  run(context: CheckContext): Finding[];
}

/**
 * Long enough that a collision across one report is not a practical concern,
 * short enough to type into a `--since` diff or read aloud off a screen.
 */
const FINDING_ID_LENGTH = 12;

/** `05`: the id names the *question asked*, never the answer, so a diff is a set operation. */
export function findingId(check: string, subjectKey: string): string {
  return createHash('sha256')
    .update(`${check}|${subjectKey}`)
    .digest('hex')
    .slice(0, FINDING_ID_LENGTH);
}

/** Cap per distinct value — a finding spanning 8,000 pages must stay readable (`05`). */
export function provenanceOf(
  nodes: readonly ExtractedNode[],
  pages: Map<string, PageRecord>,
): Provenance[] {
  return nodes.slice(0, PROVENANCE_SAMPLE).map((node) => ({
    page_id: node.page_id,
    url: pages.get(node.page_id)?.canonical_url ?? node.page_id,
    syntax: node.source.syntax,
    block: node.source.block,
    pointer: node.source.pointer,
  }));
}

/** Page records keyed by `page_id`. Every check that reports provenance needs it. */
export function indexPagesById(pages: readonly PageRecord[]): Map<string, PageRecord> {
  return new Map(pages.map((page) => [page.page_id, page]));
}
