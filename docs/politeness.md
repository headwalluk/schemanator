# Politeness

This tool fetches other people's websites. Every default errs slow.

A structured-data auditor that gets your IP range flagged as abusive is worse
than no auditor at all, so the defaults are set for the site being crawled
rather than for your convenience.

## What it does by default

| | |
| --- | --- |
| Requests in flight | **One per host.** Not one per crawl — one per host |
| Crawls in flight | **One**, across the whole work directory |
| Delay between requests | **1000 ms**, measured from the previous request *finishing* |
| Minimum delay | **200 ms**, even if you ask for less |
| `robots.txt` | Fully obeyed, including `Disallow` and `Crawl-delay` |
| Maximum pages | 100 |
| Maximum linked pages | 50, on top of the page cap |
| Timeout | 20 s |
| Retries | 2, on 5xx and network errors only |
| Redirects | Followed to 5, and the full chain is recorded |
| Response size | Capped at 10 MB |

A default 100-page crawl therefore takes under two minutes, a raised cap of 500
takes nine, and there is no option to make either dramatically faster. That is
the point.

### The one hop out of the sitemap

Since 1.13.0 the crawl also follows internal links that lead **off** the
sitemap — a section index, a tag archive, page 2 of a listing — and stops there.
It never follows their links in turn; that would be a general web crawler, which
is a different tool with a different argument to make.

This is the only thing here that adds requests, so it is worth being plain about
the cost — and about the fact that it grows faster than you would expect. A
54-page site turned up 21 unlisted URLs. A 564-page shop turned up **832**,
because it generates `/product-tag/` and `/brand/` archives in bulk and lists
none of them in a sitemap.

It is capped separately at 50 rather than sharing `--max-pages`, so the worst
case is bounded and additive rather than a surprise. **The default deliberately
will not close the link graph on a large site.** The alternative is a tool that
quietly makes several hundred extra requests to somebody's server because a
check wanted them; instead the crawl prints the number that would close it and
leaves the decision with you.

`robots.txt` governs it exactly as it governs everything else — two of those 21
were `Disallow`ed and were not fetched.

`--no-link-hop` turns it off. The cost is that the
[`link`](checks.md#link--the-sitemap-and-the-link-graph-disagree) checks then
report nothing at all, because without those pages the crawl cannot tell a page
nothing links to from a page whose only link sits somewhere it never looked.

### Why only one crawl at a time

"One request in flight per host" is enforced by a queue that lives **inside a
single process**. Two schemanator processes have two queues and know nothing of
each other, so each politely waits its turn while between them putting two
requests in flight at once.

Running two crawls therefore doubles the load and defeats the guarantee above,
even though every individual crawl still looks well-behaved. Starting a second
one exits 4 and starts nothing.

**"A different site" is not the same as "a different server."** Sites commonly
share hosting — an agency or host will have many clients on one machine or one
network — and this tool has no way to know from the outside which of your
targets are neighbours. So the default assumes they might be.

`--allow-concurrent` opts out. It is a statement that you know the targets are
on unrelated infrastructure, and the consequences of being wrong land on
somebody else's server rather than yours.

## What it never does

- **`GET` only.** No `POST`, no forms, no login, no authenticated crawling.
- **HTML only.** Anything else is skipped by `Content-Type` without downloading
  the body — and when the crawl is following links rather than a sitemap, a URL
  that ends `.png`, `.pdf` or similar is not requested at all. A sitemap entry
  still is: the site asked for that URL to be indexed, so what it returns is
  worth knowing.
- **No JavaScript.** No headless browser. See [the limitation](#what-it-cannot-see).
- **No off-site media.** Images on other hosts are reported but never fetched.
- **No vocabulary fetching.** schema.org is bundled. A 100-page crawl would
  otherwise mean 100 requests to schema.org for a file that changes a few times
  a year.

## Identify yourself

The `User-Agent` is honest and contactable, and never impersonates a browser:

```
schemanator/<version> (+https://your-site.example/contact)
```

Run `schemanator --version` to see which version that is.

**Set `SCHEMANATOR_CONTACT` before crawling anything you do not own.** Someone
seeing you in their logs needs a way to work out who you are and how to ask you
to stop. Without it the URL points at the project, which is worse than useless
for a site owner trying to reach *you*.

```sh
export SCHEMANATOR_CONTACT=https://your-site.example/contact
```

If a site blocks us, that is the site's right.

## robots.txt

Fetched first, before anything else, and from the **final host after
redirects** — if `example.com` redirects to `www.example.com`, `www`'s rules
govern.

The failure behaviour is deliberately asymmetric:

| Response | What happens |
| --- | --- |
| **2xx** | Rules obeyed |
| **4xx** | The file genuinely is not there. No restrictions. Crawl |
| **5xx, timeout, refused** | **Refuse to crawl.** Exit code 3 |

That last row is the one people find surprising. The intuitive reading of an
unreachable `robots.txt` is "no rules, crawl freely" — it is backwards. A `503`
on `robots.txt` is usually a WAF, a rate limiter, or an overloaded server, which
is precisely the moment to back off. This follows RFC 9309.

`Crawl-delay` is honoured when it is **longer** than ours, and never used to
shorten it.

## Backing off

- **`429` or `503` with `Retry-After`:** the value is honoured, and the standing
  delay for that host is doubled. One `429` means the current pace was wrong.
- **Three consecutive `429`s:** the crawl aborts with exit code 2.
- **A `Retry-After` longer than five minutes:** aborts rather than sleeping. If a
  site wants a twenty-minute pause, come back later.

## Reducing the load further

```sh
# Slower
schemanator example.com --delay 5000

# Fewer pages, still representative across content types
schemanator example.com --max-pages 50

# Just the list, no page fetches at all
schemanator example.com --dry-run
```

**Re-analysis is free.** The crawl is the expensive, impolite part; analysis
reads stored HTML:

```sh
schemanator analyse example.com
```

Change configuration, disable a check, or take a fresh report from an old crawl
without touching the site again. When iterating, crawl once and analyse many
times.

## Resuming rather than restarting

Queue state is written after every fetch:

```sh
schemanator example.com --resume
```

Pages already stored are not re-fetched. Restarting a 90-minute crawl from zero
is not just slow, it is rude to the site.

## What it cannot see

**Structured data injected by JavaScript is invisible.** Tag manager containers,
review widgets, some booking platforms. This is a raw HTML fetch.

That matters because a report saying *"no `Product` schema found"* would be
actively wrong on a site that injects `Product` client-side. If your structured
data is added by JavaScript, schemanator will not see it and the report should
be read with that in mind.

## Crawling sites you do not own

The tool cannot verify that you have permission, and does not try. That
judgement is yours.

If you are auditing a fleet, the least intrusive approach is: `--dry-run` first
to confirm seeding, then a capped crawl with `--max-pages`, then re-analyse as
often as you like without re-crawling.
