# Changelog

Notable changes. Dates are the day the work landed, not a release date.

## 1.13.0 — 2026-08-20

### Added

- **Group `link`, and the crawler change underneath it.** The last item in
  `07`'s build order. `graph/links.jsonl` has been written since 1.7.0 and read
  by nothing; it is read now.

  - **`link.noindex-only-inbound`** (Warning) — a page in a sitemap whose only
    inbound internal links are on pages carrying `noindex`. The common shape is
    a section index or tag archive set to `noindex, follow`, which is usually
    correct, quietly becoming the only route to everything filed under it.
    Google eventually stops following those links, at which point the pages are
    listed for indexing and cut off from every page that could support them.
    Nothing that reads one page at a time can see it: every page involved is
    individually fine.
  - **`link.orphan`** (Warning) — a sitemap page nothing on the site links to.
    Self-links do not count, which is most of what a real orphan has: comment
    permalinks and "Cancel reply".

- **The crawl follows one hop out of the sitemap.** Internal URLs that are
  linked from a crawled page but listed in no sitemap are now fetched, and it
  stops there — following their links in turn would be a general web crawler.

  **This is not a feature the checks happen to need; it is the reason they could
  not exist before.** Measured on a real site, a sitemap-only crawl finds eight
  pages with no inbound link, of which five are genuine and three are posts on
  page 2 of a paginated archive nothing fetched. **37% false positives, and no
  narrowing of the rule could have fixed it** — the evidence was not on disk. On
  a crawl without the hop, group `link` reports nothing at all rather than
  guessing.

  **It also needs every page that could hold a link to have been fetched** —
  neither `--max-pages` nor `--link-hop-pages` may have bitten. Both conditions
  came from the corpus shakedown rather than the design, and in that order. On a
  564-URL site sampled at 100, `link.orphan` reported nine pages "linked from
  nowhere on the site", a claim resting on 18% of it. `coverage_qualified` was
  already set and was not enough: a footnote does not rescue a headline. Then
  the same site at *full* sitemap coverage reported 29 — with 205 unlisted URLs
  still unfetched behind the hop's own cap. `coverage.complete` was true and the
  link graph was not.

  When either cap silences the group, the crawl prints the number that would
  lift it. On a large site that number is not small: the same shop linked to 832
  pages listed in no sitemap, against 564 in its sitemaps. **The defaults will
  not close the link graph on a big site, deliberately** — the alternative is
  making several hundred unrequested extra requests to somebody's server.

  Capped separately at `--link-hop-pages` (default 50) rather than sharing
  `--max-pages`: these are evidence about the sample, not members of it, and
  sharing one budget means an audited page drops out to make room for a footer
  link. `--no-link-hop` turns it off. `robots.txt` governs it as it governs
  everything else.

- **`coverage.pages_linked` in `report.json`.** Adding a key is not a breaking
  change, so `report_schema` stays at 1. Hop pages are excluded from
  `pages_fetched`, `pages_extracted` and every number under `graph`, because the
  report describes the audited sample — the first live run printed *"Pages
  fetched | 73 of 54 discovered"*, which is not a number that can be true.

### Changed

- **`--max-pages` now defaults to 100, down from 500.** The default's job is to
  see several instances of every content type, and under `spread` sampling that
  is governed by how many sitemaps a site partitions into rather than by the
  total — six groups and a hundred pages is sixteen of each. Divergence under a
  shared `@id` shows up in the first handful; the next four hundred pages
  restate it.

  The number that changed is a time budget. At one request per second 500 pages
  is nine minutes, which outlives most agent shell timeouts, and an audit nobody
  waits for is worth nothing. A hundred is under two.

  **What it costs, stated plainly:** checks that compare pages against each
  other need both halves of a pair in the sample, so a lower cap means more
  sites fall under the sampling warning. That warning is the mitigation — it
  names the checks that weaken, and `--max-pages 500` restores the old
  behaviour exactly.

- **The cap is a named constant with a test behind it.** It was a bare `500` in
  one destructure and written out again in `--help` and three documents. The
  help text interpolates `DEFAULT_MAX_PAGES`, and `docs-consistency.test.ts`
  asserts every document claiming a page cap claims this one — including that
  the sentence it matches still exists, so a rewording fails the test rather
  than silently matching nothing.

### Fixed

