# Changelog

Notable changes. Dates are the day the work landed, not a release date.

## 1.0.0 — 2026-08-02

The check catalogue is complete and the package is publishable.

### Added

- **The remaining 14 checks**, taking the catalogue from 13 to **27**.
  - **`breadcrumb`** — the whole group. Every `BreadcrumbList` on the site is
    assembled into one tree, then checked for cycles, conflicting parents,
    broken trail items, inconsistent depth and missing trails. Designed against
    a survey of 4,777 real `ListItem`s: a final crumb with no `item` is normal
    and is never reported.
  - **`syntax.malformed-json`** and **`syntax.unresolvable-context`** — surfacing
    faults extraction has always recorded but nothing reported. Malformed JSON
    and valid-JSON-that-will-not-expand are told apart, because they send you to
    different places.
  - **`entity.multi-value`**, **`graph.relative-id`**, **`graph.orphan-node`**,
    **`graph.blank-node-entity`**, **`url.trailing-slash-drift`**,
    **`coverage.type-gap`**, **`coverage.missing-expected-entity`**.
- **`value.placeholder` now catches unexecuted template code.** One corpus site
  publishes `<?php the_author(); ?>` as its author name on all 150 pages.
- **Publishable packaging.** `tsconfig.build.json` emitting to `dist/`,
  `prepublishOnly` running typecheck, tests and build, `bin` pointing at the
  built output. `engines` declares `>=22.0.0` — the consumer floor, not the
  22.18 a checkout needs — so the build serves the users it exists for.
- **Tests asserting what may and may not ship.** `dev-notes/` names real client
  sites; `data/` is required at runtime and omitting it would produce a package
  that installs cleanly and fails on first use. Both were one typo in a `files`
  array away.

### Fixed — four more false-positive classes, all found by the shakedown

None was visible from reading the code. That is now six across three sessions.

- **`graph.orphan-node` fired 1,480 times and was wrong every time.** The top
  types were `Article`, `NewsArticle`, `Product` and `Event` — page subjects,
  unreferenced precisely because they are what the page is about. Two further
  causes hid behind it: the reference set was built from `graph.referenced`,
  which excludes url-valued properties by design and so orphaned every
  `potentialAction.target`; and `BreadcrumbList`, which the catalogue explicitly
  calls a page-root type, escaped the type test entirely.
- **`breadcrumb.broken-trail-item` called four live pages non-existent.** Its
  specification said "non-200, *or absent from the crawl entirely*", and the
  second clause could not be supported: a sitemap-driven crawl never discovers
  section landing pages, and `coverage.complete` means "we fetched everything we
  found", not "we saw every URL". The variant is gone.
- **`coverage.type-gap` reported things like "1 of 25 pages carry no `Thing`".**
  Now restricted to types that say what a page is *about*, and a section's own
  index page is no longer treated as a member of the section.
- **`breadcrumb.inconsistent-depth` billed twice for one repeated crumb.**
  Suppressed where `cycle` or `multiple-parents` already explains it.

### Changed

- **`EntityGraph` gained `allNodes` and `referencedAnywhere`.** The node index is
  deduplicated by `@id`, which makes it the wrong thing to iterate — a named node
  repeated across 150 pages collapses to one entry. That cost a shakedown round
  on its own, and both fields are now documented next to the sets they are
  easily confused with.
- **The check framework moved out of `run.ts`** into `src/checks/framework.ts`,
  since four modules now need it.
- **The catalogue total was corrected from 23 to 27.** Arithmetic, not scope:
  13 built plus the 14 the tracker listed as outstanding is 27, and the total
  had simply never been re-added.
- **`syntax.unknown-vocabulary` was struck rather than built**, because building
  it would contradict the decision — taken the day before, on a measurement of
  zero non-schema.org vocabularies across 22 sites — that extraction retains
  everything and no check filters.
- **Design documents `01`–`06` are signed off**, and three claims they made that
  the code did not support are corrected rather than left standing: a
  `graph/entities.jsonl` that was never built, a `nodes.jsonl` example with the
  wrong value shape, and `--format html` / `schemanator report` described as
  shipping when neither exists.

