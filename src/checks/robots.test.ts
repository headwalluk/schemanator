import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { PageRecord } from '../store/workdir.ts';
import { loadAiCrawlers, parseAiCrawlers, parseRobotsTxt } from './robots.ts';
import { runChecks } from './run.ts';

function page(id: string): PageRecord {
  return {
    page_id: id,
    url: `https://example.com/${id}`,
    canonical_url: `https://example.com/${id}`,
    declared_canonical: null,
    source: 'sitemap:https://example.com/sitemap.xml',
    http_status: 200,
    redirect_chain: [],
    content_type: 'text/html',
    fetched_at: '2026-08-09T00:00:00Z',
    content_sha256: id,
    bytes: 1,
    html_purged: false,
    microdata_types: [],
    extraction: {
      json_ld_blocks: 0,
      json_ld_failed: 0,
      microdata_items: 0,
      rdfa_items: 0,
      nodes: 0,
    },
    errors: [],
  };
}

function robotsFindings(robotsTxt: string | null, sitemapsFound: string[] = []) {
  return runChecks({
    nodes: [],
    pages: [page('a')],
    partialCoverage: false,
    robots: robotsTxt === null ? null : parseRobotsTxt(robotsTxt),
    sitemapsFound,
  }).findings.filter((finding) => finding.check.startsWith('robots.'));
}

// --- the crawler list --------------------------------------------------------

