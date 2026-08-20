/**
 * The link hop, end to end: crawl → extract → check.
 *
 * Driven through `runCrawl` and `runAnalysis` rather than by handing findings
 * to a check, because **the thing being tested is not the rule — it is whether
 * the crawl fetched enough to make the rule true.** A unit test over synthetic
 * page records would pass just as happily against the sitemap-only crawl that
 * reported 37% false positives on a real site (`dev-notes/11`).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { runAnalysis } from '../src/analyse.ts';
import { runCrawl } from '../src/crawl/run.ts';
import { MIN_DELAY_MS } from '../src/net/fetcher.ts';
import { LINK_HOP_SOURCE } from '../src/store/workdir.ts';
import { LINK_GRAPH_PATHS, LINK_GRAPH_UNLISTED, startLinkGraphSite } from './fixtures/site.ts';

const quiet = { delayMs: MIN_DELAY_MS };

async function tempWorkRoot(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'schemanator-link-'));
}

/** Crawl the link-graph fixture and analyse it. */
async function run(
  options: { linkHop?: boolean; linkHopPages?: number; maxPages?: number } = {},
): Promise<{
  site: Awaited<ReturnType<typeof startLinkGraphSite>>;
  workRoot: string;
  report: Awaited<ReturnType<typeof runAnalysis>>['report'];
  summary: Awaited<ReturnType<typeof runCrawl>>;
}> {
  const site = await startLinkGraphSite();
  const workRoot = await tempWorkRoot();
  const summary = await runCrawl({ startUrl: site.origin, workRoot, ...quiet, ...options });
  const { report } = await runAnalysis({ workRoot, siteSlug: summary.site_slug });
  return { site, workRoot, report, summary };
}

async function cleanUp(site: { close: () => Promise<void> }, workRoot: string): Promise<void> {
  await site.close();
  await fs.rm(workRoot, { recursive: true, force: true });
}

test('the hop fetches internal pages that no sitemap lists', async () => {
  const { site, workRoot, summary } = await run();
  try {
    // Four unlisted targets: the hub, the paginated archive, a redirect into
    // the hub, and one Disallowed.
    assert.deepEqual(summary.link_hop, { discovered: 4, queued: 3, disallowed: 1, dropped: 0 });

    const raw = await fs.readFile(path.join(workRoot, summary.site_slug, 'pages.jsonl'), 'utf8');
    const pages = raw
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((line) => JSON.parse(line) as { canonical_url: string; source: string });

    const hopped = pages.filter((page) => page.source.startsWith(LINK_HOP_SOURCE));
    assert.deepEqual(
      hopped.map((page) => page.canonical_url).sort(),
      [site.url(LINK_GRAPH_UNLISTED.paginated), site.url(LINK_GRAPH_UNLISTED.hub)].sort(),
    );

    // The source names the page that linked to it, or the manifest holds a URL
    // with no account of why it is there. `01` makes provenance mandatory.
    for (const page of hopped) {
      assert.notEqual(
        page.source,
        LINK_HOP_SOURCE,
        `${page.canonical_url} does not say what linked to it`,
      );
    }
  } finally {
    await cleanUp(site, workRoot);
  }
});

test('a page reachable only from a noindex hub is reported', async () => {
  const { site, workRoot, report } = await run();
  try {
    const findings = report.findings.filter(
      (finding) => finding.check === 'link.noindex-only-inbound',
    );
    assert.equal(findings.length > 0, true, 'link.noindex-only-inbound did not fire');

    // Aggregation collapses the two guides into one finding, so read the pages
    // it touches rather than the finding count.
    const subjects = new Set(
      findings.flatMap((finding) => [
        finding.subject.id,
        ...finding.observed.map((row) => row.value),
      ]),
    );
    for (const guidePath of LINK_GRAPH_PATHS.behindNoIndex) {
      assert.equal(
        [...subjects].some((value) => value.includes(guidePath)),
        true,
        `${guidePath} is behind a noindex hub and was not reported`,
      );
    }
  } finally {
    await cleanUp(site, workRoot);
  }
});

test('a page reachable only from unlisted pagination is NOT reported', async () => {
  // The whole reason the hop exists. Sitemap-only, this page looks exactly like
  // the two guides above; with the hop, the archive that links to it is fetched,
  // is indexable, and the page stops qualifying.
  const { site, workRoot, report } = await run();
  try {
    const linkFindings = report.findings.filter((finding) => finding.check.startsWith('link.'));

    // Non-vacuity first. "Not reported" is satisfied just as well by a group
    // that never ran, which is the one way this test could pass while the thing
    // it guards is broken.
    assert.equal(
      linkFindings.length > 0,
      true,
      'group link produced nothing at all, so "not reported" proves nothing',
    );

    const mentioned = linkFindings.flatMap((finding) => [
      finding.subject.id,
      ...finding.observed.map((row) => row.value),
    ]);

    assert.equal(
      mentioned.some((value) => value.includes(LINK_GRAPH_PATHS.behindPagination)),
      false,
      'the page behind unlisted pagination was reported — the hop did not close the graph',
    );
  } finally {
    await cleanUp(site, workRoot);
  }
});