- **`robots.sitemap-missing` counted the paths it probed for a sitemap as
  sitemaps.** When `robots.txt` declares none, the crawl probes five well-known
  paths; a site that answers one of them 404s the other four, and all five were
  recorded as found. The finding read *"this site has 5 sitemap(s), found by
  probing well-known paths"* and its remediation offered one of the dead URLs to
  paste into `robots.txt`.

  It also made the check unable to honour its own documentation. *"A site with
  no sitemap at all is a different finding and is not this one"* was written into
  the source and into `docs/checks.md`, and could not hold while five failed
  probes counted as five sitemaps — on a site with no sitemap anywhere, the
  check fired and named five that were not there.

  **The documentation was right and the code was wrong**, which is the failure
  `CLAUDE.md` warns about from the other direction: prose reads the same whether
  or not the code follows it. Found the first time the check ever produced a
  true positive.

### Testing

- **A fixture site for the checks that had never fired.** Sixteen catalogue
  checks had never seen a true positive — not because they were wrong, but
  because nothing in the 22-site corpus does what they look for, and three of
  them are silent precisely *because* a false-positive class was correctly
  removed. Every one was unit-tested, and unit tests were never the gap: what
  was unproven is whether the pipeline in front of a rule delivers what the rule
  needs.

  `startDefectSite()` is a site built to make each of them fire, driven end to
  end through `runCrawl` → `runAnalysis` in one shared crawl. It carries the
  cases each check must stay **silent** on as well: an unreferenced `Article`
  that is the page rather than dead markup, a `Disallow` on `/wp-admin/` that
  blocks nothing a renderer needs, and a sparse page hiding more than it shows
  whose word counts are both under the floor.

  Those negatives are not decoration. Two of the three were added after
  deliberately breaking the rule they guard and finding the suite still green.

  With the other two fixture sites, every check in the catalogue that had never
  fired now has an end-to-end regression test. **That is regression cover, not
  field validation** — most of these still have not fired on a real site, and
  `dev-notes/00` keeps that distinction.

## 1.12.0 — 2026-08-14

What a field report found. 1.11.1 was run against a real site by somebody using
it to check their own work rather than to test the tool, and the nine
observations that came back are being worked through here.

**The first read-through to find output that was wrong rather than merely
unconvincing.** The three before it each found a reader being invited to distrust
a correct finding. This one found a number that could not be true, in a field
consumers are told to rely on — and because the finding above it *was* right, the
reader trusted the number and reasoned to a wrong conclusion from it.

### Fixed

- **`observed[].page_count` was hardcoded to 1 on every `google` finding.** A
  defect on 53 pages reported `53 nodes — on 1 page(s)`, directly beneath a
  heading reading *"Pages affected: 53"*. Rows that aggregate one `@id` across a
  site now count the pages they actually span, and the provenance beneath them
  spends its three examples on distinct pages instead of citing one page for a
  sitewide problem.

  Worth stating plainly, because it is the cost of the bug rather than the bug:
  two nodes on one page can only be a definition plus a reference, so the number
  read as proof that bare `@id` references were being counted as observations.
  They are not, and never have been — extraction refuses to hoist them. The
  finding was right; only its evidence lied.

- **The same class, guarded rather than patched.** A new catalogue-wide test
  asserts that no observed row may claim more pages than the finding containing
  it, or contradict its own provenance. It found a second instance on its first
  run — aggregate rows use `observation_count` to mean "one constituent finding"
  — which is recorded as a known exemption with its reason, and fixed when the
  work it depends on lands rather than papered over now.

- **A trade-off now belongs to the property, not to the check that noticed it.**
  The warning about inventing ratings and reviews was attached to
  `google.missing-recommended` as a whole, so it printed verbatim under *"Offer
  omits priceValidUntil"* and *"LocalBusiness omits openingHoursSpecification"*,
  where it means nothing. It was three of four findings on one real site.
  Boilerplate in the place where a warning matters is what stops it being read.

  `priceValidUntil` gains one of its own, and it is the more useful advice there:
  a **wrong** date is worse than none, because once it is in the past the offer
  can be treated as expired.

- **An aggregate keeps every constituent's trade-off.** It inherited the first
  one's, which was invisible while a whole check shared a single trade-off and
  became wrong the moment they varied by property.

- **Every capped list now says it was capped.** `observed` was cut short in
  around two dozen places and none of them admitted it, so a truncated list was
  indistinguishable from a complete one. Findings carry `omitted_count`, and both
  renderers print *"…and 140 more, not listed here or in report.json"*.

  This is the fault behind the retracted observation in the field report. The
  summary said three pages, the evidence beneath it showed two, and the reader
  concluded — reasonably — that the summary was broken. It was not; the third
  page had been silently dropped from the list. **Truncation does not merely hide
  detail, it makes correct output look wrong.**

