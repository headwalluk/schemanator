# Usage

## Commands

```sh
schemanator <site> [options]           # crawl, extract, check, report
schemanator crawl <site> [options]     # crawl only, no analysis
schemanator analyse <site> [options]   # re-analyse a stored crawl, no network
schemanator sites                      # what has been crawled, and what it costs
schemanator purge <site> [--html]      # reclaim disk
schemanator status [site]              # progress of a running or finished crawl
```

`<site>` may be a bare hostname. `example.com` is read as `https://example.com`.

**Logs go to stderr; the report goes to stdout.** So this works:

```sh
schemanator example.com > report.md
schemanator example.com | less
schemanator example.com --json | jq '.findings[] | select(.severity == "error")'
schemanator example.com --format html > report.html
```

## Output formats

`--format` picks what goes to **stdout**. All three files are written to the run
directory regardless, so the artefacts exist however the command was invoked —
you can email the HTML later without re-running anything.

| Format | For |
| --- | --- |
| `md` *(default)* | Terminal reading, and handing to a coding agent. Pipes cleanly |
| `json` | The contract. Scripting, CI gates, fleet aggregation |
| `html` | Sharing and archiving. One self-contained file |

`--json` is kept as an alias for `--format json`, so existing scripts keep
working.

### The HTML report

One file, and deliberately so: inline CSS, no stylesheet, no webfont, no image,
**no JavaScript**, and no network request of any kind. It survives being emailed,
attached to a ticket, or opened from an archive in five years — all cases where a
fetch either fails or quietly reports that the file was opened.

It follows the reader's light or dark theme, and has print rules, because these
get turned into PDFs and attached to tickets. Severity is shown as a word as well
as a colour, so nothing is lost on a mono printer.

```sh
schemanator example.com --format html > audit.html
```

The diff (`--since`) has no HTML renderer yet. Asking for one prints markdown and
says so rather than silently emitting the wrong document.

## Start with a dry run

```sh
schemanator example.com --dry-run
```

Fetches `robots.txt` and the sitemaps, prints the URL list, and fetches no
pages. Four requests or so. It is the cheapest way to find out whether seeding
worked before committing to a real crawl, and it catches the common surprises:
a sitemap that redirects, entries on a different host, a site with no sitemap at
all.

Combine with `--quiet` for a clean list:

```sh
schemanator example.com --dry-run --quiet > urls.txt
```

## A full scan

```sh
schemanator example.com
```

Crawls at **one request per second** by default and stops at 500 pages. A
47-page site takes about a minute; 500 pages takes nine. Progress appears per
page on stderr.

### Large sites

```sh
schemanator example.com --max-pages 150
```

When the cap bites, **which** pages you get matters more than how many. A large
site usually partitions its sitemap index by content type — several thousand
posts, a hundred pages, a few thousand tags. Taking the first 150 in document
order gives you 150 blog posts and never reaches the page sitemap, which is
where `Organization`, `LocalBusiness` and the contact details live.

So the default is `--sample spread`: round-robin across the source sitemaps, so
every content type is represented. Use `--sample document` if you specifically
want the first N in order.

The report states what the sample covered, and findings that assert something is
**absent** are marked as qualified by coverage.

### The crawl warns when the sample gets thin

Below half the discovered URLs, the crawl says so:

```
capped at --max-pages=200 (--sample spread); 2800 of 3000 URL(s) not queued
WARN  sampling 200 of 3000 URL(s) (7%) — checks that compare pages against each
      other, such as duplicate-content, can miss a pair when only one half was
      crawled, and will report nothing rather than a maybe
```

**That is a different problem from ordinary partial coverage.** A finding that
asserts something is *absent* is already marked as qualified by coverage. But a
check comparing pages against each other produces a **false negative that reads
as a pass** — crawl one URL of a duplicate pair, never see the other, and the
report is silent rather than uncertain.

Raise `--max-pages` when you need a conclusive answer on those.

## Re-analysing without re-crawling

```sh
schemanator analyse example.com
```

Reads the stored HTML and runs extraction and the checks again. No network, and
it takes seconds rather than minutes. Useful when you have changed
[configuration](configuration.md), disabled a check, or want a fresh report from
an old crawl.

## The fix-and-verify workflow

The loop this tool is built around:

```sh
# 1. Audit
schemanator example.com > report.md

# 2. Fix. Hand report.md to whoever — or whatever — is doing the fixing.
#    It carries exact page URLs and JSON pointers for every finding.

# 3. Verify
schemanator example.com --since last
```

`--since` compares the two runs and prints a diff instead of a report:

```
| Resolved      | 1 |
| New           | 0 |
| Changed       | 0 |
| Unchanged     | 5 |
| Pages audited | 47 → 47 |
```

Findings are matched by a stable id that names **the question asked, not the
answer**. So a contradiction you fixed on 95 of 100 pages appears under
**Changed** — one finding, improving — rather than as one resolved plus one new.