test('a page nothing links to is an orphan, and its self-links do not count', async () => {
  const { site, workRoot, report } = await run();
  try {
    const orphan = report.findings.find((finding) => finding.check === 'link.orphan');
    assert.notEqual(orphan, undefined, 'link.orphan did not fire');

    assert.deepEqual(
      orphan?.observed.map((row) => row.value),
      [site.url(LINK_GRAPH_PATHS.orphan)],
      'the orphan set is not exactly the one page nothing links to',
    );
  } finally {
    await cleanUp(site, workRoot);
  }
});

test('hop pages stay out of every group except link', async () => {
  // Decision 3 of `dev-notes/11`, and the sharpest regression risk in the whole
  // change: a hop page is evidence about the sample, not a member of it.
  //
  // Asserted as a page *count*, not as an absence of URLs in `observed`, which
  // is what the first version of this test did — and it passed against a
  // deliberately broken `isHopPage` because the checks that leak (`graph`,
  // `page`, `content`) aggregate to a site-level finding and never name the
  // page they counted. `graph.relative-id` went from 6 pages to 8 with the leak
  // in place and the test noticed nothing.
  const { site, workRoot, report } = await run();
  try {
    // Derived, not counted by hand: adding a page to the fixture broke the
    // hand-written arithmetic here the first time, which is a test failing for
    // a reason that has nothing to do with what it guards.
    const sitemapPages = Object.values(LINK_GRAPH_PATHS).flat().length;

    for (const finding of report.findings) {
      if (finding.check.startsWith('link.')) continue;
      assert.equal(
        finding.pages_affected <= sitemapPages,
        true,
        `${finding.check} counts ${finding.pages_affected} pages, more than the ` +
          `${sitemapPages} in the sitemap — a hop page leaked into the audited sample`,
      );
    }

    // And the same again from the other side: no finding outside group `link`
    // may name a hop page.
    const hopUrls = [site.url(LINK_GRAPH_UNLISTED.hub), site.url(LINK_GRAPH_UNLISTED.paginated)];
    const offenders = report.findings
      .filter((finding) => !finding.check.startsWith('link.'))
      .flatMap((finding) =>
        finding.observed
          .map((row) => row.value)
          .filter((value) => hopUrls.some((url) => value.includes(url)))
          .map((value) => `${finding.check}: ${value}`),
      );

    assert.deepEqual(offenders, [], 'a hop page was audited as if it were a sitemap page');
  } finally {
    await cleanUp(site, workRoot);
  }
});

test('--no-link-hop silences the link checks rather than guessing', async () => {
  // Silence, not a qualified finding. Without the hop, the orphan and the page
  // behind a noindexed hub are indistinguishable from the page behind unlisted
  // pagination, and reporting two of three would be worse than reporting none.
  const { site, workRoot, report, summary } = await run({ linkHop: false });
  try {
    assert.equal(summary.link_hop, null);
    assert.deepEqual(
      report.findings.filter((finding) => finding.check.startsWith('link.')),
      [],
    );
  } finally {
    await cleanUp(site, workRoot);
  }
});

test('the hop cap keeps the most-linked candidate and records the rest', async () => {
  const { site, workRoot, summary } = await run({ linkHopPages: 1 });
  try {
    // Three unlisted targets: two fetchable, one Disallowed. With a cap of 1
    // the counts must attribute one to the cap and one to robots.txt — the
    // live-run defect was reporting both as "raise --link-hop-pages".
    assert.deepEqual(summary.link_hop, { discovered: 4, queued: 1, disallowed: 1, dropped: 2 });
  } finally {
    await cleanUp(site, workRoot);
  }
});

test('a sitemap URL the sample dropped is not treated as an unlisted page', async () => {
  // The bug a dry run of a larger client site exposed before it cost a request:
  // the hop's "already known" set was built from the *sampled* URLs, so on any site
  // where `--max-pages` bites, every dropped sitemap URL reads as "linked but
  // in no sitemap". On that site it was 464 of them, and the hop would have
  // spent its whole budget re-fetching pages the sample deliberately let go.
  //
  // Invisible on the site this was built against, where 54 URLs sat under a cap
  // of 100 and the two sets were identical.
  const { site, workRoot, summary } = await run({ maxPages: 3 });
  try {
    assert.equal(
      summary.truncated !== null,
      true,
      'the cap did not bite, so this test proves nothing',
    );

    // Three unlisted targets exist regardless of the cap: the hub, the paginated
    // archive, and the Disallowed one. The dropped sitemap URLs must not join
    // them, however many of them the sample let go.
    assert.equal(
      summary.link_hop?.discovered,
      4,
      'a sitemap URL dropped by --max-pages was counted as an unlisted page',
    );

    const raw = await fs.readFile(path.join(workRoot, summary.site_slug, 'pages.jsonl'), 'utf8');
    const fetched = raw
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((line) => JSON.parse(line) as { canonical_url: string });

    assert.equal(
      fetched.some((page) => page.canonical_url.endsWith(LINK_GRAPH_PATHS.droppedBySample)),
      false,
      'the hop re-fetched a page the sample had dropped',
    );
  } finally {
    await cleanUp(site, workRoot);
  }
});

