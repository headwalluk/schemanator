/**
 * No check may scale its finding count with the size of the site.
 *
 * `report.json` is bounded today — measured at 36 KB for the largest corpus
 * report — and it is bounded *only* because every check respects the caps in
 * `05`: provenance capped at 3, `AGGREGATE_SAMPLE` at 10, `observed` sliced,
 * and one finding per root cause rather than one per subject.
 *
 * A check that forgets `pattern` and emits one finding per page breaks all of
 * that at once. On a 500-page site it yields 500 findings — forty times a normal
 * report, and unreadable. Nothing structural prevents it; the discipline is the
 * only thing holding, and discipline is what tests are for.
 *
 * This is the same posture as `docs-consistency` and `exit-codes`: catch it when
 * somebody writes it, not on a client site.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { ExtractedNode } from '../extract/types.ts';
import type { PageRecord } from '../store/workdir.ts';
import { ALL_CHECKS, runChecks } from './run.ts';

/** Big enough that a per-page check is unmistakable against the cap. */
const PAGES = 1000;

/**
 * The most findings any single check may emit, at any site size.
 *
 * Generous on purpose. `AGGREGATE_THRESHOLD` is 3, so anything affecting three
 * or more subjects collapses; a check producing 50 *distinct* root causes on one
 * site is either badly aggregated or describing something too granular to act
 * on. Either way it wants looking at before it ships.
 */
const CAP = 50;

const S = (name: string): string => `http://schema.org/${name}`;
const value = (text: string) => [{ '@value': text }];
const ref = (id: string) => [{ '@id': id }];

function page(index: number, overrides: Partial<PageRecord> = {}): PageRecord {
  const id = `p${index}`;
  return {
    page_id: id,
    url: `https://example.com/${id}`,
    canonical_url: `https://example.com/${id}`,
    declared_canonical: null,
    source: `sitemap:https://example.com/sitemap.xml`,
    http_status: 200,
    redirect_chain: [],
    content_type: 'text/html',
    fetched_at: '2026-08-09T00:00:00Z',
    content_sha256: `sha-${id}`,
    bytes: 1000,
    html_purged: false,
    microdata_types: [],
    page_facts: null,
    extraction: {
      json_ld_blocks: 1,
      json_ld_failed: 0,
      microdata_items: 0,
      rdfa_items: 0,
      nodes: 2,
    },
    errors: [],
    ...overrides,
  };
}

/**
 * A site engineered so that *many* checks have something to say, and a naive
 * per-page check would be obvious.
 *
 * Every page carries: a sitewide entity whose `telephone` diverges, a
 * `LocalBusiness` missing the address Google requires, a `Product` missing every
 * recommended field, an anonymous `Person`, and an empty string. A page-scoped
 * check would produce 1,000 findings from any one of them.
 */
function bigSite(): { nodes: ExtractedNode[]; pages: PageRecord[] } {
  const nodes: ExtractedNode[] = [];
  const pages: PageRecord[] = [];

  for (let index = 0; index < PAGES; index += 1) {
    const pageId = `p${index}`;
    // A tenth of the sitemap is dead, and a tenth redirects.
    pages.push(
      index % 10 === 0
        ? page(index, { http_status: 404 })
        : index % 10 === 1
          ? page(index, {
              redirect_chain: [
                {
                  url: `https://example.com/${pageId}`,
                  status: 301,
                  location: 'https://example.com/x',
                },
                { url: 'https://example.com/x', status: 301, location: 'https://example.com/y' },
              ],
            })
          : page(index),
    );

    const source = { syntax: 'json-ld' as const, block: 0, pointer: `/${index}` };

    nodes.push({
      node_id: 'https://example.com/#org',
      raw_id: null,
      is_blank: false,
      page_id: pageId,
      types: [S('LocalBusiness')],
      // Divergent on every page, and missing the address Google requires.
      props: { [S('name')]: value('Acme'), [S('telephone')]: value(`+44 ${index}`) },
      source,
    });

    nodes.push({
      node_id: `https://example.com/${pageId}#product`,
      raw_id: null,
      is_blank: false,
      page_id: pageId,
      types: [S('Product')],
      props: { [S('name')]: value('Thing'), [S('offers')]: ref(`_:${pageId}-offer`) },
      source,
    });

    nodes.push({
      node_id: `_:${pageId}-person`,
      raw_id: null,
      is_blank: true,
      page_id: pageId,
      types: [S('Person')],
      props: { [S('name')]: value(''), [S('jobTitle')]: value('') },
      source,
    });
  }

  return { nodes, pages };
}

test('no check emits findings in proportion to site size', () => {
  const { nodes, pages } = bigSite();
  const { findings } = runChecks({ nodes, pages, partialCoverage: false });

  const perCheck = new Map<string, number>();
  for (const finding of findings) {
    perCheck.set(finding.check, (perCheck.get(finding.check) ?? 0) + 1);
  }

  const offenders = [...perCheck.entries()]
    .filter(([, count]) => count > CAP)
    .sort(([, left], [, right]) => right - left)
    .map(([check, count]) => `${check}: ${count} findings from ${PAGES} pages`);

  assert.deepEqual(
    offenders,
    [],
    'a check is emitting one finding per subject where it should aggregate — ' +
      'supply a `pattern` so findings sharing a root cause collapse',
  );
});

test('the whole report stays small on a large site', () => {
  // The end-to-end version of the same guarantee. `report.json` is what a
  // consumer parses, and its size must track findings rather than pages.
  const { nodes, pages } = bigSite();
  const { findings } = runChecks({ nodes, pages, partialCoverage: false });

  const bytes = JSON.stringify(findings).length;
  assert.equal(
    bytes < 500_000,
    true,
    `findings serialise to ${Math.round(bytes / 1024)} KB from ${PAGES} pages — ` +
      'the caps in 05 are not holding',
  );
});

test('the fixture actually exercises a broad range of checks', () => {
  // Without this, the guard above could pass because nothing fired at all —
  // which is the failure mode every other invariant test in this repo guards
  // against, and it would be embarrassing here of all places.
  const { nodes, pages } = bigSite();
  const { findings } = runChecks({ nodes, pages, partialCoverage: false });

  const groups = new Set(findings.map((finding) => finding.check.split('.')[0]));
  assert.equal(
    groups.size >= 4,
    true,
    `only ${groups.size} group(s) fired: ${[...groups].join(', ')} — the fixture has stopped being representative`,
  );
});

test('every check is registered under a group the sort knows about', () => {
  // Ordering is severity, then group. An unlisted group sorts last, which is a
  // deliberate default rather than a bug — but it should be a decision, so this
  // fails when a new group arrives without one being taken.
  const KNOWN = new Set([
    'syntax',
    'entity',
    'graph',
    'value',
    'url',
    'breadcrumb',
    'content',
    'page',
    'google',
    'indexing',
    'robots',
    'coverage',
  ]);

  const unranked = [...new Set(ALL_CHECKS.map((check) => check.group))]
    .filter((group) => !KNOWN.has(group))
    .sort();

  assert.deepEqual(
    unranked,
    [],
    'add these to GROUP_ORDER in run.ts, or they sort to the bottom of every report by default',
  );
});