`--since` also takes an explicit run id:

```sh
schemanator analyse example.com --since 20260801T191624Z
```

Run ids are the directory names under `<work-dir>/<site>/reports/`.

### It will tell you when the comparison is unsound

If the second run audited materially fewer pages than the first, findings can
appear resolved simply because the evidence was not looked at. The diff detects
that and leads with a warning:

> ⚠ **Coverage changed between runs.** The later run audited 20 pages against 78
> before — 74% fewer. Findings may appear resolved simply because the evidence
> was not looked at.

Keep `--max-pages` the same across runs you intend to compare.

## Options

| Option | Effect |
| --- | --- |
| `--dry-run` | Print the URL list, fetch no pages |
| `--max-pages <n>` | Cap the crawl. Default 500 |
| `--sample spread\|document` | Which URLs survive the cap. Default `spread` |
| `--sitemap <url>` | Use this sitemap. Repeatable. Overrides discovery entirely |
| `--max-depth <n>` | Sitemap index recursion depth. Default 3 |
| `--delay <ms>` | Delay between requests to one host. Default 1000, floor 200 |
| `--resume` | Continue an interrupted crawl rather than starting over |
| `--detach` | Crawl in the background and return at once. Poll with `status` |
| `--allow-concurrent` | Permit a crawl while one runs for a *different* site |
| `--force` | Take a lock whose owning process cannot be checked from here |
| `--work-dir <path>` | Where output goes |
| `--site <slug>` | Site key under the work directory. Default: the hostname |
| `--disable <check>` | Disable a check or a whole group. Repeatable |
| `--since <run-id>` | Diff against an earlier run. `last` for the most recent |
| `--format <fmt>` | `md` (default), `json` or `html`. Picks what goes to stdout |
| `--json` | Alias for `--format json` |
| `--no-sort-query` | Do not sort query parameters when canonicalising |
| `--log-level <level>` | `silent`, `error`, `warn`, `info`, `debug`. Default `info` |
| `--quiet` / `--verbose` | Aliases for `--log-level error` / `debug` |
| `--html` | `purge` only: remove stored HTML, keep reports and nodes |
| `--yes` | `purge` only: actually delete. Without it, `purge` is a dry run |
| `--help` | Show usage |
| `--version` | Print the version and exit. One bare line, so it parses |

## Housekeeping

Crawls accumulate. Stored HTML runs to roughly 250 KB a page, so twenty sites is
comfortably half a gigabyte, and after a few months nobody remembers which
directories are still wanted.

### What is here

```sh
schemanator sites
```

```
SITE                       PAGES    SIZE    HTML    RUNS  CRAWLED
example.com                149/150  81 MB   76 MB   11    2026-08-01
shop.example               150/150  64 MB   57 MB   12    2026-08-01
small.example              5/5      575 KB  389 KB  8     2026-07-28

3 site(s), 146 MB total, 133 MB of it reclaimable stored HTML
```

Largest first, because the question this usually answers is *"what is eating my
disk"*. `PAGES` is 200-responses over total fetched; `HTML` is the part you can
reclaim without losing your audit history, and reads `purged` once you have.

`--json` for scripting.

### What extraction leaves behind

Beside the stored HTML, each crawled page gets a small set of derived artefacts.
You never need to touch them, but they are plain text and occasionally the
fastest way to answer a question:

| Path | What it is |
| --- | --- |
| `pages/<page-id>/page.html` | The response, verbatim. The bulk of the disk |
| `pages/<page-id>/content.md` | The page with site chrome removed, as markdown |
| `pages/<page-id>/raw/ld-NN.json` | Each JSON-LD block exactly as it was published |
| `graph/nodes.jsonl` | Every extracted node. What the checks read |
| `graph/links.jsonl` | One row per link, with `in_chrome` marking navigation |
| `pages.jsonl` | The manifest — identity, crawl outcome, and `page_facts` |

**`content.md` is the interesting one.** It is what a machine reading your page
actually gets, so it pairs well with the report: *here is the finding, and here
is what a consumer sees.* Chrome is removed both by declaration — anything in
`<nav>`, `<header>` or `<footer>` — and by measurement, since a block of text
appearing on 80% or more of your pages is site furniture.

`page_facts` on each manifest row carries the per-page measurements the `page`
and `content` checks read: title, heading levels, robots directives, `hreflang`,
image and alt counts, word counts, and a content fingerprint. Older crawls have
it as `null`; re-running `analyse` fills it in, provided the HTML is still there.

### Reclaiming space

```sh
schemanator purge example.com --html      # stored pages only
schemanator purge example.com             # the whole site
```

**Both print what they would remove and delete nothing.** Add `--yes` to go
ahead.