- **The prose that overstated it, in the same breath.** An aggregate summary said
  *"the individual subjects are listed below"* and its advice said *"apply this
  to each of the 154 subjects listed above"*, where ten were listed. Both
  sentences were written against five-subject aggregates and read perfectly
  there. The summary now says how many of them are listed; the advice names the
  count and drops the claim about the list.

  A third sentence promised *"see report.json"* for the subjects an aggregate had
  dropped. The JSON carries the same ten rows. It has gone: a cap that
  misdirects is worse than one that admits itself.

- **The exemption from 1.11.1 is closed.** Aggregate rows set
  `observation_count` to 1, meaning "one constituent finding" rather than one
  observation — a second meaning for a field consumers read. It could not be
  fixed until truncation was counted, because a constituent that has dropped rows
  cannot say how much it saw by adding up the ones it kept. It can now, and the
  catalogue-wide invariant holds with no exemptions.

### Added

- **Two checks for sitemaps that repeat themselves.**
  `indexing.sitemap-duplicate-url` reports one URL listed twice inside a single
  sitemap; `indexing.sitemap-overlap` reports one URL listed in two sitemaps of
  an index. Both are opportunities: nothing is broken, and every consumer
  deduplicates as this crawler does.

  The second is the one that makes a situation legible. A real site's
  `product-sitemap.xml` held five entries — three copies of one URL, one that
  redirected away, and one page already listed in `page-sitemap.xml` — so the
  whole file was doing nothing, and no report could say so.

  **They need a crawl from 1.12.0 onwards.** Deduplication happens while sitemaps
  are being read, so the repetition was gone before any page record existed;
  `crawl-summary.json` now carries `duplicate_entries`. On an older crawl both
  checks stay silent and mean *"not measured"* rather than *"none found"* — and
  unlike everything else in this tool, re-running `analyse` cannot fill it in. It
  takes a re-crawl.

  Crawling behaviour has not changed. A URL listed three times is still fetched
  once, which is the half of this that had to stay exactly as it was.

### Changed

- **A page is stored once, however many URLs reach it.** A sitemap that lists
  both `/shop/` and `/pricing/`, where the first 301s to the second, describes
  one page — and the crawl stored two, writing the destination's HTML under each
  requested URL. Its markup was then extracted twice, every `@id` on it appeared
  under two `page_id`s, and every finding about it was billed to two pages. On a
  real site that turned 5 products into 9.

  A page record is now keyed by the URL the fetch **resolved to**, so two
  requests landing on one page produce one record whichever order they arrive
  in. The redirecting request survives on that record as an *alias*, carrying
  the URL asked for, the sitemap that asked, and the hops the server returned —
  so `indexing.sitemap-redirects` still reports it, which is the half of this
  that must not be traded away to fix the arithmetic.

  Crawling is unchanged: the same URLs are requested, and `fetched` still counts
  requests. What changes is that requests and pages are now different numbers,
  as they always were in fact.

  **Only new crawls reconcile.** An existing crawl keeps the records it has —
  including a resumed one, since a URL already fetched is not fetched again — so
  re-crawl to correct a site whose sitemap lists a redirect and its destination.

- **One sample size for the whole catalogue: ten observed rows.** The caps were
  3, 5, 8, 10 and 15, every one a bare number, and no reason survived being asked
  for — the early files say 5 and the later ones say 10. Lists that were cut at
  three or five now show ten; `indexing.thin-sitemap-entry`, which showed 15,
  shows ten and a count of the rest.

  `sample-caps.test.ts` fails any check module that truncates a list with a
  literal, which is the rule in `CLAUDE.md` finally enforced rather than
  remembered. It would have caught all two dozen.

- **`observed[].value` is an identifier again, and the annotation moved to
  `detail`.** Nine checks appended one — `— 2 nodes`, `— 23 KB, 400 words`,
  `— OpenAI, training` — so a value could not be grepped, compared between runs
  or pasted anywhere useful. Both renderers join the two, so the report reads as
  it did; `report.json` gains a key and loses none.

  `page.title-duplicate` was the worst of them: it read `2 pages: Shop` beside a
  `page_count` of 2, saying the same number twice and making the title
  unsearchable in the process. The row is the title now.

- **A changed annotation is no longer a changed finding.** `--since` fingerprints
  the evidence, and with the annotation inside `value` it was fingerprinting
  presentation: a page gaining a paragraph reported `content.javascript-only` as
  *changed* on a run where nothing about the problem had moved. `detail` is
  excluded from the comparison, which is half the reason it exists.

