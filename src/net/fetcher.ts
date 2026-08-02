/**
 * The polite fetcher.
 *
 * This tool fetches other people's websites. Every default errs slow — see
 * `dev-notes/02-crawler-requirements.md`. A tool that gets a hosting company's
 * IP range flagged as abusive is worse than no tool at all.
 *
 * The fetcher knows nothing about robots.txt. That check belongs to the crawl
 * loop, because robots.txt itself has to be fetched before it can be obeyed.
 * What the fetcher does own is rate limiting, backoff and the honest record of
 * what happened, including the failures.
 */

import { VERSION } from '../runtime.ts';
import { hostKey } from '../url/canonical.ts';

/**
 * The User-Agent must be honest and **contactable** (`dev-notes/02`) — a site
 * owner seeing us in their logs needs a way to reach the operator. Never
 * impersonate a browser.
 *
 * `SCHEMANATOR_CONTACT` overrides the URL. Set it before crawling anything you
 * do not own: the default points at a repo that may not be public, which makes
 * the "contactable" half of the promise a lie.
 */
const CONTACT_URL = process.env['SCHEMANATOR_CONTACT'] ?? 'https://github.com/headwall-hosting/schemanator';

export const USER_AGENT = `schemanator/${VERSION} (+${CONTACT_URL})`;

/** Absolute floor on the inter-request delay, even when explicitly overridden. */
export const MIN_DELAY_MS = 200;

export interface FetcherOptions {
  /** Delay between requests to the same host. Default 1000 ms, floored at {@link MIN_DELAY_MS}. */
  delayMs?: number;
  /** Connect + read timeout for a single attempt. Default 20 s. */
  timeoutMs?: number;
  /** Maximum redirect hops before giving up. Default 5. */
  maxRedirects?: number;
  /** Maximum response body size. Default 10 MB. */
  maxBodyBytes?: number;
  /** Retries on 5xx and network errors. Default 2. */
  maxRetries?: number;
  /** Base for exponential retry backoff. Default 1000 ms. */
  retryBackoffMs?: number;
  /** Consecutive 429s from one host before the crawl aborts. Default 3. */
  maxConsecutiveThrottles?: number;
  /** Longest `Retry-After` we will actually wait out. Default 300 s. */
  maxRetryAfterMs?: number;
  /** User-Agent. Must stay honest and contactable; never impersonate a browser. */
  userAgent?: string;
}

export interface RequestOptions {
  /** Content-Type prefixes to accept. Anything else is recorded as a skip, body undrained. */
  accept?: readonly string[];
  /** Extra request headers — `If-None-Match` / `If-Modified-Since` on a re-crawl. */
  headers?: Record<string, string>;
  /** Value for the `Accept` request header. */
  acceptHeader?: string;
}

export interface RedirectHop {
  url: string;
  status: number;
  location: string;
}

export type FetchErrorKind =
  | 'timeout'
  | 'network'
  | 'too-many-redirects'
  | 'bad-redirect'
  | 'body-too-large'
  | 'content-type-rejected';

/**
 * One request, fully described — including the ways it went wrong.
 *
 * Nothing here is dropped silently. A sitemap entry that 404s or redirects is a
 * finding in its own right, so the record has to survive as far as the report.
 */
export interface FetchRecord {
  requestedUrl: string;
  finalUrl: string;
  status: number | null;
  contentType: string | null;
  headers: Record<string, string>;
  redirectChain: RedirectHop[];
  bytes: number;
  elapsedMs: number;
  attempts: number;
  /** Present only when the response was 2xx and the body was accepted and read. */
  body: Buffer | null;
  /** Why we have no body despite no hard error: non-2xx, wrong type, too large. */
  notFetchedReason: string | null;
  error: { kind: FetchErrorKind; message: string } | null;
}

/** Thrown when a host has told us to go away often enough that we should stop entirely. */
export class CrawlAbortedError extends Error {
  readonly host: string;

  constructor(host: string, reason: string) {
    super(`crawl aborted for ${host}: ${reason}`);
    this.name = 'CrawlAbortedError';
    this.host = host;
  }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Parse `Retry-After`, which is either delta-seconds or an HTTP-date.
 * Returns null when absent or unintelligible.
 */
export function parseRetryAfter(value: string | null, now: number = Date.now()): number | null {
  if (value === null) return null;

  const trimmed = value.trim();
  if (trimmed === '') return null;

  if (/^\d+$/.test(trimmed)) return Number.parseInt(trimmed, 10) * 1000;

  const asDate = Date.parse(trimmed);
  if (Number.isNaN(asDate)) return null;

  return Math.max(0, asDate - now);
}

interface HostState {
  /** Tail of the serial promise chain — enforces one request in flight per host. */
  chain: Promise<unknown>;
  /** When the last request to this host finished, for delay accounting. */
  lastFinishedAt: number;
  /** Host-specific delay, raised by robots.txt `Crawl-delay`. Never lowered. */
  delayMs: number;
  consecutiveThrottles: number;
}

export class PoliteFetcher {
  private readonly delayMs: number;
  private readonly timeoutMs: number;
  private readonly maxRedirects: number;
  private readonly maxBodyBytes: number;
  private readonly maxRetries: number;
  private readonly retryBackoffMs: number;
  private readonly maxConsecutiveThrottles: number;
  private readonly maxRetryAfterMs: number;
  private readonly userAgent: string;

