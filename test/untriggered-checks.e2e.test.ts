/**
 * The checks that had never fired, end to end: crawl → extract → check.
 *
 * **Nineteen checks in the catalogue had never seen a true positive.** Every one
 * is unit-tested, and unit tests were never the gap: what was unproven is
 * whether the pipeline in front of a rule delivers what the rule needs. Three of
 * the nineteen are silent because a false-positive class was correctly removed
 * from them, which is the outcome we wanted — but a check that has never fired
 * is untriggered rather than validated, and a regression in one would stay
 * invisible until a user hit it (`dev-notes/00`).
 *
 * The other two fixture sites already cover `graph.relative-id`,
 * `syntax.malformed-json`, `indexing.sitemap-duplicate-url` and
 * `indexing.sitemap-overlap`. The remaining sixteen are here.
 *
 * **This found a defect on its first run**, which is the argument for the whole
 * exercise: `robots.sitemap-missing` reported four 404s as sitemaps, because the
 * crawl summary records probe *attempts* and nothing filtered them. Its first
 * true positive was also its first wrong output. See `sitemapsFound`.
 *
 * One crawl, shared. Each assertion is about a different check, none of them
 * mutates anything, and re-crawling sixteen times would add a minute to a suite
 * that runs in twenty-five seconds.
 */

import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { runAnalysis } from '../src/analyse.ts';
import { runCrawl } from '../src/crawl/run.ts';
import { MIN_DELAY_MS } from '../src/net/fetcher.ts';
import type { Finding } from '../src/checks/framework.ts';
import type { Report } from '../src/report/build.ts';
import {
  DEFECT_ALLOWED_BLOCK,
  DEFECT_BLOCKED_CRAWLERS,
  DEFECT_BLOCKED_RESOURCE,
  DEFECT_PATHS,
  startDefectSite,
} from './fixtures/site.ts';

interface Run {
  site: Awaited<ReturnType<typeof startDefectSite>>;
  workRoot: string;
  report: Report;
}

async function crawlDefectSite(): Promise<Run> {
  const site = await startDefectSite();
  const workRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'schemanator-defect-'));
  const summary = await runCrawl({ startUrl: site.origin, workRoot, delayMs: MIN_DELAY_MS });
  const { report } = await runAnalysis({ workRoot, siteSlug: summary.site_slug });
  return { site, workRoot, report };
}

let shared: Promise<Run> | null = null;

/** The one crawl, made on first use and reused by every assertion below. */
const analysed = (): Promise<Run> => (shared ??= crawlDefectSite());

after(async () => {
  if (shared === null) return;
  const { site, workRoot } = await shared;
  await site.close();
  await fs.rm(workRoot, { recursive: true, force: true });
});

/** The findings for one check, failing with the check's name rather than on `undefined`. */
function firedFor(report: Report, check: string): Finding[] {
  const found = report.findings.filter((finding) => finding.check === check);
  assert.equal(found.length > 0, true, `${check} did not fire on the defect site`);
  return found;
}

const observedValues = (findings: readonly Finding[]): string[] =>
  findings.flatMap((finding) => finding.observed.map((row) => row.value));

// --- robots ------------------------------------------------------------------

test('robots.txt blocking AI crawlers is reported, and names them', async () => {
  const { report } = await analysed();
  const values = observedValues(firedFor(report, 'robots.ai-crawler-blocked'));

  assert.deepEqual([...values].sort(), [...DEFECT_BLOCKED_CRAWLERS].sort());
});

test('a blocked theme directory is reported and a blocked wp-admin is not', async () => {
  // The second half is the assertion that matters. A matcher that reported every
  // `Disallow` it saw would pass a fixture carrying only the theme rule, and the
  // check's own remediation says blocking wp-admin is fine and normal.
  const { report } = await analysed();
  const values = observedValues(firedFor(report, 'robots.resource-blocked'));

  assert.deepEqual(values, [`Disallow: ${DEFECT_BLOCKED_RESOURCE}`]);
  assert.equal(
    values.some((value) => value.includes(DEFECT_ALLOWED_BLOCK)),
    false,
    'a Disallow that blocks no renderable asset was reported as one that does',
  );
});

test('an unadvertised sitemap names the sitemap that exists, not the paths probed for it', async () => {
  // The defect this fixture found on its first run. With no `Sitemap:` directive
  // the crawl probes five well-known paths and this site answers one of them, so
  // the summary holds one sitemap and four 404s. Reporting the attempts told the
  // operator to advertise `/wp-sitemap.xml`, which is not there.
  //
  // It also made the check unable to honour its own documentation: "a site with
  // no sitemap at all is a different finding and is not this one" was untrue
  // while five failed probes counted as five sitemaps.
  const { report, site } = await analysed();
  const values = observedValues(firedFor(report, 'robots.sitemap-missing'));

  assert.deepEqual(values, [site.url('/sitemap.xml')]);
});

// --- page and content --------------------------------------------------------

test('a page with no <title> is reported', async () => {
  const { report, site } = await analysed();
  const values = observedValues(firedFor(report, 'page.title-missing'));

  assert.deepEqual(values, [site.url(DEFECT_PATHS.bareHead)]);
});

test('a page that declares no language is reported', async () => {
  const { report, site } = await analysed();
  const values = observedValues(firedFor(report, 'page.lang-missing'));

  assert.deepEqual(values, [site.url(DEFECT_PATHS.bareHead)]);
});

