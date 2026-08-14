/**
 * The HTML renderer.
 *
 * A **pure function from `report.json` to a string**, like the markdown one, and
 * for the same reasons: testable against fixture reports with no crawl involved,
 * and it keeps the JSON honestly sufficient.
 *
 * ## Self-contained, deliberately
 *
 * One file. Inline CSS, no external stylesheet, no webfont, no image, no
 * JavaScript, no network request of any kind. `05` asks for this so the report
 * survives being emailed, attached to a ticket, or opened from an archive in
 * five years — all cases where a fetch either fails or leaks that the file was
 * opened.
 *
 * **No JavaScript is the load-bearing part.** A file that arrives by email and
 * runs script is indistinguishable from something a mail client should be
 * blocking, and half of them will. Everything here works with scripting off.
 *
 * It renders the same document as the markdown: coverage caveat first, summary,
 * silenced counts, findings by severity. Same wording, because two renderers
 * that describe a finding differently give an operator two things to reconcile.
 */

import type { Finding, Severity } from '../checks/run.ts';
import type { Report } from './build.ts';

const SEVERITY_LABEL: Record<Severity, string> = {
  error: 'Error',
  warning: 'Warning',
  opportunity: 'Opportunity',
};

const SEVERITY_HEADING: Record<Severity, string> = {
  error: 'Errors',
  warning: 'Warnings',
  opportunity: 'Opportunities',
};

/**
 * Escape for HTML text and attribute content.
 *
 * Everything in a report is attacker-adjacent: titles, values and provenance
 * URLs are all copied out of somebody else's markup, and a site publishing
 * `<script>` inside a `name` should not get it executed in a report the
 * operator opens. Applied to every interpolation without exception — there is
 * no "this field is safe" field.
 */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Same unwrapping as the markdown renderer: contradiction values are encoded sets. */