- **The HTML renderer stops printing `0 pages affected` and `— on 0 pages`.** A
  page count of zero means the value is not page-scoped — a crawler token, a
  type name, a URL pair — and the markdown renderer has omitted both since
  1.10.0. Two renderers describing one finding differently is the thing
  `html.ts` says in its own header must not happen. Found one line apart, which
  is what a class of fault looks like when only the instance gets fixed.

- **`coverage.no-structured-data` lists one page per row.** It reported a single
  row whose value was five URLs glued together with newlines, carrying the whole
  site's count — a capped list wearing the costume of a complete one.

- **`aggregateRating` and `review` are reported as one opportunity.** They were
  two findings over the same nodes, the same pages, asking one question: does
  this site hold review data at all. Google lists them as two recommendations
  and this tool now reports them as one decision — *"Product has neither
  aggregateRating nor review"*. The required-set wording, "has none of", is
  deliberately not reused: it sounds like an obligation, and this is not one.

  Expect **fewer findings on most sites and one more on a few**. Where the pair
  collapsing drops a type below the aggregation threshold, an aggregate titled
  *"3 fields Google recommends for Product are absent"* becomes two findings that
  each name a real decision. That is more useful, not less.

- **`data/google-rich-results.json` is at `schema_version` 2**, adding
  `tradeoffs` and `recommended_one_of`. If you ship a modified copy, it needs
  both keys' shapes; the loader will tell you exactly which type and key is at
  fault, including if you leave a property in both `recommended` and
  `recommended_one_of`, which would report it twice.

### Notes for anyone diffing across this release

`--since` compares observed rows by value and page count, so **the first diff
across this release will report every `google` finding as changed** when nothing
about the site has moved. Findings whose `observed` list was capped at three or
five will also come back changed, because ten rows are listed where fewer were
before, and so will the nine checks whose values shed an annotation.

All three are this release landing. **Subsequent runs compare more quietly than
they did**, because the annotation the fingerprint used to read is now somewhere
it cannot see.

Findings are matched by id, and an id names the question asked. Merging
`aggregateRating` and `review` into one question therefore asks a new one, so
that first diff also shows **two resolved and one appeared** where the pair used
to be. Nothing has been fixed and nothing has broken.

**A site whose sitemap lists a redirect and its destination will report fewer
nodes and fewer affected pages** after a re-crawl — not because anything was
fixed, but because the page had been counted twice and now is not.

### What was validated, and how

Everything here was run against the 22-site fixture corpus and a purpose-built
fixture site; the 22 stored crawls report identically, which is the point, since
they predate this release and nothing about them changed.

**Two things could not be validated that way and are honestly less proven.** The
sitemap-duplicate checks and the redirect reconciliation both need a crawl made
by this version. A live run against the site the field report came from was made
on 2026-08-14 and came back clean — the sitemap that carried both defects had
since been removed — so both features are exercised end to end by the fixture
site, and neither has yet fired on a real site's markup.

### Found by the validation crawl, 2026-08-15

- **The crawl said "36 stored" where 35 pages were stored.** `fetched` counts
  requests that succeeded, and reconciliation means two requests can land on one
  page — so printing it as the stored count was a number that could not be true,
  which is the exact fault this release was written to remove. It found its way
  into the first real run of the feature that caused it. `crawl-summary.json`
  gains `pages_stored`, the manifest count, and the CLI prints that.

### Documentation accuracy, 2026-08-15

Found by auditing the claims rather than by reading them, in the wrap-up pass
before this release was published.

- **`CLAUDE.md` said Prettier and ESLint were "agreed and not yet configured"**,
  and told contributors to hand-match the surrounding file's style. They landed
  in M6 on 2026-08-09. A stale instruction is worse than a missing one: it is
  followed.
- **`docs/agents.md` did not mention that evidence is sampled.** An agent that
  works through the ten visible `observed` rows of a 150-subject finding and
  reports the job done has fixed a fifteenth of it — the machine version of the
  misreading that opened this release. It now says what `omitted_count` means,
  where the full set is, and to match on `value` rather than parse `detail`.
- **The check count is asserted wherever it is claimed**, not only on the README
  badge. It is written in prose in two other files, both of which said 52 after
  the catalogue reached 54.

Both stale claims were in files nothing was checking, which is the whole reason
the new test is wider than `docs/`.

543 tests, all passing.

## 1.11.1 — 2026-08-09

