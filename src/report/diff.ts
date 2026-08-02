/**
 * Cross-run diffing — step 4 of the fix-verify loop in `dev-notes/00`.
 *
 * The whole thing rests on a property established in `05`: **a finding id names
 * the question asked, never the answer.** So comparing two runs is a set
 * operation, and a half-fixed problem stays the same finding rather than
 * appearing as one resolved and one new.
 */

import type { Finding } from '../checks/run.ts';
import type { Report } from './build.ts';

export interface ChangedFinding {
  before: Finding;
  after: Finding;
}

export interface ReportDiff {
  before: { run_id: string; finished_at: string; pages: number };
  after: { run_id: string; finished_at: string; pages: number };
  resolved: Finding[];
  appeared: Finding[];
  /** Same finding, different evidence — partial progress, or partial regression. */
  changed: ChangedFinding[];
  unchanged: Finding[];
  /**
   * Set when the two runs did not audit comparable ground.
   *
   * The trap this exists for: crawl 150 pages, fix nothing, crawl 60, and
   * findings "resolve" purely because the evidence was not looked at. A
   * fix-verify loop that congratulates you for shrinking the sample is worse
   * than no loop at all.
   */
  coverage_warning: string | null;
  summary: { resolved: number; appeared: number; changed: number; unchanged: number };
}

/**
 * What the finding currently rests on. Deliberately excludes anything that can
 * shift without the underlying problem changing — the run id, timestamps, the
 * prose.
 */
function evidenceSignature(finding: Finding): string {
  return JSON.stringify({
    pages: finding.pages_affected,
    instances: finding.instance_count ?? null,
    observed: finding.observed
      .map((entry) => `${entry.value}|${entry.page_count}`)
      .sort(),
  });
}

/** Materially different coverage makes a diff untrustworthy rather than merely noisy. */
function coverageWarning(before: Report, after: Report): string | null {
  const from = before.coverage.pages_extracted;
  const to = after.coverage.pages_extracted;
  if (from === 0 || to === 0) return 'One of the two runs extracted no pages, so this diff means nothing.';

  const ratio = to / from;
  if (ratio < 0.9) {
    return (
      `The later run audited ${to} pages against ${from} before — ${Math.round((1 - ratio) * 100)}% fewer. ` +
      `Findings may appear resolved simply because the evidence was not looked at. Re-run with matching ` +
      `--max-pages before trusting anything below.`
    );
  }
  if (ratio > 1.1) {
    return (
      `The later run audited ${to} pages against ${from} before — ${Math.round((ratio - 1) * 100)}% more. ` +
      `New findings may be newly *visible* rather than newly introduced.`
    );
  }
  if (before.coverage.sample_strategy !== after.coverage.sample_strategy) {
    return `Sample strategy changed from "${before.coverage.sample_strategy}" to "${after.coverage.sample_strategy}"; the two runs may not have audited the same pages.`;
  }
  return null;
}

export function diffReports(before: Report, after: Report): ReportDiff {
  const beforeById = new Map(before.findings.map((finding) => [finding.finding_id, finding]));
  const afterById = new Map(after.findings.map((finding) => [finding.finding_id, finding]));

  const resolved: Finding[] = [];
  const appeared: Finding[] = [];
  const changed: ChangedFinding[] = [];
  const unchanged: Finding[] = [];

  for (const [id, finding] of beforeById) {
    const current = afterById.get(id);
    if (current === undefined) {
      resolved.push(finding);
    } else if (evidenceSignature(finding) === evidenceSignature(current)) {
      unchanged.push(current);
    } else {
      changed.push({ before: finding, after: current });
    }
  }

  for (const [id, finding] of afterById) {
    if (!beforeById.has(id)) appeared.push(finding);
  }

  return {
    before: {
      run_id: before.run.run_id,
      finished_at: before.run.finished_at,
      pages: before.coverage.pages_extracted,
    },
    after: {
      run_id: after.run.run_id,
      finished_at: after.run.finished_at,
      pages: after.coverage.pages_extracted,
    },
    resolved,
    appeared,
    changed,
    unchanged,
    coverage_warning: coverageWarning(before, after),
    summary: {
      resolved: resolved.length,
      appeared: appeared.length,
      changed: changed.length,
      unchanged: unchanged.length,
    },
  };
}

/** Did a change move in the right direction? Used only for wording. */
export function directionOf(change: ChangedFinding): 'improved' | 'worsened' | 'shifted' {
  if (change.after.pages_affected < change.before.pages_affected) return 'improved';
  if (change.after.pages_affected > change.before.pages_affected) return 'worsened';
  return 'shifted';
}