### Known gaps

- **`--format html` and `schemanator report <site>` are not built.** Designed in
  `dev-notes/05`.
- **The configuration file is not read.** `configSearchPath()` exists and nothing
  calls it; `docs/configuration.md` says so plainly.
- **Seven checks have never fired on real markup** and are unit-tested only.
  Three of those are silent *because* a false-positive class was removed from
  them, which was the goal — but untriggered is not validated, and it is recorded
  in the tracker rather than glossed.

## 0.2.0 — 2026-08-01

The first version that does the whole job. Crawl → extract → check → report,
with cross-run diffing.

### Added

- **Extraction** (`dev-notes/03`). JSON-LD via `jsonld.expand`, with flattening
  done in-house so the JSON pointer survives and blank-node ids stay stable
  across runs. The schema.org context is vendored, so extracting a 500-page
  crawl makes zero requests to schema.org.
- **Check engine** — 13 checks across five groups, every one seeded from real
  markup rather than imagined problems.
- **`report.json` and a markdown renderer.** The JSON is the contract; markdown
  is a pure function over it. Logs go to stderr so the report pipes cleanly.
- **`--since` cross-run diffing.** Four buckets, including *Changed* for a
  partially-fixed finding, plus a guard that refuses to let a shrunken re-crawl
  masquerade as progress.
- **`schemanator analyse`** — re-run extraction and checks against stored HTML
  with no network, so a rule change can be evaluated against every site in
  seconds.
- **Two tunable data files**: the functional-property list, which decides what
  counts as a contradiction, and value heuristics for placeholders and media
  hosts.
- **The schema.org class hierarchy**, vendored and pruned by 98%, so type
  refinement can be told from type conflict.
- **Operator documentation** in `docs/`.

### Changed

- `--max-pages` now samples **across** sitemaps by default rather than taking
  the first N. On a site whose sitemap index is partitioned by content type, the
  old behaviour audited 500 blog posts and never reached the page sitemap —
  producing a report that confidently reported no `LocalBusiness` on a site that
  has one.
- A `www`/bare-host variant is no longer treated as cross-host. It had been
  dropping every URL of a site whose `robots.txt` declared its sitemap on the
  other spelling.
- Runs report what *this* run fetched, distinctly from what is stored. A resumed
  crawl was claiming to have fetched pages it never touched.

### Fixed — false positives found by running against 22 real sites

Each of these produced confident, wrong findings before it was caught:

- **Breadcrumb labels compared against page names** — 56 false contradictions on
  one site. A crumb label is deliberately short and is not the entity's name.
- **Blank-node ids compared by identity** — they embed `page_id`, so a
  byte-identical nested address looked like 150 distinct values.
- **URL-valued properties treated as entity references** — 38 false dangling
  references, every one a WordPress `#respond` anchor reached through `target`.
- **28 real findings with one root cause reported separately.** One generator
  behaviour, one fix; 28 entries invite 28 edits.
- **Page-scoped values reported as contradictions.** "url has 150 different
  values" is true and useless; "this property is page-scoped" is actionable.

### Known limitations

- **Microdata and RDFa are detected but not extracted.** Microdata types are
  recorded; the entity-level comparison is not performed.
- **JavaScript-injected structured data is invisible.** This is a raw HTML fetch.
- **No config file yet.** Environment variables and flags only.
- **10 of 23 designed checks are unbuilt**, including all five breadcrumb checks.
- `entity.type-conflict` and `entity.multi-value` have never fired on a real
  site — unit-tested, not validated.

## 0.1.0 — 2026-08-01

Crawler only. `robots.txt` → sitemap discovery → polite fetch → stored HTML,
with a resumable frontier.

Politeness is not configurable downward past a floor: one request in flight per
host, a 1000 ms default delay with a 200 ms floor, full `robots.txt` obedience,
and an unreadable `robots.txt` refuses the crawl rather than assuming
permission.