Documentation accuracy pass. No behaviour change; `docs/` ships in the package,
so the correction is a release rather than a private tidy-up.

### Fixed

- **Two stale check counts.** `docs/dev/getting-started.md` and `CLAUDE.md` both
  still said 30.
- **`data/ai-crawlers.json` was undocumented.** It is the fourth shipped data
  file and the only one an operator is likely to want to edit — it decides what
  `robots.ai-crawler-blocked` says about their site. `docs/configuration.md` now
  covers it, including why `purpose` separates training from retrieval.
- **The derived artefacts appeared nowhere.** `graph/links.jsonl`,
  `pages/<id>/content.md` and `page_facts` have shipped since 1.7.0 with no
  operator-facing description. `docs/usage.md` now lists what extraction leaves
  behind, and says plainly that `content.md` is what a machine reading the page
  actually gets — which is what makes it worth pairing with the report.

### Added

- **`docs/dev/adding-a-check.md` gains a step: read a real report as a stranger
  would.** It is a different activity from the shakedown and catches a different
  class. The shakedown asks whether findings are *right*; this asks whether they
  are *believable*, and the answer has been no three times running. The table of
  what it has caught is in the doc, and not one entry was a wrong finding.

511 tests, all passing.

## 1.11.0 — 2026-08-09

A second read-through, of a second real report. Three more presentation faults,
all of the same family as the first read found: **numbers and names that
contradict something else in the same finding**. None was a false positive.

### Fixed

- **An aggregate inherited advice written for one subject.** A three-property
  `value.empty` finding was titled *"3 properties are published as empty
  strings"* above *"Fill in postalCode"* — somebody following that fixes one of
  three. The constituent's wording is kept, because it explains the fix, and now
  says which subjects it applies to. Its summary is framed as an example rather
  than as the whole finding.

- **Blank-node ids were shown as the thing to act on.**
  `_:page/json-ld/1/0/http:~1~1schema.org~1offers/0` is an internal positional
  id: nothing can be done with it, and the provenance beneath already carries
  the page. Blank nodes now report the page they were found on, and several on
  one page collapse to a single row with a count.

- **A page title containing a quote rendered as if the tool had broken.** One
  site has a page title beginning with a stray `"`, so wrapping the value in
  quotes produced `""Virtual …`. The count now leads and the title is not
  wrapped — so a genuine typo reads as a genuine typo.

### Notes

Worth recording what these read-throughs keep finding. Across three reports, not
one problem was a wrong finding — every one was a **reader being invited to
distrust the output**: a title counting subjects and calling them pages, a
"Pages affected: 0", an id nobody can use, advice that covers a third of what
the title claims.

Shakedowns cannot catch this class, because every finding involved is true. Only
reading the thing as its audience does.

The same reading also surfaced a real defect on the audited site that nothing
else would have: a page title with a stray leading quote character, duplicated
across two pages.

511 tests, all passing.

## 1.10.0 — 2026-08-09

Everything here came from reading one report end to end, as a stranger would.
The shakedowns could not have found any of it: every finding involved was
*true*, and every one of them read badly.

### Added

- **`indexing.thin-sitemap-entry`** (Opportunity) — sitemap URLs with under 25
  words of their own content. Carts, baskets, account screens, login gates and
  thank-you pages: a sitemap is a request to index, and these have little to
  index.

  It lists what it found rather than asserting a fix, because **word count
  cannot tell a cart from a contact page** — one corpus site's `/contact-us/`
  carries five words and belongs in a sitemap absolutely. The operator can tell
  in four seconds; the tool cannot tell at all.

  It does **not** claim to find low-value *archives*. `07` designed that around
  a high link-to-text ratio, and measurement killed it: a WooCommerce product
  archive scores 0.00 links per word while a single product page scores 0.03.
  Archives look exactly like content pages by every text measure available here.

### Fixed

- **`content.main-in-aside` fired on eight utility pages of one site**, all with
  9 to 32 words of content — where any sidebar exceeds the body. The advice was
  wrong twice over: those pages did not need their markup rearranged, they
  needed taking out of the sitemap. This is the same sparse-page guard written
  for `content.hidden-text` and not carried across to its sibling.

- **One page counted twice, in three separate findings.** `/checkout/`
  redirecting to `/basket/` leaves two records sharing a `canonical_url`, so the
  same URL was listed twice, a title read "9 page(s)" above a field reading 8,
  and `page.title-duplicate` reported a page as a duplicate of *itself*.

  Fixed by deduplicating the **input** rather than the display: `page` and
  `content` reason about the page a reader arrives at, never the request that
  got them there. `indexing` deliberately still sees every request — a sitemap
  entry that redirects is a fact about the request, and collapsing it would
  erase the finding.

