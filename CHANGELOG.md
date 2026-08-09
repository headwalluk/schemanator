# Changelog

Notable changes. Dates are the day the work landed, not a release date.

## 1.4.0 — 2026-08-09

Background crawls, so an agent can start one without its shell timing out.

The loop that has emerged in real use is: crawl in a human's terminal, then let
the agent run `analyse`. That works, and `docs/agents.md` recommends it, but the
split exists only because `shell_exec` gives up long before a 500-page crawl
finishes. `--detach` removes the reason for the split.

### Added

- **`crawl --detach`** — start a crawl in the background and return at once.
  Output goes to `crawl/detached.log` under the run directory rather than being
  discarded: a detached crawl that fails silently is worse than one that fails
  loudly, because the operator sees "started", waits, and finds an empty work
  directory with nothing to read.

- **`schemanator status [site]`** — how far a crawl has got, or how it ended.
  No site argument lists every one.

  **Poll `--json`, and poll `running` rather than `state`.** They differ in the
  case that matters: a crawl whose process was killed keeps `state: "crawling"`,
  because that is what it was doing when it stopped, while `running` goes false.
  Anything waiting on `state` alone waits forever. `running` applies the
  liveness rules so a consumer never reasons about pids.

  The JSON carries `status_schema` and is pinned by `test/status-contract.test.ts`,
  the same guarantee `report.json` has. The plain-text output is for people and
  is explicitly not a contract.

- **`--allow-concurrent` and `--force`.** Neither is needed in normal use.

- **Exit code 4** — a crawl is already running and nothing was started.
  Deliberately distinct from `1`: this is "wait and retry" where failure is
  "stop and look", and an agent that cannot tell them apart either retries a
  real error forever or abandons a queue that would have cleared in a minute.

### Changed

- **One crawl runs at a time, across the whole work directory.** Not per-site,
  and the second reason is the stronger one. The obvious one is correctness:
  two processes appending to one site's `pages.jsonl` corrupt it. But `02`'s
  polite queue governs **a single process** — `tools/crawl-batch.sh` has
  serialised every crawl for this reason since the corpus was built — and
  client sites share hosting, so five detached crawls of five different sites
  can put five requests in flight against one network.

  `--allow-concurrent` relaxes the politeness lock only. The same-site lock is
  correctness and is never relaxed, whatever flags are passed.

- **`purge` refuses to remove a site that is being crawled**, and `--yes` does
  not override it. Found by working through the sequence rather than by review:
  purging mid-crawl threw away bandwidth already taken from the site while the
  crawl was still spending more, and the crawl only discovered it when its own
  files vanished. `--yes` means "I have read what this removes", which nobody
  has while the file list is still being written.

  The lock gates `crawl` and `purge` — the two commands that write. `analyse`,
  `status` and `sites` read, and are never blocked.

- **`analyse` warns rather than blocks while a crawl is running.** An agent
  polling a detached crawl will do this, and a partial answer is honest —
  `coverage.complete` already says so. The warning exists because "17 pages"
  reads like a fact about the site rather than a snapshot of a crawl in flight.

### Notes

The lock **is** the status file: a crawl writes progress on an interval, and
that same write proves it is alive. Keeping them separate would mean a lockfile
that can disagree with reality — held by a process that died an hour ago, with
no way to tell that from one merely being slow.

Stale locks are what kill designs like this, so the rules are explicit. A lock
whose process is provably gone *on this machine* is reclaimed automatically and
audibly. One taken on another host cannot be checked from here, so it blocks
until `--force`. **A stale heartbeat alone never reclaims anything** — a crawl
blocked on a 30-second timeout is alive, and stealing its lock is how two
crawls end up racing, which is the thing the lock exists to prevent.

Three bugs found by testing rather than by review, all in the paths that only
matter when something has already gone wrong:

- The detached child took its own lock, found the parent's, and refused to
  start. It now adopts the parent's, so ownership moves in one step and the
  file is never unheld.
- A torn status file blocked every future crawl of that site. `readStatus`
  correctly reported it absent, so it passed the blocker check and then
  collided with the atomic create, refusing with a message offering no way out.
- `readAllStatuses` ordered by timestamp alone, and two locks taken in the same
  millisecond ordered by whatever `readdir` returned.

## 1.3.0 — 2026-08-08

The findings Search Console raises, found before it raises them.

Everything this tool did until now needed two pages to see a problem. That is
the point of it, and it means a whole class of defect went unreported: markup
that is valid, self-consistent, identical sitewide, and still missing a field
Google needs before it will show a rich result. The prompt was a real GSC report
against a `Product` block that all 27 existing checks pass in silence, correctly.

