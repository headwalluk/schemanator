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
 *
 * **`observed[].detail` is excluded, and that is the point of it existing.**
 * The signature reads `value` and `page_count`, both facts about the site; until
 * 1.12.0 nine checks glued their annotation onto `value`, so the signature was
 * reading presentation without meaning to. A `content.javascript-only` row said
 * `https://…/ — 23 KB, 400 words`, and a page gaining a paragraph reported the
 * finding as *changed* on a run where nothing about the problem had moved. The
 * category error was the same one the annotation itself was: a field that
 * identifies something being asked to carry how big it is.
 */
function evidenceSignature(finding: Finding): string {
  return JSON.stringify({
    pages: finding.pages_affected,
    instances: finding.instance_count ?? null,
    observed: finding.observed.map((entry) => `${entry.value}|${entry.page_count}`).sort(),
  });
}

/** Materially different coverage makes a diff untrustworthy rather than merely noisy. */
function coverageWarning(before: Report, after: Report): string | null {
  const from = before.coverage.pages_extracted;
  const to = after.coverage.pages_extracted;
  if (from === 0 || to === 0)
    return 'One of the two runs extracted no pages, so this diff means nothing.';

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

/**
 * Minimum movement, in pages of the later sample, before a change is called one.
 *
 * A finding on 17 of 78 pages that reads 16 of 76 has moved by half a page once
 * the shrinking sample is accounted for. That is arithmetic, not progress, and
 * labelling it either way overstates what the two runs can support.
 */
const DIRECTION_MIN_PAGES = 1;

/**
 * Did a change move in the right direction? Used only for wording.
 *
 * **Compared as a share of the sample, not as a raw page count**, and the
 * second draft of this function is why the distinction is spelled out.
 *
 * Raw counts call a finding "improved" whenever the sample shrank, because a
 * sitewide finding tracks the sample by definition. Measured on a real site,
 * 2026-08-22: the crawl went 78 pages to 76, nothing about the site changed,
 * and **eight of eleven changed findings were labelled improved** — three of
 * them `entity.contradiction`, the flagship. A reader would have concluded
 * eight things got better.
 *
 * The first fix compared the finding's drop against the sample's drop, which
 * traded one wrong label for another: it assumed every finding is sitewide, so
 * `addressRegion` on 17 of 78 pages reading 16 of 76 came out **WORSENED** —
 * six findings did. Proportionally it had not moved at all.
 *
 * `coverage_warning` already guards the loud version of this — audit 150 pages,
 * fix nothing, audit 60 — but it fires at a 10% swing, and 78 to 76 is 2.6%.
 * The trap does not need a big swing to mislead; it needs one page.
 */
export function directionOf(
  change: ChangedFinding,
  sample: { before: number; after: number },
): 'improved' | 'worsened' | 'shifted' {
  // A sample of zero audits nothing, so no direction is claimable.
  if (sample.before <= 0 || sample.after <= 0) return 'shifted';

  const shareBefore = change.before.pages_affected / sample.before;
  const shareAfter = change.after.pages_affected / sample.after;

  // Back into pages of the later sample, so the threshold is a number a reader
  // could count rather than a share nobody has intuition for.
  const moved = (shareAfter - shareBefore) * sample.after;

  if (moved <= -DIRECTION_MIN_PAGES) return 'improved';
  if (moved >= DIRECTION_MIN_PAGES) return 'worsened';
  return 'shifted';
}