- **An aggregate title said "pages" when it counted subjects**, so one finding
  read "32 pages carry two breadcrumb trails" directly above "Pages affected:
  56". `aggregate_title` must name what is being counted.

- **"Pages affected: 0"** is no longer printed. A site-level finding computed
  from the graph has no page count, and a zero read as a broken tool.

- **"on 1 page(s)"** is no longer printed beside values that are not pages —
  entity names, types, URL pairs — where it sat beside a finding claiming 28.

508 tests, all passing.

## 1.9.0 — 2026-08-09

Group `page` — the last of the four stages in `dev-notes/07`. Seven checks, and
**one planned check deleted by the survey before a line of it was written**.

### Added

- **`page.title-missing`** (Error), **`page.h1-missing`** (Warning),
  **`page.lang-missing`** (Opportunity) — the signals a machine uses to work out
  what a page is and what language it is in.
- **`page.image-alt-missing`** (Warning) — images with *no* alt attribute. To
  anything reading the page as text, an image without alt is simply absent. An
  explicitly empty `alt=""` is correct for decoration and is not reported.
- **`page.image-alt-useless`** (Warning) — `1000005782`, `IMG`, `untitled`.
  Passes every check that only asks whether the attribute exists.
- **`page.title-duplicate`** (Warning) — one title on several pages. Site-wide
  by nature, so a per-page tool can see a title but not that it is shared.
- **`page.h1-multiple`** (Opportunity) — see below.

Every check reports **once for the site**. A per-page finding for missing alt
text on a 500-page site is 500 findings describing one template.

### Notes

**`page.heading-sequence` is not built, and a test keeps it that way.** 549 of
1,831 corpus pages skip a heading level — 29%. At that incidence it is normal
practice rather than a defect, and a slightly malformed outline does not stop a
machine consuming anything. It fails `07`'s admission test: *does this stop a
machine consuming the page?*

**`page.h1-multiple` is an opportunity, not a warning.** The one-`h1` rule is
HTML4 and is still repeated as though it applied; HTML5 sectioning permits
several and Google has said so. 205 corpus pages have more than one. The finding
reports an ambiguity to resolve — a consumer picking one line to represent the
document has to choose — and says plainly that the markup is valid.

`page.image-alt-useless` was narrowed after the shakedown. Flagging any alt
ending in a file extension caught alt text that describes its image perfectly
well and merely carries a suffix; telling somebody to rewrite those is the
low-value advice that makes a report get skimmed. The stem has to be
uninformative too, which leaves the real thing — one value repeated on 142 pages
of a single site.

Two of the seven ship untriggered: every corpus page has a `<title>` and
declares a language.

The docs-consistency suite needed widening, having been written before any check
id contained a digit — `page.h1-missing` failed its own naming rule. And the
client-name leak test earned its place for the second time in two days, catching
a client's name in a source comment before it reached a tarball.

505 tests, all passing.

## 1.8.0 — 2026-08-09

Group `content` — the flagship of `dev-notes/07`, and the group that answers the
question the rest of the tool cannot: an AI agent fetches your page, and does it
actually get the words?

### Added

- **`content.not-extractable`** (Error) — substantial text sitting outside the
  page's own `<main>` and `<article>` landmarks. A consumer that follows them —
  which is what most AI agents and a `web_fetch` do — reads a fraction of what a
  person sees.
- **`content.javascript-only`** (Error) — a large response with almost no
  readable text. **Not running JavaScript is the measurement here, not a
  limitation:** we see exactly what a non-rendering consumer sees.
- **`content.main-in-aside`** (Warning) — more text in `<aside>` than in the
  main landmarks. Extractors treat an aside as secondary and commonly drop it.
- **`content.hidden-text`** (Warning) — more substance concealed than shown.
- **`content.no-landmark`** (Opportunity) — no `<main>` or `<article>` at all,
  so a consumer must guess which part of the page is the page. Site-level: it is
  one template decision however many pages carry it.

Every check is a **discrepancy, not a judgement**. This tool has no opinion
about whether your copy is any good; it reports that two views of the same page
disagree.

### Notes

**The planned signal was wrong, and the survey killed it before a line of check
code was written.** `extractable / dom_words` has a median of 46%, and a 25%
threshold fired on 390 pages — 21% of the corpus — because `dom_words` includes
the navigation. That ratio mostly measures how big a site's menu is.