function decodeValue(value: string): string {
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

/**
 * Styles, inline.
 *
 * System font stack rather than a webfont — a font that has to be fetched is a
 * network request, and this file must not make one. Dark mode via
 * `prefers-color-scheme` because it costs a media query and an archived report
 * gets opened at odd hours.
 *
 * Print rules matter more than they look: these get printed to PDF and attached
 * to tickets, and a severity conveyed only by background colour disappears on a
 * mono printer. Hence the left border and the text label on every finding.
 */
const STYLES = `
:root {
  --bg: #ffffff; --fg: #1a1a1a; --muted: #5c5c5c; --rule: #e2e2e2;
  --panel: #f7f7f8; --code: #f0f0f2;
  --error: #b3261e; --warning: #a05a00; --opportunity: #1a5fb4;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #16181c; --fg: #e6e6e6; --muted: #a0a0a0; --rule: #2e3138;
    --panel: #1e2127; --code: #23262d;
    --error: #f28b82; --warning: #fbbc76; --opportunity: #8ab4f8;
  }
}
* { box-sizing: border-box; }
body {
  margin: 0; padding: 2rem 1.25rem 4rem; background: var(--bg); color: var(--fg);
  font: 16px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
}
main { max-width: 52rem; margin: 0 auto; }
h1 { font-size: 1.5rem; margin: 0 0 .25rem; }
h2 { font-size: 1.15rem; margin: 2.5rem 0 1rem; padding-bottom: .4rem; border-bottom: 1px solid var(--rule); }
h3 { font-size: 1rem; margin: 0 0 .75rem; }
p { margin: 0 0 .75rem; }
a { color: inherit; }
code, .mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: .85em; background: var(--code); padding: .1em .35em; border-radius: 3px;
  overflow-wrap: anywhere;
}
.sub { color: var(--muted); font-size: .875rem; margin-bottom: 2rem; }
table { border-collapse: collapse; width: 100%; margin: 0 0 1rem; }
td { padding: .4rem .6rem; border-bottom: 1px solid var(--rule); vertical-align: top; }
td:first-child { color: var(--muted); width: 40%; }
.caveat {
  border-left: 4px solid var(--warning); background: var(--panel);
  padding: .9rem 1.1rem; margin: 0 0 2rem; border-radius: 0 4px 4px 0;
}
.caveat strong { color: var(--warning); }
.finding {
  border: 1px solid var(--rule); border-left: 4px solid var(--rule);
  border-radius: 0 4px 4px 0; padding: 1.1rem 1.25rem; margin: 0 0 1.25rem;
}
.finding.error { border-left-color: var(--error); }
.finding.warning { border-left-color: var(--warning); }
.finding.opportunity { border-left-color: var(--opportunity); }
.meta { color: var(--muted); font-size: .8125rem; margin: 0 0 .9rem; }
.meta .sev { font-weight: 600; }
.finding.error .meta .sev { color: var(--error); }
.finding.warning .meta .sev { color: var(--warning); }
.finding.opportunity .meta .sev { color: var(--opportunity); }
.label { font-weight: 600; font-size: .8125rem; text-transform: uppercase; letter-spacing: .03em;
         color: var(--muted); margin: 1rem 0 .4rem; }
.observed { list-style: none; margin: 0; padding: 0; }
.observed > li { margin: 0 0 .7rem; padding: .5rem .7rem; background: var(--panel); border-radius: 4px; }
.observed .count { color: var(--muted); font-size: .8125rem; }
.prov { list-style: none; margin: .4rem 0 0; padding: 0 0 0 .9rem;
        border-left: 2px solid var(--rule); font-size: .8125rem; color: var(--muted); }
.prov li { margin: .25rem 0; overflow-wrap: anywhere; }
.note { border-left: 3px solid var(--rule); padding: .5rem .9rem; margin: .9rem 0 0;
        background: var(--panel); font-size: .9rem; }
.silenced { list-style: none; margin: 0; padding: 0; font-size: .9rem; color: var(--muted); }
.silenced li { margin: .3rem 0; }
footer { margin-top: 3rem; padding-top: 1rem; border-top: 1px solid var(--rule);
         color: var(--muted); font-size: .8125rem; }
footer .ran { overflow-wrap: anywhere; }
@media print {
  :root { --bg: #fff; --fg: #000; --panel: #f6f6f6; --code: #f0f0f0; --rule: #ccc; }
  body { padding: 0; font-size: 11pt; }
  .finding { break-inside: avoid; page-break-inside: avoid; }
  h2 { break-after: avoid; }
}
`.trim();

function renderFinding(finding: Finding, index: number): string {
  const parts: string[] = [];

  parts.push(`<article class="finding ${finding.severity}">`);
  parts.push(`<h3>${index}. ${escapeHtml(finding.title)}</h3>`);

  const meta = [
    `<code>${escapeHtml(finding.check)}</code>`,
    `<span class="sev">${SEVERITY_LABEL[finding.severity]}</span>`,
    `${finding.pages_affected} page${finding.pages_affected === 1 ? '' : 's'} affected`,
    `<code>${escapeHtml(finding.finding_id)}</code>`,
  ];
  parts.push(`<p class="meta">${meta.join(' &middot; ')}</p>`);

  parts.push(`<p><strong>Subject:</strong> <code>${escapeHtml(finding.subject.id)}</code></p>`);
  if (finding.subject.property !== undefined) {
    parts.push(
      `<p><strong>Property:</strong> <code>${escapeHtml(finding.subject.property)}</code></p>`,
    );
  }

  parts.push(`<p>${escapeHtml(finding.summary)}</p>`);

  if (finding.expected !== null) {
    parts.push(`<p><strong>Expected:</strong> ${escapeHtml(finding.expected)}</p>`);
  }

  if (finding.observed.length > 0) {
    parts.push('<p class="label">Observed</p>');
    parts.push('<ul class="observed">');
    for (const observed of finding.observed) {
      parts.push('<li>');
      parts.push(`<span class="mono">${escapeHtml(decodeValue(observed.value))}</span>`);
      parts.push(
        ` <span class="count">— on ${observed.page_count} page${observed.page_count === 1 ? '' : 's'}</span>`,
      );
      if (observed.provenance.length > 0) {
        parts.push('<ul class="prov">');
        for (const provenance of observed.provenance) {
          parts.push(
            `<li>${escapeHtml(provenance.url)}<br>` +
              `<code>${escapeHtml(provenance.syntax)}</code> block ${provenance.block}, ` +
              `pointer <code>${escapeHtml(provenance.pointer)}</code></li>`,
          );
        }
        parts.push('</ul>');
      }
      parts.push('</li>');
    }
    // Same reason as the markdown renderer: a sample that does not declare
    // itself is read as the whole set.
    const omitted = finding.omitted_count ?? 0;
    if (omitted > 0) {
      parts.push(`<li class="count">…and ${omitted} more, not listed here or in report.json.</li>`);
    }
    parts.push('</ul>');
  }

  if (finding.coverage_qualified) {
    parts.push(
      '<p class="note"><strong>Qualified by coverage.</strong> This finding depends on pages that were not all fetched.</p>',
    );
  }

  if (finding.tradeoff !== null) {
    parts.push(`<p class="note"><strong>Trade-off:</strong> ${escapeHtml(finding.tradeoff)}</p>`);
  }

  if (finding.remediation !== null) {
    parts.push(
      `<p class="note"><strong>Suggested fix:</strong> ${escapeHtml(finding.remediation)}</p>`,
    );
  }

  parts.push('</article>');
  return parts.join('\n');
}

export function renderHtml(report: Report): string {
  const parts: string[] = [];
  const title = `schemanator — ${report.run.site_origin}`;

  parts.push('<!doctype html>');
  parts.push('<html lang="en">');
  parts.push('<head>');
  parts.push('<meta charset="utf-8">');
  parts.push('<meta name="viewport" content="width=device-width, initial-scale=1">');
  // Nothing here should be indexed if it is ever served rather than emailed.
  parts.push('<meta name="robots" content="noindex, nofollow">');
  parts.push(`<title>${escapeHtml(title)}</title>`);
  parts.push(`<style>${STYLES}</style>`);
  parts.push('</head>');
  parts.push('<body>');
  parts.push('<main>');

  parts.push(`<h1>${escapeHtml(title)}</h1>`);
  parts.push(
    `<p class="sub">Run <code>${escapeHtml(report.run.run_id)}</code> &middot; ` +
      `schemanator ${escapeHtml(report.schemanator.version)}</p>`,
  );

  // The coverage caveat goes FIRST, before any finding — the single most
  // misleading thing about a partial report (`05`).
  if (report.coverage.caveat !== null) {
    parts.push(
      `<div class="caveat"><strong>&#9888; Partial coverage.</strong> ${escapeHtml(report.coverage.caveat)}</div>`,
    );
  }

  parts.push('<h2>Summary</h2>');
  parts.push('<table>');
  parts.push(
    `<tr><td>Pages fetched</td><td>${report.coverage.pages_fetched} of ${report.coverage.urls_discovered} discovered</td></tr>`,
  );
  parts.push(`<tr><td>Nodes extracted</td><td>${report.graph.nodes}</td></tr>`);
  parts.push(`<tr><td>Distinct entities</td><td>${report.graph.entities}</td></tr>`);
  parts.push(
    `<tr><td>JSON-LD blocks</td><td>${report.graph.json_ld_blocks}` +
      `${report.graph.malformed_blocks > 0 ? ` (${report.graph.malformed_blocks} malformed)` : ''}</td></tr>`,
  );
  parts.push(
    `<tr><td>Findings</td><td>${report.findings.length} — ` +
      `${report.summary.by_severity['error'] ?? 0} error, ` +
      `${report.summary.by_severity['warning'] ?? 0} warning, ` +
      `${report.summary.by_severity['opportunity'] ?? 0} opportunity</td></tr>`,
  );
  parts.push('</table>');

  const silenced = Object.entries(report.summary.silenced);
  if (silenced.length > 0) {
    // How the report says "we looked at these and decided they were normal",
    // rather than leaving the reader wondering what was missed.
    parts.push('<p class="label">Considered and not reported</p>');
    parts.push('<ul class="silenced">');
    for (const [name, count] of silenced.sort(([, left], [, right]) => right - left)) {
      parts.push(
        `<li><code>${escapeHtml(name)}</code> — ${count} instance${count === 1 ? '' : 's'}. ` +
          `Normal behaviour, deliberately silent.</li>`,
      );
    }
    parts.push('</ul>');
  }

  if (report.findings.length === 0) {
    parts.push('<h2>Findings</h2>');
    parts.push('<p>None. Every check ran and found nothing to report.</p>');
  } else {
    for (const severity of ['error', 'warning', 'opportunity'] as Severity[]) {
      const group = report.findings.filter((finding) => finding.severity === severity);
      if (group.length === 0) continue;

      parts.push(`<h2>${SEVERITY_HEADING[severity]} (${group.length})</h2>`);
      group.forEach((finding, index) => parts.push(renderFinding(finding, index + 1)));
    }
  }

  parts.push('<footer>');
  parts.push(
    `<p class="ran">Checks run: ${report.summary.checks_run.map((check) => `<code>${escapeHtml(check)}</code>`).join(', ')}</p>`,
  );
  if (report.summary.checks_disabled.length > 0) {
    parts.push(
      `<p class="ran">Disabled: ${report.summary.checks_disabled.map((check) => `<code>${escapeHtml(check)}</code>`).join(', ')}</p>`,
    );
  }
  parts.push('</footer>');

  parts.push('</main>');
  parts.push('</body>');
  parts.push('</html>');

  return parts.join('\n');
}
