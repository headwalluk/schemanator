/**
 * The freshness line. Every case here is a sentence a reader would act on, so
 * the assertions are against the rendered text rather than against a duration.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import type { Report } from './build.ts';
import { describeCrawlFreshness } from './freshness.ts';

function run(crawlFinishedAt: string, reportFinishedAt: string): Report['run'] {
  return {
    run_id: '20260827-120000',
    site_slug: 'example.com',
    site_origin: 'https://example.com',
    started_at: crawlFinishedAt,
    finished_at: reportFinishedAt,
    crawl_finished_at: crawlFinishedAt,
  };
}

test('a crawl analysed in the same breath reads as fresh, and still prints', () => {
  const line = describeCrawlFreshness(run('2026-08-27T12:00:00Z', '2026-08-27T12:00:04Z'));

  assert.equal(line, 'Crawl under an hour old — fetched 2026-08-27');
});

test('the stale crawl that motivated this says how stale, and when', () => {
  const line = describeCrawlFreshness(run('2026-08-21T09:15:00Z', '2026-08-27T10:00:00Z'));

  assert.equal(line, 'Crawl 6 days old — fetched 2026-08-21');
});

test('overnight is hours, not a rounded day', () => {
  // The distinction someone checking freshness is asking about: a crawl made
  // yesterday evening and analysed this morning is not "1 day".
  const line = describeCrawlFreshness(run('2026-08-26T18:00:00Z', '2026-08-27T08:00:00Z'));

  assert.equal(line, 'Crawl 14 hours old — fetched 2026-08-26');
});

test('units are singular when they are singular', () => {
  assert.equal(
    describeCrawlFreshness(run('2026-08-27T08:00:00Z', '2026-08-27T09:00:00Z')),
    'Crawl 1 hour old — fetched 2026-08-27',
  );
  // 72 hours, past the point where hours stop being the useful unit.
  assert.equal(
    describeCrawlFreshness(run('2026-08-24T09:00:00Z', '2026-08-27T09:00:00Z')),
    'Crawl 3 days old — fetched 2026-08-24',
  );
});

test('a report written before 1.14.0 renders nothing rather than a guess', () => {
  const older = run('2026-08-21T09:15:00Z', '2026-08-27T10:00:00Z');
  // What `JSON.parse` of an older report.json actually hands the renderer.
  delete (older as Partial<Report['run']>).crawl_finished_at;

  assert.equal(describeCrawlFreshness(older), null);
});

test('an unparseable timestamp renders nothing rather than "Invalid Date"', () => {
  assert.equal(describeCrawlFreshness(run('not a date', '2026-08-27T10:00:00Z')), null);
  assert.equal(describeCrawlFreshness(run('2026-08-27T10:00:00Z', 'not a date')), null);
});

test('a clock that moved backwards does not report a negative age', () => {
  // A crawl cannot finish after the report describing it, so this is skew —
  // and "Crawl -3 hours old" sends someone hunting for a crawler bug.
  const line = describeCrawlFreshness(run('2026-08-27T12:00:00Z', '2026-08-27T09:00:00Z'));

  assert.equal(line, 'Crawl under an hour old — fetched 2026-08-27');
});