What works is `main_words / extractable_words`. Only 9 of 1,193 pages fall under
10%, so the threshold sits in an empty gap rather than on a slope. It needed two
facts the extraction shipped a day earlier did not have.

Verified by hand rather than trusted: one site's blog posts carry 2,030 words
with 32 inside a landmark, because `<article>` wraps the related-post cards. And
one site's *testimonials* page returns 52 KB, 29 script tags, and 63 words that
are entirely the menu — an agent asking about testimonials gets a navigation bar.

`content.hidden-text` produced two false-positive classes before it was right:
91 findings were hidden *navigation* — mobile menus and sticky bars marked
`aria-hidden`, which conceal nothing — and then 48 were colour-swatch pages with
17 visible words, which tripped "more hidden than visible" simply by being
sparse. Both are pinned as regression tests, and the check now ships untriggered.

496 tests, all passing.

## 1.7.0 — 2026-08-09

The extraction change three stages of `dev-notes/07` depend on. Three artefacts,
one pass over the DOM that was already being parsed, and **no re-crawl** —
`analyse` fills them in from stored HTML.

### Added

- **`page_facts` on every page record.** Title, description, heading *levels*,
  robots directives, `hreflang`, `lang`, landmark presence, image and alt-text
  counts, word counts, and a content simhash. Scalars and tiny arrays only, so
  checks never touch HTML (`04`) and the manifest stays readable.

  Heading **levels**, not heading text: no check needs the words, and storing
  them would have roughly doubled a file `sites` reads whole.

- **`graph/links.jsonl`** — one row per link, with `in_chrome` marking site
  navigation. Its own artefact rather than a field on the page record, because a
  500-page site has around 190,000 edges and the manifest is read by every
  command that touches the work directory.

  Nothing reads it yet. It ships now because retrofitting it after a `links: []`
  array had shipped inside `page_facts` would be a manifest migration.

- **`pages/<page-id>/content.md`** — the page with site chrome removed, as
  markdown. Nothing in the check layer reads it; it exists so the operator and
  their agent can ask questions this tool deliberately will not, such as whether
  the opening paragraphs read well.

  **`purge --html` keeps it**, now pinned by a test. At 2.5% of the stored HTML,
  reclaiming the space still leaves the readable content behind.

### Notes

Chrome is removed two ways, neither a guess. **By declaration** — anything
inside `<nav>`, `<header>` or `<footer>`, which is reading the document rather
than guessing at it. And **by measurement** — a block of text on 80% or more of
the crawled pages is site furniture. The second needs the whole site, which is
exactly why a per-page tool cannot do it.

`<aside>` is deliberately *not* structural chrome. Main content wrongly placed
in one is a planned finding, and stripping it here would erase the discrepancy
that check exists to see.

Four things the corpus corrected, none visible from the design:

- **Link chrome cannot be decided by the enclosing text block.** A nav link
  lives in `<li><a>Contact</a></li>` — one word, never a block. The first
  version marked 9% of a site's edges as chrome when 88% of them pointed at
  targets appearing on every page, the homepage among them. Target frequency is
  the right signal.
- **A minimum block length censors the document.** "What is included" is three
  words, so a four-word floor dropped nearly every heading and the markdown came
  out as unheaded prose.
- **Headings must never be treated as chrome**, or a site using consistent
  section headings loses its outline to its own consistency.
- **Frequency needs a floor of five pages**, and structural chrome covers the
  gap beneath it.

Measured cost: `content.md` is 2.5% of stored HTML; the manifest grew from ~900
to ~1,450 bytes a record, more than the third predicted when this was designed.
Across the 22-site corpus: 331,291 links and 1,831 markdown files.

483 tests, all passing.

## 1.6.0 — 2026-08-09

The three measures that keep the report readable as the catalogue grows. All
three come from `dev-notes/07`, where the risk was originally recorded as
"report.json will drown in data" — and then measured, found to be wrong, and
replaced with what the problem actually is.

### Changed

- **Findings sort by severity, then by group.** `syntax` leads, because a block
  that would not parse means every entity in it is *missing* and every other
  finding was computed from an incomplete graph. Then `entity` and `graph` — the
  whole-site contradictions this tool exists to find. `coverage` is last, being
  mostly "you could publish more".

  Without it, page count decided: a routine `page.title-missing` on 400 pages
  outranked an `entity.contradiction` on 3, burying the rarer finding that no
  other tool produces. An unlisted group sorts **last**, so a new group has to
  earn its position rather than inherit the top of the report.