That is not generic caution. A crawl costs an hour of somebody else's bandwidth,
one polite request at a time — so deleting one by accident is not merely your
inconvenience, it means going back and taking it again.

| | Keeps | Loses |
| --- | --- | --- |
| `--html` | Reports, extracted nodes, the manifest | Re-analysis, until you re-crawl |
| *(no flag)* | Nothing | Everything for that site |

`--html` also sets `html_purged` in the manifest. Deleting the files by hand
works but leaves `pages.jsonl` claiming the HTML is still there.

## Crawling in the background

A 500-page crawl takes about nine minutes, which is longer than most agent shell
tools will wait. `--detach` starts one and returns immediately:

```sh
schemanator crawl example.com --detach
schemanator status example.com --json     # poll until state is not "crawling"
schemanator analyse example.com
```

Output goes to `crawl/detached.log` under the run directory rather than being
discarded, so a crawl that fails has somewhere to say why.

### What to poll

**Use `--json`. The plain-text output is for people and is not a contract** —
its wording and layout change without notice. The JSON carries `status_schema`,
an integer that bumps on any breaking change, exactly as `report_schema` does.

```json
{
  "work_dir": "/home/you/.local/state/schemanator",
  "statuses": [
    {
      "status_schema": 1,
      "site_slug": "example.com",
      "state": "crawling",
      "running": true,
      "pages_fetched": 187,
      "pages_total": 500,
      "heartbeat_age_ms": 1200,
      "detached": true,
      "log_path": "…/example.com/crawl/detached.log",
      "error": null
    }
  ]
}
```

**Poll `running`, not `state`.** They differ in the case that matters: a crawl
whose process was killed keeps `state: "crawling"` — that is what it was doing
when it stopped — while `running` becomes `false`. Something waiting on `state`
alone waits forever. `running` applies the liveness rules for you, so you never
have to reason about pids.

`state` is `crawling`, `finished` or `failed`; `error` says why on `failed`. An
unknown site returns an empty `statuses` array rather than an error, so "not
started yet" is distinguishable from "the call broke".

### Only one crawl runs at a time

A second crawl — of any site, detached or not — exits **4** and starts nothing:

```
A crawl of another site is already running, and only one runs at a time.

  example.com (pid 40122, running 3m 12s, 187 of 500 pages)
  status: schemanator status example.com
```

That limit is politeness rather than bookkeeping. The polite queue governs a
single process, so two crawls put two requests in flight at once — and sites
frequently share hosting, so "different site" does not mean "different server".
`--allow-concurrent` opts out when you know the targets are unrelated. It never
relaxes the same-site lock, which exists to stop two processes writing one
manifest.

`analyse`, `status` and `sites` only read, and are never blocked. Analysing one
site while another crawls is fine. `purge` is blocked for the site being
crawled, and `--yes` does not override it.

## Interrupted crawls

A crawl records its queue state after every fetch, so it survives being killed:

```sh
schemanator example.com --resume
```

Pages already stored are not re-fetched. Without `--resume`, a fresh run starts
from scratch and discards the previous crawl for that site.

If a crawl was killed, `status` shows it as **stalled** rather than crawling —
the process is gone, and the next crawl reclaims the lock automatically and says
so. A crawl merely *blocked* on a slow response is still alive and keeps its
lock, however quiet it looks; only a process that can be proved gone releases
one. A lock taken on a different machine cannot be checked from here at all, so
it holds until `--force`.

## Sitemaps

Discovery order:

1. `--sitemap` values, if you gave any. These **suppress** everything below —
   you crawl exactly what you named.
2. `Sitemap:` directives in `robots.txt`.
3. Only if `robots.txt` declares none, the well-known paths (`/sitemap.xml`,
   `/sitemap_index.xml`, `/wp-sitemap.xml`, and a couple more).

If nothing turns up, the front page alone is crawled and the report says so.

Sitemap indexes are followed, `.xml.gz` is handled, and plain-text, RSS and Atom
sitemaps all work. Entries on a different host are dropped and recorded —
cross-submission is legal but following it would turn a one-site audit into an
open crawl. A `www`/bare variant of your own host is **not** treated as foreign,
though the disagreement is recorded.

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | Completed. Findings do not affect the exit code |
| `1` | Bad arguments, or an unexpected error |
| `2` | The crawl was aborted — usually repeated `429 Too Many Requests` |
| `3` | `robots.txt` was unreadable, so the crawl was refused |
| `4` | A crawl is already running. Nothing was started or removed — wait and retry |

Findings deliberately do not fail the command. If you want CI to fail on errors,
read the JSON:

```sh
schemanator example.com --json | jq -e '(.summary.by_severity.error // 0) == 0'
```

**Keep those parentheses.** `//` binds looser than `==` in jq, so
`.error // 0 == 0` parses as `.error // (0 == 0)` — always truthy, and a CI gate
that can never fail.
