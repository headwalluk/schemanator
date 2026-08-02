/**
 * Group `syntax` — per-page structural faults.
 *
 * Cheap, and *recorded by extraction rather than computed here*. A block that
 * fails to parse produces no nodes, so by the time a check sees `nodes.jsonl`
 * the evidence is already gone. `03` therefore has extraction write the fault
 * onto the page record as `ld-block-<n>: <message>`, and these two checks do
 * nothing but surface what is already there.
 *
 * ## These checks fire on nothing in the corpus, and that is the point
 *
 * Measured across all 22 sites: 1,829 pages with no errors, 8 with `http-404`,
 * 1 with a redirect loop, and **zero** malformed or unresolvable blocks. `04`
 * recorded the same result for M0's 1,075 blocks.
 *
 * So neither check can be validated by the shakedown — they are unit-tested
 * against synthetic page records and otherwise untriggered. That is a known and
 * accepted risk, recorded in the tracker alongside `entity.type-conflict` and
 * `entity.multi-value`, and it is worth being plain about: a check that has
 * never seen a true positive is untriggered, not validated.
 *
 * They are still worth shipping. The cost of a malformed block is total — every
 * entity in it vanishes silently, and the page looks merely empty rather than
 * broken — so the one site that does hit this needs to be told loudly.
 */

import type { PageRecord } from '../store/workdir.ts';
import { findingId, type Check, type Finding } from './framework.ts';

/** Extraction's prefix for a per-block fault. See `src/extract/run.ts`. */
const BLOCK_ERROR = /^ld-block-(\d+): (.*)$/s;

/** {@link UnresolvableContextError}'s message, which is what lands on the record. */
const REMOTE_CONTEXT = 'refusing to fetch remote context ';

/** `jsonld.expand` rejected a block that *was* valid JSON. */
const EXPANSION_FAILED = 'expansion failed: ';

interface BlockFault {
  page: PageRecord;
  block: number;
  message: string;
}

function blockFaults(pages: readonly PageRecord[]): BlockFault[] {
  const faults: BlockFault[] = [];

  for (const page of pages) {
    for (const error of page.errors) {
      const match = BLOCK_ERROR.exec(error);
      if (match === null) continue;
      const block = Number.parseInt(match[1] ?? '', 10);
      const message = match[2] ?? '';
      if (Number.isNaN(block)) continue;
      faults.push({ page, block, message });
    }
  }

  return faults;
}

/**
 * The `@context` could not be resolved, so nothing in the block could be
 * expanded and every entity it declared was lost.
 *
 * On this tool the cause is almost always deliberate: `03` refuses to fetch
 * remote contexts, because a crawl that depends on a third-party server being
 * reachable is not reproducible. A site using a context we do not bundle is
 * therefore reported rather than silently fetched.
 */
const unresolvableContext: Check = {
  id: 'syntax.unresolvable-context',
  group: 'syntax',
  run({ pages }) {
    const affected = blockFaults(pages).filter((fault) => fault.message.startsWith(REMOTE_CONTEXT));
    if (affected.length === 0) return [];

    const contexts = new Map<string, BlockFault[]>();
    for (const fault of affected) {
      // "refusing to fetch remote context <url>. Only the bundled …" — split on
      // whitespace, not on `.`, or the URL loses everything after its domain.
      const url =
        (fault.message.slice(REMOTE_CONTEXT.length).split(/\s/)[0] ?? '').replace(/\.+$/, '') ||
        '(unknown)';
      contexts.set(url, [...(contexts.get(url) ?? []), fault]);
    }

    return [...contexts.entries()].map(([contextUrl, faults]) => {
      const pageIds = new Set(faults.map((fault) => fault.page.page_id));
      return {
        finding_id: findingId('syntax.unresolvable-context', contextUrl),
        check: 'syntax.unresolvable-context',
        severity: 'error' as const,
        origin: 'check' as const,
        title: 'A JSON-LD @context could not be resolved',
        subject: { kind: 'site' as const, id: contextUrl },
        summary:
          `${faults.length} JSON-LD block(s) across ${pageIds.size} page(s) declare @context ` +
          `${contextUrl}, which is not the bundled schema.org context. Nothing in those blocks could ` +
          `be expanded, so every entity they declared is missing from this report — the pages look ` +
          `empty rather than broken. schemanator deliberately does not fetch remote contexts: a ` +
          `crawl that depends on a third-party server being reachable is not reproducible.`,
        expected: 'A @context of https://schema.org, which is bundled and always resolvable.',
        observed: [
          {
            value: contextUrl,
            observation_count: faults.length,
            page_count: pageIds.size,
            provenance: faults.slice(0, 3).map((fault) => ({
              page_id: fault.page.page_id,
              url: fault.page.canonical_url,
              syntax: 'json-ld',
              block: fault.block,
              pointer: '',
            })),
          },
        ],
        pages_affected: pageIds.size,
        coverage_qualified: false,
        remediation:
          'Use https://schema.org as the @context. If the vocabulary genuinely is not schema.org, ' +
          'this tool is the wrong one for auditing it.',
        tradeoff: null,
        pattern: 'unresolvable @context',
        aggregate_title: 'JSON-LD contexts could not be resolved',
        page_ids: [...pageIds],
      };
    });
  },
};

