/**
 * Crawl frontier — queue state that makes a run resumable.
 *
 * A 5,000-URL site at 1 req/sec is ~90 minutes. Restarting from zero is
 * unacceptable and, more to the point, impolite: it means re-fetching thousands
 * of pages somebody else is paying to serve.
 *
 * Implemented as an append-only journal rather than a rewritten file. Rewriting
 * the whole queue after every fetch is O(n²) over a crawl and gives a window
 * where a crash truncates everything; appending one line is atomic enough for
 * our purposes and self-heals by replay — the last record for a URL wins.
 */

import fs from 'node:fs/promises';

export type FrontierStatus = 'pending' | 'done' | 'failed' | 'skipped';

export interface FrontierItem {
  url: string;
  page_id: string;
  status: FrontierStatus;
  /** Where the URL came from — sitemap, homepage fallback. */
  source: string;
  attempts: number;
  note: string | null;
  updated_at: string;
}

export class Frontier {
  private readonly path: string;
  private readonly items = new Map<string, FrontierItem>();

  constructor(journalPath: string) {
    this.path = journalPath;
  }

  /**
   * Replay the journal. Later records supersede earlier ones for the same URL,
   * so the queue converges on its last known state regardless of where a crash
   * landed. A corrupt trailing line — the classic half-written record — is
   * skipped rather than fatal.
   */
  async load(): Promise<void> {
    let raw: string;
    try {
      raw = await fs.readFile(this.path, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }

    for (const line of raw.split('\n')) {
      if (line.trim() === '') continue;
      try {
        const item = JSON.parse(line) as FrontierItem;
        if (typeof item.url === 'string') this.items.set(item.url, item);
      } catch {
        // Half-written final line after a crash. Ignore it; the URL simply
        // stays pending and gets re-fetched, which is the safe direction.
      }
    }
  }

  /** Add a URL if it is not already known. Existing state is never overwritten. */
  async add(url: string, pageId: string, source: string): Promise<boolean> {
    if (this.items.has(url)) return false;

    await this.write({
      url,
      page_id: pageId,
      status: 'pending',
      source,
      attempts: 0,
      note: null,
      updated_at: new Date().toISOString(),
    });
    return true;
  }

  async markDone(url: string, note: string | null = null): Promise<void> {
    await this.update(url, 'done', note);
  }

  async markFailed(url: string, note: string): Promise<void> {
    await this.update(url, 'failed', note);
  }

  async markSkipped(url: string, note: string): Promise<void> {
    await this.update(url, 'skipped', note);
  }

  private async update(url: string, status: FrontierStatus, note: string | null): Promise<void> {
    const existing = this.items.get(url);
    if (existing === undefined) return;

    await this.write({
      ...existing,
      status,
      note,
      attempts: existing.attempts + 1,
      updated_at: new Date().toISOString(),
    });
  }

  private async write(item: FrontierItem): Promise<void> {
    this.items.set(item.url, item);
    await fs.appendFile(this.path, `${JSON.stringify(item)}\n`);
  }

  /** URLs still to fetch, in insertion order — which is sitemap document order. */
  pending(): FrontierItem[] {
    return [...this.items.values()].filter((item) => item.status === 'pending');
  }

  get(url: string): FrontierItem | undefined {
    return this.items.get(url);
  }

  all(): FrontierItem[] {
    return [...this.items.values()];
  }

  counts(): Record<FrontierStatus, number> {
    const counts: Record<FrontierStatus, number> = { pending: 0, done: 0, failed: 0, skipped: 0 };
    for (const item of this.items.values()) counts[item.status] += 1;
    return counts;
  }
}