  private readonly hosts = new Map<string, HostState>();

  constructor(options: FetcherOptions = {}) {
    this.delayMs = Math.max(MIN_DELAY_MS, options.delayMs ?? 1000);
    this.timeoutMs = options.timeoutMs ?? 20_000;
    this.maxRedirects = options.maxRedirects ?? 5;
    this.maxBodyBytes = options.maxBodyBytes ?? 10 * 1024 * 1024;
    this.maxRetries = options.maxRetries ?? 2;
    this.retryBackoffMs = options.retryBackoffMs ?? 1000;
    this.maxConsecutiveThrottles = options.maxConsecutiveThrottles ?? 3;
    this.maxRetryAfterMs = options.maxRetryAfterMs ?? 300_000;
    this.userAgent = options.userAgent ?? USER_AGENT;
  }

  private stateFor(host: string): HostState {
    let state = this.hosts.get(host);
    if (state === undefined) {
      state = {
        chain: Promise.resolve(),
        lastFinishedAt: 0,
        delayMs: this.delayMs,
        consecutiveThrottles: 0,
      };
      this.hosts.set(host, state);
    }
    return state;
  }

  /**
   * Raise the delay for a host, typically from robots.txt `Crawl-delay`.
   * Honoured only when it is longer than ours — never shortened by it.
   */
  setHostDelay(host: string, delayMs: number): void {
    const state = this.stateFor(host);
    state.delayMs = Math.max(state.delayMs, delayMs);
  }

  hostDelay(host: string): number {
    return this.stateFor(host).delayMs;
  }

  /**
   * GET a URL politely. Never throws for HTTP or network failure — those are
   * recorded in the returned {@link FetchRecord}. The one exception is
   * {@link CrawlAbortedError}, which means the host wants us gone.
   */
  async fetch(url: string, options: RequestOptions = {}): Promise<FetchRecord> {
    const host = hostKey(url);
    const state = this.stateFor(host);

    // Append to this host's serial chain: one request in flight per host, and
    // the delay is measured from the previous request *finishing*, not starting,
    // so a slow response never compresses the gap to the next one.
    const run = async (): Promise<FetchRecord> => {
      const sinceLast = Date.now() - state.lastFinishedAt;
      const waitFor = state.delayMs - sinceLast;
      if (state.lastFinishedAt !== 0 && waitFor > 0) await sleep(waitFor);

      try {
        return await this.attemptWithRetries(url, host, state, options);
      } finally {
        state.lastFinishedAt = Date.now();
      }
    };

    const queued = state.chain.then(run, run);
    // Swallow rejection on the stored tail only; the caller still sees it.
    state.chain = queued.catch(() => undefined);
    return queued;
  }

  private async attemptWithRetries(
    url: string,
    host: string,
    state: HostState,
    options: RequestOptions,
  ): Promise<FetchRecord> {
    const startedAt = Date.now();
    let attempts = 0;
    let retriesUsed = 0;

    // Two independent budgets. `retriesUsed` covers 5xx and network failure and
    // is capped at maxRetries. A 429 spends neither — it is not a failure, it is
    // the host setting the pace — and is bounded instead by the consecutive
    // throttle count, which ends the crawl outright.
    for (;;) {
      attempts += 1;
      const record = await this.attemptOnce(url, options);
      record.attempts = attempts;
      record.elapsedMs = Date.now() - startedAt;

      // 429 is the host explicitly asking us to slow down. It does not consume
      // a retry budget; it consumes patience, and three in a row ends the crawl.
      if (record.status === 429) {
        state.consecutiveThrottles += 1;
        if (state.consecutiveThrottles >= this.maxConsecutiveThrottles) {
          throw new CrawlAbortedError(host, `${state.consecutiveThrottles} consecutive 429 responses`);
        }

        const retryAfter = parseRetryAfter(record.headers['retry-after'] ?? null);
        if (retryAfter !== null && retryAfter > this.maxRetryAfterMs) {
          throw new CrawlAbortedError(
            host,
            `Retry-After of ${Math.round(retryAfter / 1000)}s exceeds the ${Math.round(this.maxRetryAfterMs / 1000)}s we are willing to wait`,
          );
        }

        // Back off hard: whatever they asked for, or a doubling of our delay.
        const backoff = retryAfter ?? state.delayMs * 2 ** (state.consecutiveThrottles + 1);
        // Raise the standing delay too — one 429 means the current pace is wrong.
        state.delayMs = Math.min(this.maxRetryAfterMs, state.delayMs * 2);
        await sleep(backoff);
        continue;
      }

      // Anything that is not a 429 breaks the consecutive run.
      state.consecutiveThrottles = 0;

      const isRetryable =
        record.error?.kind === 'timeout' ||
        record.error?.kind === 'network' ||
        (record.status !== null && record.status >= 500);

      if (!isRetryable || retriesUsed >= this.maxRetries) return record;

      const retryAfter = record.status === 503 ? parseRetryAfter(record.headers['retry-after'] ?? null) : null;
      await sleep(retryAfter ?? this.retryBackoffMs * 2 ** retriesUsed);
      retriesUsed += 1;
    }
  }