### Added

- **Check group `google`** — Google's documented rich-result requirements,
  applied across the whole site at once.

  | Check | Severity | Reports |
  | --- | --- | --- |
  | `google.missing-required` | Error | A required field absent — no rich result at all |
  | `google.incomplete-alternative` | Error | None of a required set, such as `offers`/`review`/`aggregateRating` on a `Product` |
  | `google.missing-recommended` | Opportunity | A recommended field absent — the class Search Console lists as warnings |

  Covers `Product`, `Offer`, `AggregateOffer`, `Event`, `Place`,
  `VirtualLocation`, `LocalBusiness`, `Review`, `AggregateRating`, `Rating`,
  `VideoObject`, `FAQPage`, `Question` and `Answer`. Requirements live in
  `data/google-rich-results.json`, and every type cites the Google page it came
  from. Disable the lot with `--disable google`.

  Against the 22-site corpus: 30 findings, 2 of them errors, most sites
  producing two to four lines and twelve producing none.

- **`data/google-rich-results.json`** — the requirement table. Hand-curated
  rather than generated, because Google's documentation is prose with no
  machine-readable form; the file says so, and records what was deliberately
  left out.

### Changed

- **The "not a per-page validator" non-goal is narrower, and honest.** It was
  justified by attributing Google's rich-result requirements to
  validator.schema.org, which does not check them and never has — that tool
  checks whether a property is legal on a type. The requirements are a publisher
  policy on top of the vocabulary, and the only things applying them are Search
  Console after the fact and the Rich Results Test one URL at a time.

  Vocabulary validity and rich-result previews remain out of scope, and nothing
  here re-implements either.

- **Partiality is still silenced everywhere except group `google`**, which
  evaluates per observation because Google judges a page rather than an `@id`.
  A corpus `LocalBusiness` has two observations, one carrying `address` and one
  not; that is a real error on a real page, and grouping by `@id` hid it. Both
  readings are correct — they answer different questions — and `docs/checks.md`
  now says so rather than leaving it looking like an inconsistency.

### Notes

Three false-positive classes were caught by running the rules against the corpus
before writing them, and none was visible from reading the rules:

- Five `AggregateOffer` nodes reported as missing `Offer`'s required `price`.
  `AggregateOffer` is a subclass of `Offer` and carries `lowPrice` instead — so
  rules now dispatch on a node's most specific declared type, never on every
  match in its class closure.
- One `Offer` pricing itself through `priceSpecification.price`, which Google
  accepts and the rule did not know about.
- `AggregateRating` reported as missing `bestRating` and `worstRating` on 14
  nodes. Both default to 5 and 1, so the finding amounted to telling an operator
  that five is the best of five. Removed, and it is now the general test: a
  recommended field whose documented default already says what the site means is
  not a gap.

Every finding in this group carries the trade-off it cannot resolve. It reports
an absence and cannot tell whether you have anything true to put there — ratings
nobody gave and reviews nobody wrote are a guidelines violation, and a business
reviewing itself is ineligible for stars however the markup is written.

## 1.2.0 — 2026-08-02

Housekeeping. A crawl is expensive in a way that is easy to forget once it has
finished, and the work directory accumulates: stored HTML runs to roughly 250 KB
a page, so twenty sites is comfortably half a gigabyte and nobody remembers which
directories are still wanted.

### Added

- **`schemanator sites`** — what has been crawled, and what it costs. Pages
  fetched against 200-responses, disk usage, how much of that is reclaimable
  stored HTML, how many runs, and when it was last crawled. Largest first,
  because the question this usually answers is *"what is eating my disk"*.
  `--json` for scripting.

  It reads the directory rather than keeping an index, so there is no state to
  fall out of step: a work directory copied from another machine, or half-deleted
  by hand, still reports honestly. A crawl that died before writing its summary
  is listed with a note rather than skipped — the forgotten directories are
  exactly the ones a crash left incomplete.

- **`schemanator purge <site>`** — remove a crawl. `--html` removes only the
  stored pages, keeping the reports, the extracted nodes and the manifest.

  **Both print what they would remove and delete nothing without `--yes`.** Not
  generic caution: a crawl is an hour of somebody else's bandwidth, taken one
  polite request at a time, so an accidental purge is not merely your
  inconvenience — it means going back and taking it again.

- `--html` and `--yes` flags, for `purge` only.

### Fixed

- **`html_purged` finally means something.** The field has been in `pages.jsonl`
  since 1.0.0 and was never set true; the `find … -delete` one-liner previously
  documented reclaimed the space and left the manifest insisting the HTML was
  still there. `purge --html` updates it, and `sites` shows `purged` rather than
  a size once it has.