### Added

- **The crawl warns when the sample gets thin.** Below half the discovered URLs
  it names the consequence rather than just the cap.

  `--max-pages` used to be purely a time-and-politeness knob. It is not any
  more: checks that compare pages against each other now exist, and for those a
  small sample produces a **false negative that reads as a pass**. Crawl one URL
  of a duplicate pair, never see the other, and `indexing.duplicate-content`
  reports nothing at all — not a maybe, nothing. Findings that assert something
  is *absent* were already qualified by coverage; this is the class that was not.

- **A finding-count guard.** `finding-volume.test.ts` runs every check against a
  synthetic 1,000-page site and fails any that emits more than 50 findings.

  `report.json` is bounded — 36 KB for the largest corpus report, and it does not
  scale with page count — but only because every check respects the caps in
  `05`. One that forgets `pattern` and emits per page breaks all of them at once.

  **Verified by breaking a check and watching it fail:** removing `pattern` from
  `graph.blank-node-entity` produced "1000 findings from 1000 pages", precisely
  the mistake being guarded, and the guard caught it. A test that passes either
  way proves nothing.

### Notes

The report ordering change was checked against the corpus to confirm it changes
*order* and never *membership* — finding-id sets before and after are identical.

466 tests, all passing.

## 1.5.0 — 2026-08-09

Can Google and an AI agent consume this site at all? Nine checks, no extraction
change, no re-crawl.

The framing comes from `dev-notes/07`: structured data is machine-readable
*metadata*, and this is the layer below — whether a machine can fetch the site,
and whether the signals about indexing it agree. Same thesis as everything else
here, one layer up, and the admission test is **"does this stop a machine
consuming the page?"** rather than "is this good SEO practice".

### Added

- **Group `robots`** — `ai-crawler-blocked`, `resource-blocked`,
  `sitemap-missing`. These read the `robots.txt` your crawl already stored
  verbatim, so they work on any existing crawl.

  `robots.ai-crawler-blocked` is the one worth reading twice. It reports when
  `robots.txt` disallows GPTBot, ClaudeBot, Google-Extended and the rest — and
  it is a **Warning, never an Error**, because blocking them is a legitimate
  choice. It exists because the block is more often *inherited* than chosen:
  security and SEO plugins add these by default. The finding separates training
  crawlers (blocking them changes nothing about answers today) from retrieval
  crawlers (blocking those makes you invisible at the moment somebody asks about
  you), because the two need different decisions.

  A site blocking *everything* is deliberately not reported here. That is a much
  larger problem and burying it inside an AI-crawler finding would be the wrong
  headline.

- **Group `indexing`** — `sitemap-dead-url`, `sitemap-redirects`,
  `redirect-chain`, `canonical-to-redirect`, `canonical-chain`,
  `duplicate-content`. Every one is two claims contradicting each other: a
  sitemap entry is a request to index, a 404 is the page saying it does not
  exist, and both cannot be true.

  All of it reads fields the crawl has stored since 1.0.0 and nothing had ever
  read — `redirect_chain`, `http_status`, `content_sha256`, and `source`, which
  records which sitemap file each URL came from.

- **`data/ai-crawlers.json`** — fourteen crawler tokens, each citing the
  operator's own documentation, each tagged training or retrieval. The loader
  refuses an entry without a source.

### Notes

Two false-positive classes, 20 findings across 6 sites, **every one wrong**, and
neither visible from reading the code:

- **`duplicate-content` was reporting redirects.** Three URLs redirecting to one
  page share a `canonical_url` and a body hash, so they looked byte-identical.
  They are one page reached three ways — already reported by
  `sitemap-redirects` — and billing it twice charged the operator twice for one
  defect.
- **Both canonical checks looked up the wrong URL.** Keying on `canonical_url`
  collides, because several requests land on one destination and the map keeps
  whichever came last; a page redirecting *to* `/login/` shadowed the real
  `/login/`. Six pages were told their canonical redirects when it does not.
  "Does this URL redirect?" is a question about the **requested** URL.

Both are pinned as regression tests.

Six of the nine ship untriggered against the corpus, recorded in the tracker. The
three `robots` checks were proven to fire against a synthetic `robots.txt`
through the real CLI first — so the silence is the corpus, not a broken pipe.
That distinction is the whole reason to check: a plumbing bug and a clean site
produce identical output.

The client-name leak test earned its place again, catching a real client domain
in a source comment before it could reach a published tarball.

462 tests, all passing.

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
