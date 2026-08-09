/**
 * Rendering a cross-run diff.
 *
 * Pure function over a `ReportDiff`, like every other renderer. The audience is
 * the same as `05`'s: a human checking whether a fix landed, and an agent that
 * was handed the previous report and asked to fix the code.
 */

import { directionOf, type ReportDiff } from './diff.ts';

const ARROW = '→';

export function renderDiffMarkdown(diff: ReportDiff, siteOrigin: string): string {
  const lines: string[] = [];

  lines.push(`# schemanator diff — ${siteOrigin}`);
  lines.push('');
  lines.push(`\`${diff.before.run_id}\` ${ARROW} \`${diff.after.run_id}\``);
  lines.push('');

  // Before anything else. A diff drawn across different coverage is not a
  // weaker signal, it is a misleading one.
  if (diff.coverage_warning !== null) {
    lines.push('> ## ⚠ Coverage changed between runs');
    lines.push('>');
    lines.push(`> ${diff.coverage_warning}`);
    lines.push('');
  }

  const { resolved, appeared, changed, unchanged } = diff.summary;
  lines.push('## Summary');
  lines.push('');
  lines.push('| | |');
  lines.push('| --- | --- |');
  lines.push(`| Resolved | ${resolved} |`);
  lines.push(`| New | ${appeared} |`);
  lines.push(`| Changed | ${changed} |`);
  lines.push(`| Unchanged | ${unchanged} |`);
  lines.push(`| Pages audited | ${diff.before.pages} ${ARROW} ${diff.after.pages} |`);
  lines.push('');

  if (resolved === 0 && appeared === 0 && changed === 0) {
    lines.push(
      unchanged === 0
        ? 'Both runs were clean.'
        : `Nothing changed. ${unchanged} finding(s) still open.`,
    );
    lines.push('');
    return lines.join('\n');
  }

  if (diff.resolved.length > 0) {
    lines.push(`## Resolved (${diff.resolved.length})`);
    lines.push('');
    for (const finding of diff.resolved) {
      lines.push(`- **${finding.title}**`);
      lines.push(
        `  \`${finding.check}\` • \`${finding.finding_id}\` • was ${finding.pages_affected} page(s)`,
      );
      lines.push(`  ${finding.subject.id}`);
    }
    lines.push('');
  }

  if (diff.changed.length > 0) {
    lines.push(`## Changed (${diff.changed.length})`);
    lines.push('');
    lines.push(
      'Same finding, different evidence — the question is still open but the answer moved.',
    );
    lines.push('');
    for (const change of diff.changed) {
      const direction = directionOf(change);
      const label =
        direction === 'improved' ? 'improved' : direction === 'worsened' ? 'WORSENED' : 'shifted';
      lines.push(`- **${change.after.title}** — ${label}`);
      lines.push(`  \`${change.after.check}\` • \`${change.after.finding_id}\``);
      lines.push(
        `  pages affected: ${change.before.pages_affected} ${ARROW} ${change.after.pages_affected}`,
      );
      lines.push(`  ${change.after.subject.id}`);
    }
    lines.push('');
  }

  if (diff.appeared.length > 0) {
    lines.push(`## New (${diff.appeared.length})`);
    lines.push('');
    for (const finding of diff.appeared) {
      lines.push(`- **${finding.title}** (${finding.severity})`);
      lines.push(
        `  \`${finding.check}\` • \`${finding.finding_id}\` • ${finding.pages_affected} page(s)`,
      );
      lines.push(`  ${finding.subject.id}`);
    }
    lines.push('');
  }

  if (diff.unchanged.length > 0) {
    lines.push(`## Still open (${diff.unchanged.length})`);
    lines.push('');
    for (const finding of diff.unchanged) {
      lines.push(`- ${finding.title} — \`${finding.check}\` • \`${finding.finding_id}\``);
    }
    lines.push('');
  }

  lines.push('---');
  lines.push('');
  lines.push(
    'Finding ids name the *question asked*, not the answer, so a half-fixed problem stays',
  );
  lines.push(
    'one open finding under **Changed** rather than appearing as one resolved and one new.',
  );
  lines.push('');

  return lines.join('\n');
}
