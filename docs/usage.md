# Usage

## Commands

```sh
schemanator <site> [options]           # crawl, extract, check, report
schemanator crawl <site> [options]     # crawl only, no analysis
schemanator analyse <site> [options]   # re-analyse a stored crawl, no network
```

`<site>` may be a bare hostname. `example.com` is read as `https://example.com`.

**Logs go to stderr; the report goes to stdout.** So this works:

```sh
schemanator example.com > report.md
schemanator example.com | less
schemanator example.com --json | jq '.findings[] | select(.severity == "error")'
```

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
| `--work-dir <path>` | Where output goes |
| `--site <slug>` | Site key under the work directory. Default: the hostname |
| `--disable <check>` | Disable a check or a whole group. Repeatable |
| `--since <run-id>` | Diff against an earlier run. `last` for the most recent |
| `--json` | Emit JSON to stdout instead of markdown |
| `--no-sort-query` | Do not sort query parameters when canonicalising |
| `--log-level <level>` | `silent`, `error`, `warn`, `info`, `debug`. Default `info` |
| `--quiet` / `--verbose` | Aliases for `--log-level error` / `debug` |
| `--help` | Show usage |
| `--version` | Print the version and exit. One bare line, so it parses |

## Interrupted crawls

A crawl records its queue state after every fetch, so it survives being killed:

```sh
schemanator example.com --resume
```

Pages already stored are not re-fetched. Without `--resume`, a fresh run starts
from scratch and discards the previous crawl for that site.

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

Findings deliberately do not fail the command. If you want CI to fail on errors,
read the JSON:

```sh
schemanator example.com --json | jq -e '(.summary.by_severity.error // 0) == 0'
```

**Keep those parentheses.** `//` binds looser than `==` in jq, so
`.error // 0 == 0` parses as `.error // (0 == 0)` — always truthy, and a CI gate
that can never fail.
