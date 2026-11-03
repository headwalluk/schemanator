/**
 * `url.tracking-parameter` — internal links carrying a click, campaign or
 * visitor identifier, as named by `data/tracking-parameters.json`.
 *
 * Reads the link graph, which is otherwise group `link`'s. It makes a presence
 * claim about links that were fetched, so the closed-graph gate that `link`'s
 * absence claims need does not apply.
 */

import type { PageRecord } from '../store/workdir.ts';
import { isTrackingParameter, type TrackingParameters } from '../url/tracking-parameters.ts';
import { findingId, indexPagesById, sampleObserved, type Check } from './framework.ts';

const TRACKING_PARAMETER = 'url.tracking-parameter';

/** Tracking parameter names in a URL's query, as written; empty when there are none. */
export function trackingKeys(url: string, rules: TrackingParameters): string[] {
  const parsed = URL.parse(url);
  if (parsed === null) return [];
  const found = new Set<string>();
  for (const key of parsed.searchParams.keys()) {
    if (isTrackingParameter(key, rules)) found.add(key.toLowerCase());
  }
  return [...found];
}

/** Origin and path with any trailing `page/N/` and slash removed: what "this page" means here. */
function pageKey(url: string): string | null {
  const parsed = URL.parse(url);
  if (parsed === null) return null;
  const pathname = parsed.pathname.replace(/\/page\/\d+\/?$/, '/').replace(/\/+$/, '');
  return `${parsed.origin}${pathname}`;
}

/** Whether a link points back at the page it sits on, pagination included. */
function pointsBack(url: string, page: PageRecord): boolean {
  const target = pageKey(url);
  return (
    target !== null && (target === pageKey(page.canonical_url) || target === pageKey(page.url))
  );
}

interface Polluted {
  page: PageRecord;
  urls: Set<string>;
  keys: Set<string>;
  backToSelf: number;
}

/** Where one page's tagged links go, for its evidence row. */
function destinations(entry: Polluted): string {
  const elsewhere = entry.urls.size - entry.backToSelf;
  if (elsewhere === 0) return 'all back to this page';
  if (entry.backToSelf === 0) return 'all to other pages';
  return `${entry.backToSelf} back to this page, ${elsewhere} to other pages`;
}

const trackingParameter: Check = {
  id: TRACKING_PARAMETER,
  group: 'url',
  run({ pages, links, trackingParameters }) {
    // Audited pages only: a page reached by following one of these links
    // exists because of the defect, and is not a second instance of it.
    const audited = indexPagesById(pages);
    const byPage = new Map<string, Polluted>();

    for (const link of links) {
      if (!link.internal) continue;
      const page = audited.get(link.from);
      if (page === undefined) continue;
      const keys = trackingKeys(link.to, trackingParameters);
      if (keys.length === 0) continue;

      const entry = byPage.get(page.page_id) ?? {
        page,
        urls: new Set<string>(),
        keys: new Set<string>(),
        backToSelf: 0,
      };
      if (!entry.urls.has(link.to)) {
        entry.urls.add(link.to);
        if (pointsBack(link.to, page)) entry.backToSelf += 1;
      }
      for (const key of keys) entry.keys.add(key);
      byPage.set(page.page_id, entry);
    }

    if (byPage.size === 0) return [];

    // Pasted links first: each needs its own edit, where generated ones share one fix.
    const elsewhere = (entry: Polluted): number => entry.urls.size - entry.backToSelf;
    const affected = [...byPage.values()].sort(
      (left, right) =>
        elsewhere(right) - elsewhere(left) ||
        right.urls.size - left.urls.size ||
        left.page.canonical_url.localeCompare(right.page.canonical_url),
    );
    const allKeys = [...new Set(affected.flatMap((entry) => [...entry.keys]))].sort();
    const generated = affected.filter((entry) => entry.backToSelf > 0).length;
    const pasted = affected.filter((entry) => entry.backToSelf < entry.urls.size).length;
    const causes: string[] = [];
    const fixes: string[] = [];
    if (generated > 0) {
      causes.push(
        `On ${generated} page(s) the links point back at the page itself — pagination, ` +
          `"Add to basket", "Cancel reply". The platform built them from the URL of a visitor ` +
          `who arrived with the parameter, and that copy of the page was cached and served to ` +
          `everyone.`,
      );
      fixes.push(
        'For links back to their own page: strip these parameters from the request before ' +
          'the page is rendered, or keep such requests out of the page cache, then purge it.',
      );
    }
    if (pasted > 0) {
      causes.push(
        `On ${pasted} page(s) they point at other pages, which usually means a URL copied ` +
          `from a browser's address bar, after arriving from an ad, a shopping result or an ` +
          `email, was pasted into the content.`,
      );
      fixes.push('For links to other pages: edit the content and remove the parameter.');
    }
    const urlCount = affected.reduce((total, entry) => total + entry.urls.size, 0);

    return [
      {
        finding_id: findingId(TRACKING_PARAMETER, 'site'),
        check: TRACKING_PARAMETER,
        severity: 'warning',
        origin: 'check',
        title: `${affected.length} page(s) link internally with tracking parameters (${allKeys.join(', ')})`,
        subject: { kind: 'site', id: 'internal-links' },
        summary:
          `${affected.length} page(s) carry ${urlCount} internal link URL(s) with a tracking ` +
          `parameter: ${allKeys.map((key) => `\`${key}\``).join(', ')}. These identify one ` +
          `click, campaign or visit — an ad click, a Google Shopping result, an email. In a link ` +
          `served to everyone, analytics credits every visit that follows it to that click or ` +
          `campaign instead of to how the visitor really arrived, and each value is another URL ` +
          `for the same page, held together only by its canonical tag. ${causes.join(' ')}`,
        expected: 'Internal links without click, campaign or recipient parameters.',
        ...sampleObserved(
          affected.map((entry) => ({
            value: entry.page.canonical_url,
            detail: `${entry.urls.size} link URL(s) with ${[...entry.keys].sort().join(', ')} — ${destinations(entry)}`,
            observation_count: entry.urls.size,
            page_count: 1,
            provenance: [],
          })),
        ),
        pages_affected: affected.length,
        coverage_qualified: false,
        remediation: fixes.join(' '),
        tradeoff: null,
        page_ids: affected.map((entry) => entry.page.page_id),
      },
    ];
  },
};

export const TRACKING_CHECKS: readonly Check[] = [trackingParameter];