test('the shipped crawler list loads and every entry cites a source', () => {
  const crawlers = loadAiCrawlers();
  assert.equal(crawlers.crawlers.length > 8, true);
  for (const crawler of crawlers.crawlers) {
    assert.match(crawler.source, /^https:\/\//, `${crawler.token} must cite a source`);
    assert.equal(['training', 'retrieval', 'both'].includes(crawler.purpose), true);
  }
});

test('the parser refuses a list it cannot trust', () => {
  assert.throws(() => parseAiCrawlers('{"crawlers":[]}'), /schema_version/);
  assert.throws(() => parseAiCrawlers('{"schema_version":1}'), /crawlers/);
  assert.throws(() => parseAiCrawlers('{"schema_version":1,"crawlers":[]}'), /empty/);
  // An unciteable token is folklore, and this list decides what we tell an
  // operator about their own site.
  assert.throws(
    () =>
      parseAiCrawlers(
        '{"schema_version":1,"crawlers":[{"token":"X","operator":"Y","purpose":"training"}]}',
      ),
    /source/,
  );
});

// --- parsing -----------------------------------------------------------------

test('consecutive User-agent lines form one group', () => {
  const robots = parseRobotsTxt('User-agent: A\nUser-agent: B\nDisallow: /x');
  assert.equal(robots.groups.length, 1);
  assert.deepEqual(robots.groups[0]?.agents, ['a', 'b']);
  assert.deepEqual(robots.groups[0]?.disallow, ['/x']);
});

test('an agent may appear in several groups, and all of them count', () => {
  // Real file, from a corpus site: the site's own rules, then a second block
  // appended by a plugin inside `# START YOAST BLOCK` markers. Taking only the
  // first matching group would silently ignore half the file.
  const robots = parseRobotsTxt(
    'User-agent: *\nDisallow: /wp-admin/\n\n# START YOAST BLOCK\nUser-agent: *\nDisallow:\n',
  );
  assert.equal(robots.groups.length, 2);
});

test('an empty Disallow is not a rule', () => {
  // `Disallow:` with no value is the idiom for allowing everything. Recording
  // it as a rule would make an open site look like a blocked one.
  const robots = parseRobotsTxt('User-agent: *\nDisallow:');
  assert.deepEqual(robots.groups[0]?.disallow, []);
});

test('comments and sitemaps are handled', () => {
  const robots = parseRobotsTxt(
    '# hello\nSitemap: https://example.com/s.xml\nUser-agent: * # trailing\nDisallow: /a',
  );
  assert.deepEqual(robots.sitemaps, ['https://example.com/s.xml']);
  assert.deepEqual(robots.groups[0]?.disallow, ['/a']);
});

// --- robots.ai-crawler-blocked ----------------------------------------------

test('AI crawlers blocked by name are reported, with purpose', () => {
  const findings = robotsFindings(
    'User-agent: GPTBot\nDisallow: /\n\nUser-agent: Claude-User\nDisallow: /',
  );
  const finding = findings.find((f) => f.check === 'robots.ai-crawler-blocked');

  assert.equal(finding?.severity, 'warning', 'blocking AI crawlers is a choice, not a defect');
  assert.match(finding?.title ?? '', /2 AI crawler/);
  // The retrieval/training split is the part that changes the advice.
  assert.match(finding?.summary ?? '', /Claude-User/);
  assert.match(finding?.summary ?? '', /at the time they ask it/);
  // It must read as "confirm this", never as "your site is broken".
  assert.match(finding?.summary ?? '', /may be exactly what you intended/);
});

test('a site blocking everything is not reported as blocking AI crawlers', () => {
  // `User-agent: * / Disallow: /` blocks every crawler including Googlebot.
  // That is a far larger problem, and burying it inside a finding about AI
  // would be the wrong headline entirely.
  assert.deepEqual(robotsFindings('User-agent: *\nDisallow: /'), []);
});

test('a training-only block says so, because the advice differs', () => {
  const finding = robotsFindings('User-agent: CCBot\nDisallow: /').find(
    (f) => f.check === 'robots.ai-crawler-blocked',
  );
  assert.match(finding?.summary ?? '', /does not affect whether an assistant can answer/);
});

test('an unreadable robots.txt reports nothing rather than assuming permission', () => {
  // `02` is emphatic: an unreadable robots.txt is not permission. Null must
  // mean "unknown", never "no rules".
  assert.deepEqual(robotsFindings(null), []);
});

// --- robots.resource-blocked -------------------------------------------------

test('blocked theme and script paths are reported', () => {
  const finding = robotsFindings(
    'User-agent: *\nDisallow: /wp-content/themes/\nDisallow: /assets/js/',
  ).find((f) => f.check === 'robots.resource-blocked');

  assert.equal(finding?.severity, 'warning');
  assert.equal(finding?.observed.length, 2);
});

test('blocking wp-admin alone is normal and is not reported', () => {
  // The single most common line in any WordPress robots.txt. Firing on it would
  // make the check worthless on the majority of sites this tool audits.
  const findings = robotsFindings(
    'User-agent: *\nDisallow: /wp-admin/\nAllow: /wp-admin/admin-ajax.php',
  );
  assert.deepEqual(
    findings.filter((f) => f.check === 'robots.resource-blocked'),
    [],
  );
});

test('an Allow covering the blocked path is the documented fix and silences it', () => {
  const findings = robotsFindings('User-agent: *\nDisallow: /assets/js/\nAllow: /assets/');
  assert.deepEqual(
    findings.filter((f) => f.check === 'robots.resource-blocked'),
    [],
  );
});

test('a rule aimed at one scraper is not a rendering problem', () => {
  // Only wildcard groups matter: blocking assets for a badly-behaved bot does
  // not stop Google rendering the page.
  const findings = robotsFindings('User-agent: BadBot\nDisallow: /wp-content/themes/');
  assert.deepEqual(
    findings.filter((f) => f.check === 'robots.resource-blocked'),
    [],
  );
});

// --- robots.sitemap-missing --------------------------------------------------

test('sitemaps found by probing but absent from robots.txt are reported', () => {
  const finding = robotsFindings('User-agent: *\nDisallow: /wp-admin/', [
    'https://example.com/sitemap.xml',
  ]).find((f) => f.check === 'robots.sitemap-missing');

  assert.equal(finding?.severity, 'opportunity');
  assert.match(finding?.remediation ?? '', /Sitemap: https:\/\/example\.com\/sitemap\.xml/);
});

test('a robots.txt that already names its sitemap is silent', () => {
  const findings = robotsFindings(
    'Sitemap: https://example.com/sitemap.xml\nUser-agent: *\nDisallow:',
    ['https://example.com/sitemap.xml'],
  );
  assert.deepEqual(
    findings.filter((f) => f.check === 'robots.sitemap-missing'),
    [],
  );
});

test('a site with no sitemap at all is a different finding, not this one', () => {
  const findings = robotsFindings('User-agent: *\nDisallow:', []);
  assert.deepEqual(
    findings.filter((f) => f.check === 'robots.sitemap-missing'),
    [],
  );
});