  private async attemptOnce(url: string, options: RequestOptions): Promise<FetchRecord> {
    const accept = options.accept ?? ['text/html', 'application/xhtml+xml'];
    const redirectChain: RedirectHop[] = [];
    let currentUrl = url;

    const record: FetchRecord = {
      requestedUrl: url,
      finalUrl: url,
      status: null,
      contentType: null,
      headers: {},
      redirectChain,
      bytes: 0,
      elapsedMs: 0,
      attempts: 0,
      body: null,
      notFetchedReason: null,
      error: null,
    };

    for (let hop = 0; hop <= this.maxRedirects; hop += 1) {
      let response: Response;
      try {
        response = await fetch(currentUrl, {
          method: 'GET',
          // Manual, so the full chain is recorded rather than silently followed.
          // The chain is diagnostic: a sitemap full of redirects is a finding.
          redirect: 'manual',
          signal: AbortSignal.timeout(this.timeoutMs),
          headers: {
            'user-agent': this.userAgent,
            accept: options.acceptHeader ?? 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.1',
            ...options.headers,
          },
        });
      } catch (error) {
        const isTimeout = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
        record.finalUrl = currentUrl;
        record.error = {
          kind: isTimeout ? 'timeout' : 'network',
          message: error instanceof Error ? error.message : String(error),
        };
        return record;
      }

      record.finalUrl = currentUrl;
      record.status = response.status;
      record.headers = Object.fromEntries(response.headers);
      record.contentType = response.headers.get('content-type');

      const location = response.headers.get('location');
      if (response.status >= 300 && response.status < 400 && location !== null) {
        await response.body?.cancel();

        let resolved: string;
        try {
          resolved = new URL(location, currentUrl).toString();
        } catch {
          record.error = { kind: 'bad-redirect', message: `unparseable Location: ${location}` };
          return record;
        }

        redirectChain.push({ url: currentUrl, status: response.status, location: resolved });
        currentUrl = resolved;
        continue;
      }

      if (response.status < 200 || response.status >= 300) {
        await response.body?.cancel();
        record.notFetchedReason = `http-${response.status}`;
        return record;
      }

      // Check the type before draining: no point pulling 8 MB of PDF over the
      // wire to discover we were never going to parse it.
      const bareType = (record.contentType ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
      if (accept.length > 0 && !accept.some((prefix) => bareType === prefix.toLowerCase())) {
        await response.body?.cancel();
        record.notFetchedReason = `content-type-rejected:${bareType || 'unknown'}`;
        record.error = { kind: 'content-type-rejected', message: `refusing ${bareType || 'unknown content-type'}` };
        return record;
      }

      const drained = await this.drainCapped(response);
      if (drained === null) {
        record.notFetchedReason = `body-too-large:>${this.maxBodyBytes}`;
        record.error = { kind: 'body-too-large', message: `body exceeded ${this.maxBodyBytes} bytes` };
        return record;
      }

      record.body = drained;
      record.bytes = drained.byteLength;
      return record;
    }

    record.error = {
      kind: 'too-many-redirects',
      message: `exceeded ${this.maxRedirects} redirects`,
    };
    return record;
  }

  /** Read the body, giving up the moment it exceeds the cap. Returns null if it did. */
  private async drainCapped(response: Response): Promise<Buffer | null> {
    if (response.body === null) return Buffer.alloc(0);

    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;

    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value === undefined) continue;

        total += value.byteLength;
        if (total > this.maxBodyBytes) {
          await reader.cancel();
          return null;
        }
        chunks.push(value);
      }
    } catch {
      await reader.cancel().catch(() => undefined);
      throw new Error('body read failed');
    }

    return Buffer.concat(chunks);
  }
}