/**
 * A block that could not be parsed at all.
 *
 * Covers two failures that a reader experiences identically — the entities are
 * gone — but which need different wording, because telling someone their valid
 * JSON is malformed sends them looking for a syntax error that is not there:
 *
 *   - **Not valid JSON.** `JSON.parse` rejected it. Extraction names the likely
 *     cause where it can, and a trailing comma before a closing brace is the
 *     common one.
 *   - **Valid JSON that could not be expanded.** The document parsed but
 *     `jsonld.expand` rejected it — a malformed `@context` object, or a keyword
 *     used where the algorithm does not permit one.
 */
const malformedJson: Check = {
  id: 'syntax.malformed-json',
  group: 'syntax',
  run({ pages }) {
    const affected = blockFaults(pages).filter(
      (fault) => !fault.message.startsWith(REMOTE_CONTEXT),
    );
    if (affected.length === 0) return [];

    const findings: Finding[] = [];
    const byKind = new Map<'parse' | 'expand', BlockFault[]>();
    for (const fault of affected) {
      const kind = fault.message.startsWith(EXPANSION_FAILED) ? 'expand' : 'parse';
      byKind.set(kind, [...(byKind.get(kind) ?? []), fault]);
    }

    for (const [kind, faults] of byKind) {
      const pageIds = new Set(faults.map((fault) => fault.page.page_id));
      // Distinct messages, so a report names the actual fault rather than a count.
      const messages = [...new Set(faults.map((fault) => fault.message))];

      findings.push({
        finding_id: findingId('syntax.malformed-json', kind),
        check: 'syntax.malformed-json',
        severity: 'error',
        origin: 'check',
        title:
          kind === 'parse'
            ? 'A JSON-LD block is not valid JSON'
            : 'A JSON-LD block is valid JSON but could not be expanded',
        subject: { kind: 'site', id: 'site' },
        summary:
          kind === 'parse'
            ? `${faults.length} <script type="application/ld+json"> block(s) across ${pageIds.size} ` +
              `page(s) could not be parsed. Every entity declared in them is lost, and because the ` +
              `failure is silent the pages look like they simply carry no structured data. Nothing ` +
              `in this report covers those blocks.`
            : `${faults.length} JSON-LD block(s) across ${pageIds.size} page(s) parsed as JSON but ` +
              `were rejected by the JSON-LD expansion algorithm — usually a malformed @context or a ` +
              `keyword used where the algorithm does not allow one. The JSON is fine, so a syntax ` +
              `checker will pass it; the block still produces no entities.`,
        expected:
          kind === 'parse'
            ? 'Every ld+json block parsing as valid JSON.'
            : 'Every ld+json block expanding under the JSON-LD algorithm.',
        observed: messages.slice(0, 5).map((message) => {
          const matching = faults.filter((fault) => fault.message === message);
          return {
            value: message,
            observation_count: matching.length,
            page_count: new Set(matching.map((fault) => fault.page.page_id)).size,
            provenance: matching.slice(0, 3).map((fault) => ({
              page_id: fault.page.page_id,
              url: fault.page.canonical_url,
              syntax: 'json-ld',
              block: fault.block,
              pointer: '',
            })),
          };
        }),
        pages_affected: pageIds.size,
        coverage_qualified: false,
        remediation:
          kind === 'parse'
            ? 'Fix the JSON. The raw block is stored verbatim under raw/ in the work directory, so ' +
              'you can see exactly what was emitted.'
            : 'Check the @context and any JSON-LD keywords in the block against the raw copy under raw/.',
        tradeoff: null,
      });
    }

    return findings;
  },
};

export const SYNTAX_CHECKS: Check[] = [malformedJson, unresolvableContext];
