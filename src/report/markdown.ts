/**
 * The markdown renderer.
 *
 * A **pure function from `report.json` to text** — no I/O, no re-reading
 * `nodes.jsonl`. That makes it testable against fixture reports with no crawl
 * involved, and keeps the JSON honestly sufficient: if this needs something the
 * JSON lacks, the JSON is wrong.
 *
 * Two audiences, one document — a terminal reader and a coding agent want much
 * the same thing. So: no colour, no box drawing, nothing that breaks when
 * pasted into a chat window.
 */

import type { Finding, Severity } from '../checks/run.ts';
import type { Report } from './build.ts';

const SEVERITY_LABEL: Record<Severity, string> = {
  error: 'Error',
  warning: 'Warning',
  opportunity: 'Opportunity',
};

/** English, not `${label}s` — "Opportunitys" is not a word. */
const SEVERITY_HEADING: Record<Severity, string> = {
  error: 'Errors',
  warning: 'Warnings',
  opportunity: 'Opportunities',
};

function decodeValue(value: string): string {
  // Contradiction values arrive as a JSON-encoded sorted set of JSON strings.
  // Unwrap for display; fall back to the raw string for everything else.
  try {
    const outer = JSON.parse(value) as unknown;
    if (!Array.isArray(outer)) return value;
    return outer
      .map((entry) => {
        try {
          const inner = JSON.parse(String(entry)) as Record<string, unknown>;
          if (typeof inner['@id'] === 'string') return inner['@id'];
          if (typeof inner['@value'] === 'string') return inner['@value'];
          return JSON.stringify(inner);
        } catch {
          return String(entry);
        }
      })
      .join(', ');
  } catch {
    return value;
  }
}

function renderFinding(finding: Finding, index: number): string {
  const lines: string[] = [];

  lines.push(`### ${index}. ${finding.title}`);
  lines.push('');
  lines.push(`- **Check:** \`${finding.check}\`  •  **Severity:** ${SEVERITY_LABEL[finding.severity]}`);
  lines.push(`- **Subject:** \`${finding.subject.id}\``);
  if (finding.subject.property !== undefined) lines.push(`- **Property:** \`${finding.subject.property}\``);
  lines.push(`- **Pages affected:** ${finding.pages_affected}`);
  lines.push(`- **Finding id:** \`${finding.finding_id}\``);
  lines.push('');
  lines.push(finding.summary);

  if (finding.expected !== null) {
    lines.push('');
    lines.push(`**Expected:** ${finding.expected}`);
  }

  if (finding.observed.length > 0) {
    lines.push('');
    lines.push('**Observed:**');
    lines.push('');
    for (const observed of finding.observed) {
      lines.push(`- \`${decodeValue(observed.value)}\` — on ${observed.page_count} page(s)`);
      for (const provenance of observed.provenance) {
        lines.push(`    - ${provenance.url}`);
        lines.push(`      \`${provenance.syntax}\` block ${provenance.block}, pointer \`${provenance.pointer}\``);
      }
    }
  }

  if (finding.coverage_qualified) {
    lines.push('');
    lines.push('> **Qualified by coverage.** This finding depends on pages that were not all fetched.');
  }

  if (finding.tradeoff !== null) {
    lines.push('');
    lines.push(`> **Trade-off:** ${finding.tradeoff}`);
  }

  if (finding.remediation !== null) {
    lines.push('');
    lines.push(`**Suggested fix:** ${finding.remediation}`);
  }

  lines.push('');
  return lines.join('\n');
}

export function renderMarkdown(report: Report): string {
  const lines: string[] = [];

  lines.push(`# schemanator — ${report.run.site_origin}`);
  lines.push('');
  lines.push(`Run \`${report.run.run_id}\` • schemanator ${report.schemanator.version}`);
  lines.push('');

  // The coverage caveat goes FIRST, before any finding. It is the single most
  // misleading thing about a partial report (`05`).
  if (report.coverage.caveat !== null) {
    lines.push('> ## ⚠ Partial coverage');
    lines.push('>');
    lines.push(`> ${report.coverage.caveat}`);
    lines.push('');
  }

  lines.push('## Summary');
  lines.push('');
  lines.push('| | |');
  lines.push('| --- | --- |');
  lines.push(`| Pages fetched | ${report.coverage.pages_fetched} of ${report.coverage.urls_discovered} discovered |`);
  lines.push(`| Nodes extracted | ${report.graph.nodes} |`);
  lines.push(`| Distinct entities | ${report.graph.entities} |`);
  lines.push(`| JSON-LD blocks | ${report.graph.json_ld_blocks}${report.graph.malformed_blocks > 0 ? ` (${report.graph.malformed_blocks} malformed)` : ''} |`);
  lines.push(
    `| Findings | ${report.findings.length}` +
      ` — ${report.summary.by_severity['error'] ?? 0} error, ` +
      `${report.summary.by_severity['warning'] ?? 0} warning, ` +
      `${report.summary.by_severity['opportunity'] ?? 0} opportunity |`,
  );
  lines.push('');

  const silenced = Object.entries(report.summary.silenced);
  if (silenced.length > 0) {
    // Load-bearing: this is how the report says "we looked at these and decided
    // they were normal", rather than leaving the reader wondering what we missed.
    lines.push('**Considered and not reported:**');
    lines.push('');
    for (const [name, count] of silenced.sort(([, left], [, right]) => right - left)) {
      lines.push(`- \`${name}\` — ${count} instance(s). Normal behaviour, deliberately silent.`);
    }
    lines.push('');
  }

  if (report.findings.length === 0) {
    lines.push('## Findings');
    lines.push('');
    lines.push('None. Every check ran and found nothing to report.');
    lines.push('');
  } else {
    for (const severity of ['error', 'warning', 'opportunity'] as Severity[]) {
      const group = report.findings.filter((finding) => finding.severity === severity);
      if (group.length === 0) continue;

      lines.push(`## ${SEVERITY_HEADING[severity]} (${group.length})`);
      lines.push('');
      group.forEach((finding, index) => lines.push(renderFinding(finding, index + 1)));
    }
  }

  lines.push('---');
  lines.push('');
  lines.push(`Checks run: ${report.summary.checks_run.map((check) => `\`${check}\``).join(', ')}`);
  if (report.summary.checks_disabled.length > 0) {
    lines.push('');
    lines.push(`Disabled: ${report.summary.checks_disabled.map((check) => `\`${check}\``).join(', ')}`);
  }
  lines.push('');

  return lines.join('\n');
}
