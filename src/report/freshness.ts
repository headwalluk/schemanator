/**
 * How stale was the crawl this report describes?
 *
 * **Asked for by a machine consumer, and it arrived with a burn attached**
 * (`dev-notes/12`). Nothing in schemanator was wrong: a sister tool read a
 * crawl that had gone stale relative to the live site and reported inbound-link
 * counts that were a faithful description of a site as it existed some days
 * earlier. That is the hardest kind of wrong answer to catch by reading,
 * because every number in it is internally consistent.
 *
 * **Measured between two fields of the report, never against the clock.** The
 * renderers are pure functions from `report.json` to text, and keeping this one
 * pure buys more than testability: re-rendering a stored report a month later
 * says how stale the crawl was *when the report was written*, which is a fact
 * about the report. Reading `Date.now()` here would instead age the document
 * every time somebody opened it, and quietly re-date a conclusion that has not
 * changed.
 *
 * **No threshold, and deliberately none.** How stale is too stale depends
 * entirely on the site — a shop that changes hourly and a brochure site that
 * changes twice a year are both normal, and no evidence exists for a number
 * that separates them. This states the age; the reader decides.
 */

import type { Report } from './build.ts';

const MS_PER_HOUR = 60 * 60 * 1000;
const MS_PER_DAY = 24 * MS_PER_HOUR;

/**
 * Below this, say hours. A crawl finished yesterday evening and analysed this
 * morning is "14 hours", not "1 day" — the rounder unit hides exactly the
 * distinction someone checking freshness is asking about.
 */
const HOURS_UNTIL_DAYS = 48;

/** The UTC date, which is how every other timestamp in the report is written. */
function isoDate(timestamp: string): string {
  return timestamp.slice(0, 'YYYY-MM-DD'.length);
}

function describeAge(elapsedMs: number): string {
  if (elapsedMs < MS_PER_HOUR) return 'under an hour old';
  const hours = Math.round(elapsedMs / MS_PER_HOUR);
  if (hours < HOURS_UNTIL_DAYS) return `${hours} hour${hours === 1 ? '' : 's'} old`;
  const days = Math.round(elapsedMs / MS_PER_DAY);
  return `${days} day${days === 1 ? '' : 's'} old`;
}

/**
 * One line for the report header, or `null` when it cannot be said honestly.
 *
 * Null on a report written before 1.14.0, which has no `crawl_finished_at`, and
 * on an unparseable timestamp. Both render nothing rather than guessing: a
 * freshness line a reader has learnt to trust is worse than no line at all if
 * it can be fabricated.
 */
export function describeCrawlFreshness(run: Report['run']): string | null {
  const crawlFinishedAt = run.crawl_finished_at;
  if (typeof crawlFinishedAt !== 'string' || crawlFinishedAt === '') return null;

  const crawledMs = Date.parse(crawlFinishedAt);
  const reportedMs = Date.parse(run.finished_at);
  if (Number.isNaN(crawledMs) || Number.isNaN(reportedMs)) return null;

  // Clamped rather than reported. A crawl cannot finish after the report that
  // describes it, so a negative elapsed time is a clock that moved, and
  // "crawl age: -3 hours" would send someone hunting for a bug in the crawler.
  const elapsedMs = Math.max(0, reportedMs - crawledMs);

  return `Crawl ${describeAge(elapsedMs)} — fetched ${isoDate(crawlFinishedAt)}`;
}
