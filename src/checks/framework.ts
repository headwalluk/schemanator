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

import type { ExtractedNode } from '../extract/types.ts';
import type { PageRecord } from '../store/workdir.ts';
import type { CardinalityRules } from './cardinality.ts';
import type { EntityGraph } from './graph.ts';
import type { Hierarchy } from './hierarchy.ts';
import type { ValueHeuristics } from './values.ts';

export type Severity = 'error' | 'warning' | 'opportunity';

export interface Provenance {
  page_id: string;
  url: string;
  syntax: string;
  block: number;
  pointer: string;
}

export interface Observed {
  value: string;
  observation_count: number;
  page_count: number;
  provenance: Provenance[];
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

/** `05`: the id names the *question asked*, never the answer, so a diff is a set operation. */
export function findingId(check: string, subjectKey: string): string {
  return createHash('sha256').update(`${check}|${subjectKey}`).digest('hex').slice(0, 12);
}

/** Cap at 3 per distinct value — a finding spanning 8,000 pages must stay readable (`05`). */
export function provenanceOf(
  nodes: readonly ExtractedNode[],
  pages: Map<string, PageRecord>,
): Provenance[] {
  return nodes.slice(0, 3).map((node) => ({
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