test('a page hiding more than it shows is reported, and a sparse page is not', async () => {
  // `/swatch` also hides more than it shows, and must stay silent: both sides
  // are under the 50-word floor, so it is a thin page rather than one concealing
  // anything. That distinction is the whole check — without the floor this fired
  // on 48 corpus pages with 17 visible words apiece.
  //
  // Asserted against a page that would fail, not against pages that hide nothing
  // at all: `hidden > visible` is false for those however the rule is written,
  // so they could never have caught a regression here.
  const { report, site } = await analysed();
  const values = observedValues(firedFor(report, 'content.hidden-text'));

  assert.deepEqual(values, [site.url(DEFECT_PATHS.hiddenText)]);
});

// --- entity and graph --------------------------------------------------------

test('one @id declared as two unrelated types is an error', async () => {
  const { report } = await analysed();
  const values = observedValues(firedFor(report, 'entity.type-conflict'));

  assert.deepEqual([...values].sort(), ['Organization', 'Person']);
});

test('two values for a functional property on one page are reported', async () => {
  const { report } = await analysed();
  const findings = firedFor(report, 'entity.multi-value');
  const joined = observedValues(findings).join(' ');

  assert.equal(findings.length, 1, 'more than the planted node reported two values');
  for (const telephone of ['+44 20 7946 0000', '+44 20 7946 3333']) {
    assert.equal(joined.includes(telephone), true, `${telephone} is not in the evidence`);
  }
});

test('a structured value nothing references is reported, and the page subjects are not', async () => {
  // The narrowing that made this check trustworthy: the obvious rule fired 1,480
  // times across the corpus and was wrong every time, because an Article or a
  // Product nobody references is the page rather than dead markup. This site
  // carries an unreferenced Product and an unreferenced Article as well as the
  // address, and only the address may be named.
  const { report, site } = await analysed();
  const values = observedValues(firedFor(report, 'graph.orphan-node'));

  assert.deepEqual(values, [`${site.origin}/#address-nobody-uses`]);
});

// --- syntax and google -------------------------------------------------------

test('a @context that is not schema.org is reported rather than fetched', async () => {
  const { report } = await analysed();
  const values = observedValues(firedFor(report, 'syntax.unresolvable-context'));

  assert.deepEqual(values, ['https://example.invalid/vocabulary.jsonld']);
});

test('a Product satisfying none of a required set is reported once, not three times', async () => {
  // Google requires one of offers / review / aggregateRating. Any one will do,
  // so this is a set rather than three missing fields — the fix is one choice.
  const { report } = await analysed();
  const findings = firedFor(report, 'google.incomplete-alternative');

  assert.equal(findings.length, 1, 'a required set was reported as several missing fields');
  assert.equal(
    findings[0]?.title.includes('offers, review, aggregateRating'),
    true,
    `the finding does not name the set: ${findings[0]?.title}`,
  );
});

// --- breadcrumbs -------------------------------------------------------------

test('a crumb pointing at a page the crawl fetched and was refused is reported', async () => {
  // Fetched and refused, never merely absent. The variant `04` originally
  // specified reported four live pages as missing on a real site, because they
  // were section landing pages no sitemap listed and the crawl had no evidence
  // either way.
  const { report, site } = await analysed();
  const values = observedValues(firedFor(report, 'breadcrumb.broken-trail-item'));

  assert.deepEqual(values, [site.url(DEFECT_PATHS.brokenCrumb)]);
});

test('a page another trail places in the tree, publishing none itself, is reported', async () => {
  // `/shop` is a crumb in `/shop/widget`'s trail and carries no BreadcrumbList.
  // `/gone-section` is a crumb too and must not appear: it 404s, so it is
  // `breadcrumb.broken-trail-item`'s and not this one's.
  const { report } = await analysed();
  const values = observedValues(firedFor(report, 'breadcrumb.missing'));

  assert.deepEqual(values, [DEFECT_PATHS.breadcrumbSilent]);
});

// --- indexing ----------------------------------------------------------------

test('a canonical naming a URL that redirects is reported', async () => {
  const { report, site } = await analysed();
  const values = observedValues(firedFor(report, 'indexing.canonical-to-redirect'));

  assert.equal(values.length, 1);
  for (const part of [DEFECT_PATHS.canonicalToRedirect, DEFECT_PATHS.redirecting]) {
    assert.equal(
      values[0]?.includes(site.url(part)),
      true,
      `the evidence does not name ${part}: ${values[0]}`,
    );
  }
});

test('a canonical chain is reported once, from its start', async () => {
  // Three pages, one chain. `/chain-middle` is not a second chain because
  // `/chain-end` is self-canonical, which is what ends it.
  const { report, site } = await analysed();
  const values = observedValues(firedFor(report, 'indexing.canonical-chain'));

  assert.deepEqual(values, [
    `${site.url(DEFECT_PATHS.chainStart)} → ${site.url(DEFECT_PATHS.chainMiddle)} → ` +
      site.url(DEFECT_PATHS.chainEnd),
  ]);
});

test('two URLs serving byte-identical bodies are reported as one page', async () => {
  const { report, site } = await analysed();
  const values = observedValues(firedFor(report, 'indexing.duplicate-content'));

  assert.equal(values.length, 1, 'the twins were not grouped into one finding');
  for (const twin of DEFECT_PATHS.twins) {
    assert.equal(values[0]?.includes(site.url(twin)), true, `${twin} is not in the evidence`);
  }
});

// --- the fixture's own premise ----------------------------------------------

test('group link stays silent, because every page here is linked from every other', async () => {
  // Not a check being tested — a property of the fixture that has to hold for
  // the rest of this file to be readable. Drop the nav and `link.orphan`
  // correctly reports the entire sitemap, burying sixteen deliberate findings
  // under fifteen incidental ones.
  const { report } = await analysed();

  assert.deepEqual(
    report.findings.filter((finding) => finding.check.startsWith('link.')).map((f) => f.check),
    [],
  );
});
