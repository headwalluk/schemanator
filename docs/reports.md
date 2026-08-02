# Understanding the report

Every run writes a timestamped directory:

```
<work-dir>/<site>/reports/<run-id>/
    report.json     the contract
    report.md       generated from it
    report.html     generated from it — one self-contained file
    diff.json       only when --since was used
    diff.md         only when --since was used
```

All three report files are written on every run, whatever `--format` you asked
for. That flag only picks what goes to stdout.

`report.json` is the primary artefact. The markdown is a rendering of it, and so
is anything you build — an email, a dashboard, a spreadsheet. If a renderer
needs something the JSON lacks, the JSON is wrong.

## Reading the markdown

### Coverage first

If the crawl did not cover the whole site, the report says so before anything
else:

> ⚠ **Partial coverage.** 150 of 8,341 discovered URLs were audited
> (`--sample spread`). Findings that assert something is ABSENT are qualified:
> it may exist on a page not fetched.

This is the single most misleading thing about a partial report, which is why it
leads. *"No `LocalBusiness` found"* is a different statement depending on
whether you looked at 150 pages or 8,341.

### Summary

```
| Pages fetched     | 47 of 47 discovered |
| Nodes extracted   | 766 |
| Distinct entities | 198 |
| JSON-LD blocks    | 60 |
| Findings          | 1 — 0 error, 0 warning, 1 opportunity |
```

**Considered and not reported** follows, listing what was examined and
deliberately silenced. `entity.partiality — 11 instances` means the tool looked
at eleven cases of a property being present on some pages and absent on others,
and decided none was worth your time. Silence you can audit.

### Findings

Grouped by severity, errors first. Each one carries:

- **Check and severity** — the check id is stable, so you can `--disable` it or
  grep for it
- **Subject** — the entity, page, or site the finding is about
- **Finding id** — stable across runs; this is what makes `--since` work
- **Summary** — what is wrong and why it matters
- **Expected** — what a correct value would look like, not just what is wrong
- **Observed** — each distinct value, how many pages carry it, and where
- **Suggested fix**
- **Trade-off**, where the tool genuinely cannot decide for you

### Provenance

Every observed value carries up to three examples:

```
- https://example.com/about/ — on 120 page(s)
    json-ld block 0, pointer /5
```

That reads as: page `/about/`, the first `<script type="application/ld+json">`
block on it, node index 5 in the expanded document. The verbatim block is on
disk at `<work-dir>/<site>/pages/<page-id>/raw/ld-00.json`.

**Capped at three per value on purpose.** A finding spanning 8,000 pages would
otherwise be unreadable, and impossible to paste anywhere. The page count is
recorded alongside so the cap is visibly a sample. The full list is in
`pages.jsonl`.

## The JSON contract

```jsonc
{
  "schemanator": { "version": "1.0.0", "report_schema": 1 },
  "run":      { "run_id": "…", "site_origin": "…", "started_at": "…", "finished_at": "…" },
  "coverage": { "complete": false, "urls_discovered": 8341, "urls_queued": 150,
                "pages_fetched": 150, "pages_extracted": 150,
                "truncated": { "limit": 150, "dropped": 8191 },
                "sample_strategy": "spread", "caveat": "…" },
  "graph":    { "nodes": 761, "entities": 279, "pages_with_data": 150,
                "json_ld_blocks": 60, "malformed_blocks": 0 },
  "summary":  { "by_severity": {…}, "by_check": {…}, "silenced": {…},
                "checks_run": […], "checks_disabled": […] },
  "findings": [ … ]
}
```

Note `urls_discovered` and `pages_fetched` are different numbers whenever a cap
bit, and `coverage.complete` means *"everything discovered was fetched"* — not
*"every URL on the site was seen"*. A sitemap-driven crawl never discovers pages
the sitemap omits.

**Pin against `report_schema`.** It is an integer and bumps on any breaking
change.

### A finding

```jsonc
{
  "finding_id": "c6973275af89",
  "check": "entity.contradiction",
  "severity": "error",
  "origin": "check",
  "title": "url has 2 different values under one @id",
  "subject": { "kind": "entity", "id": "https://example.com/#organization",
               "property": "http://schema.org/url" },
  "summary": "…",
  "expected": "One url value across all observations of this @id.",
  "observed": [
    { "value": "…", "observation_count": 120, "page_count": 120,
      "provenance": [ { "page_id": "…", "url": "…", "syntax": "json-ld",
                        "block": 0, "pointer": "/5" } ] }
  ],
  "pages_affected": 150,
  "coverage_qualified": false,
  "remediation": "…",
  "tradeoff": null
}
```

`origin` is always `"check"`. It exists so that a future analysis pass — ours or
anyone's — could add findings without breaking the schema.

Aggregated findings carry `instance_count`: several subjects with one root cause
are reported once, because one generator behaviour deserves one fix rather than
twenty-eight edits.

### Useful queries

```sh
# Errors only
schemanator example.com --json | jq '.findings[] | select(.severity=="error")'

# Every page touched by a given finding
jq -r '.findings[] | select(.finding_id=="c6973275af89") |
       .observed[].provenance[].url' report.json

# Fail CI on any error
schemanator example.com --json | jq -e '(.summary.by_severity.error // 0) == 0'
```

## Comparing runs

```sh
schemanator example.com --since last
```

Prints a diff instead of a report, in four buckets:

| Bucket | Means |
| --- | --- |
| **Resolved** | The question is no longer being asked |
| **New** | A question that was not asked before |
| **Changed** | Same question, different evidence |
| **Unchanged** | Same question, same evidence |

The last one is headed `Unchanged` in the summary table and `Still open` where
its findings are listed — the same bucket, named for the count in one place and
for what it means to you in the other.

**Changed** is why finding ids name the *question* rather than the answer. A
contradiction fixed on 95 of 100 pages is one improving finding — not one
resolved plus one new, which would report progress and regression at once for a
single improvement.

Comparison ignores wording, so rewording a summary never looks like movement on
your site.

### The coverage guard

If the second run audited materially fewer pages, findings can appear resolved
because the evidence was never looked at. The diff detects that and says so
before any count:

> ⚠ **Coverage changed between runs.** The later run audited 20 pages against 78
> before — 74% fewer.

Keep `--max-pages` consistent across runs you intend to compare.

## Handing the report to an agent

`report.md` is designed to be pasted somewhere or handed to a coding agent
alongside the code that generates your markup. It is plain markdown with no
colour or box drawing, so it survives a chat window.

Two things make it work for that:

**It states the expected value.** *"These 120 pages say A, these 30 say B, one
value is expected"* is actionable in a way *"inconsistent url"* is not.

**It names trade-offs rather than inventing answers.** Where the tool cannot
decide — `entity.type-narrowing` is the live example — it says so explicitly, so
an agent does not confidently "fix" a deliberate decision.

One limit worth being explicit about: schemanator sees **HTML, not your source
code**. A finding points at a page, a block and a JSON pointer. It cannot point
at a line of a theme file, and it does not try to guess.