test('the coverage numbers reconcile against the manifest', async () => {
  // Every number in the report's summary table has to be one a reader could
  // count in `pages.jsonl` themselves, and they have to agree with each other.
  //
  // This exists because the first version computed them by subtracting a record
  // count from a request count, and the two are different things — the fixture
  // now has a hop URL that redirects into another hop URL, so two requests
  // produce one record. On a large real site that printed `pages_fetched: 102`
  // beside `pages_extracted: 98` for a sample of exactly 100.
  const { site, workRoot, report, summary } = await run();
  try {
    const raw = await fs.readFile(path.join(workRoot, summary.site_slug, 'pages.jsonl'), 'utf8');
    const records = raw
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((line) => JSON.parse(line) as { source: string });

    const hop = records.filter((page) => page.source.startsWith(LINK_HOP_SOURCE)).length;

    // The redirect has to have collapsed, or this proves nothing about the
    // request-versus-record distinction it exists to guard.
    assert.equal(
      (summary.link_hop?.queued ?? 0) > hop,
      true,
      'no hop request merged into another, so the fixture no longer covers this',
    );

    assert.equal(report.coverage.pages_linked, hop, 'pages_linked is not the hop record count');
    assert.equal(
      report.coverage.pages_fetched + report.coverage.pages_linked,
      records.length,
      'the audited pages and the linked pages do not add up to the manifest',
    );
    assert.equal(
      report.coverage.pages_extracted <= report.coverage.pages_fetched,
      true,
      `pages_extracted (${report.coverage.pages_extracted}) exceeds pages_fetched ` +
        `(${report.coverage.pages_fetched}) — two numbers in one table that cannot both be true`,
    );
    assert.equal(
      report.coverage.pages_fetched <= report.coverage.urls_queued,
      true,
      'more audited pages than URLs were queued',
    );
  } finally {
    await cleanUp(site, workRoot);
  }
});

test('a capped crawl silences group link rather than guessing', async () => {
  // Found by the corpus shakedown, on a 564-URL site sampled at 100:
  // `link.orphan` reported nine pages "linked from nowhere on the site", a
  // claim resting on 18% of it. 464 sitemap URLs were never fetched and any of
  // them was free to hold the link that would disprove all nine. Spot-checked
  // by hand and neither confirmable nor refutable.
  //
  // The hop does not rescue this: it follows links *off* the sitemap, and these
  // are sitemap URLs the sample dropped. Only a bigger `--max-pages` closes it.
  const { site, workRoot, report, summary } = await run({ maxPages: 3 });
  try {
    assert.equal(summary.truncated !== null, true, 'the cap did not bite');
    assert.deepEqual(
      report.findings.filter((finding) => finding.check.startsWith('link.')),
      [],
      'group link reported on a capped crawl, where an absence claim cannot be sound',
    );
  } finally {
    await cleanUp(site, workRoot);
  }
});

test('group link findings are never qualified by coverage', async () => {
  // The corollary, and worth asserting because it is the tell that the gate is
  // doing its job: these only run on a complete crawl, so a finding that exists
  // is the whole-sitemap answer. A `coverage_qualified: true` here would mean
  // the gate had been loosened into a hedge.
  const { site, workRoot, report } = await run();
  try {
    const link = report.findings.filter((finding) => finding.check.startsWith('link.'));
    assert.equal(link.length > 0, true, 'no link findings, so this proves nothing');
    for (const finding of link) {
      assert.equal(
        finding.coverage_qualified,
        false,
        `${finding.check} is qualified by coverage, but group link only runs on a complete crawl`,
      );
    }
  } finally {
    await cleanUp(site, workRoot);
  }
});

test('a capped hop silences group link, even on a complete sitemap crawl', async () => {
  // Found immediately after the coverage gate, by the same large site at full
  // sitemap coverage — which is exactly why the sitemap gate alone was not
  // enough. `coverage.complete` was true and `link.orphan` reported 29 pages,
  // while 205 unlisted URLs sat unfetched behind `--link-hop-pages`. The
  // headline said the crawl was complete; the link graph was not.
  const { site, workRoot, report, summary } = await run({ linkHopPages: 1 });
  try {
    assert.equal(summary.truncated, null, 'the sitemap crawl must be complete for this test');
    assert.equal((summary.link_hop?.dropped ?? 0) > 0, true, 'the hop cap did not bite');

    assert.deepEqual(
      report.findings.filter((finding) => finding.check.startsWith('link.')),
      [],
      'group link reported while unlisted pages were still unfetched',
    );
  } finally {
    await cleanUp(site, workRoot);
  }
});