- **Piping into a reader that exits early no longer crashes.** `schemanator
  example.com | less` — which this tool's own documentation recommends — would
  throw an unhandled `EPIPE` and a stack trace if you quit the pager before the
  end. Same for `| head`. It exits quietly now; the consumer got what it asked
  for.

  Present since 1.0.0 and in every command, not just the new ones. It surfaced
  by accident here, and only intermittently: whether it fires is a race between
  the reader exiting and the next write, which makes it worse rather than
  better — it would have shown up once, for somebody else, at a bad moment.

## 1.1.0 — 2026-08-02

### Added

- **`--format md|json|html`.** `md` remains the default and still pipes; `json`
  is the contract; `html` is new.

  **`--json` is kept as an alias for `--format json`.** Removing it would have
  been a breaking change to a CLI published the same day, and every documented
  CI and fleet snippet uses it. It costs one line and it is the near-universal
  convention.

- **The HTML report.** One self-contained file — inline CSS, no stylesheet, no
  webfont, no image, **no JavaScript**, no network request of any kind. It has
  to survive being emailed, attached to a ticket, or opened from an archive in
  five years, and in each of those a fetch either fails or quietly reports that
  the file was opened. The no-JavaScript rule is the load-bearing one: a file
  that arrives by email and runs script is indistinguishable from something a
  mail client should block, and half of them will.

  It follows the reader's light or dark theme and carries print rules, because
  these become PDFs attached to tickets. Severity is a word as well as a colour,
  so nothing is lost on a mono printer.

  Every interpolated string is escaped without exception. Titles, values and
  provenance URLs are all copied out of somebody else's markup, and a site
  publishing `<script>` in a `name` must not get it executed in a report the
  operator opens. There is no field that is safe by construction.

- `report.html` is written to the run directory on **every** run, alongside
  `report.json` and `report.md`. `--format` only picks what goes to stdout, so
  the HTML can be sent on later without re-running anything.

### Notes

The diff (`--since`) has no HTML renderer. Asking for one prints markdown and
says so, rather than silently emitting the wrong document.

## 1.0.1 — 2026-08-02

### Fixed

- **`coverage.competing-syntax` cited another site's microdata types as though
  they were yours.** The summary named `WPHeader`, `SiteNavigationElement` and
  `Blog` — types measured on two corpus sites and offered as an illustration.
  Read in a report about a different site it looks like a measurement, and an AI
  agent consuming the report repeated all three as fact about a site where
  nothing had checked.

  The real answer was being extracted and thrown away: `microdata_types` was
  computed per page and dropped before reaching `pages.jsonl`. It is persisted
  now, so the finding names the types actually present and says which of them the
  JSON-LD already covers — the distinction between dilution and duplication.

- **The type comparison matched nothing.** `itemtype` arrives as a full IRI and
  node types are normalised, so every microdata type was reported as absent from
  the JSON-LD — including `WebPage`, on a site whose JSON-LD is mostly `WebPage`
  nodes. Both sides are shortened before comparison.

### Added

- **`docs/agents.md`** — using schemanator with an AI agent. The crawl/analyse
  split (crawl is slow and network-bound; `analyse` is offline and idempotent,
  which keeps an agent away from the one command that fetches other people's
  servers), and the sandbox pitfall: crawling in a terminal and analysing from a
  sandboxed desktop agent fails *silently*, because output lands in
  `~/.local/state/schemanator` and sandboxed apps are routinely denied it.
- `microdata_types` on each `pages.jsonl` record. Additive; older crawls carry an
  empty list and the finding says the types are unknown rather than inventing
  any. Re-running `analyse` fills them in, with no network.

### Changed

- **npm version, licence and Node floor badges are now live**, sourced from the
  published package rather than hand-edited. Test and check counts stay static —
  neither has a live source without CI — and both now have a test asserting they
  have not drifted, along with a third asserting no *other* static badge creeps
  in unwatched.

### Note

Persisting the types reopened a decision closed the same morning. `04` concluded
microdata is theme chrome with "almost nothing to contradict", generalising from
the only two sites examined by hand. Measured across all six microdata sites,
four are chrome and **two are not** — one emitting `Organization` matching its
JSON-LD plus `Rating` and `Review` present in neither, another emitting `Product`
in both syntaxes across 20 pages.

That last is verbatim the trigger condition recorded for revisiting full
microdata extraction, and it was already in the corpus — unmeasurable because of
the dropped field. Recorded, not acted on: the parser tension is unchanged, and
overlap is not disagreement. A 1.1.0 question.

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
