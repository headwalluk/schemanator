# Using schemanator with an AI agent

The report is designed to be handed to a coding agent. It states the *expected*
value rather than only the discrepancy, carries provenance down to the JSON
pointer, and names trade-offs where the tool genuinely cannot decide — all so an
agent has something to act on rather than something to guess at.

A whole report for a 120-page site is around 10 KB of markdown. That fits in any
model's context with room to work.

## Split the crawl from the analysis

**This is the pattern to use.** Crawl yourself; let the agent analyse.

```sh
# You, in a terminal — slow, network-bound, polite
schemanator crawl example.com
```

```
# The agent, afterwards — offline, seconds, repeatable
schemanator analyse example.com
```

Since 1.4.0 the agent can start the crawl itself and poll for it:

```sh
schemanator crawl example.com --detach     # returns at once
schemanator status example.com --json      # poll .statuses[0].running == false
schemanator analyse example.com            # then read the report
```

Poll **`running`**, not `state`. A crawl whose process was killed keeps
`state: "crawling"` — that is what it was doing when it stopped — while
`running` goes `false`, so an agent waiting on `state` waits forever. And use
`--json`: the plain-text output is for people and its layout is not a contract.

`--detach` exists because of the first reason below and removes it. The other
two still stand, so handing the crawl to a human remains a perfectly good
answer.

Three reasons, and only the first is about convenience:

- **`crawl` is slow by design.** One request per second, per host. The default
  100 pages takes under two minutes, but a raised `--max-pages` scales straight
  off that rate — 500 pages is nine minutes, which is longer than most agent
  shell tools will wait before timing out.
- **`analyse` is offline and idempotent.** It re-reads stored HTML, so the agent
  can run it as often as it likes, with different `--disable` flags, without
  touching anybody's server again. Note that an unrecognised `--disable` value
  is an **error**, not a no-op: it exits `1` before doing any work, and names
  the nearest real check or group. Until 1.13.0 it was accepted in silence and
  reported back as disabled, which is worse — the report then agrees with a
  mistake the caller cannot see.
- **It keeps the agent away from the one command that fetches other people's
  websites.** Politeness is the tool's responsibility, but an agent in a retry
  loop is a good way to undo it.

**Only one crawl runs at a time.** A second start exits **4** — distinct from
`1` so the agent can tell "wait and retry" from "stop and look" without reading
the message. Retry on 4; investigate on 1. The limit is politeness rather than
bookkeeping: the polite queue governs a single process, and sites often share
hosting, so concurrent crawls of different sites can still hammer one network.

`analyse` during a live crawl warns and proceeds. That is deliberate — it
reports only what has been stored so far, and `coverage.complete` says so — but
poll `status` rather than analysing repeatedly, or the agent reasons about a
half-crawled site as though it were the whole one.

## The pitfall: sandboxed agents cannot see your work directory

If you crawl in a terminal and then start the agent as a **sandboxed desktop
application**, the agent may not be able to read what you crawled. Output goes to
`$XDG_STATE_HOME/schemanator` — usually `~/.local/state/schemanator` — and
sandboxed apps are frequently denied access to `~/.local` and to arbitrary paths
outside a project directory.

The symptom is confusing, because nothing is broken: `analyse` reports that it
cannot find the site, or finds it and reports zero pages, and the agent
reasonably concludes the site has no structured data.

**This is not schemanator's problem to solve, and it will not try.** But it is
worth knowing, because it looks like a tool bug.

The fix is to put the work directory somewhere the agent can reach:

```sh
# Crawl into a path inside the project the agent has access to
schemanator crawl example.com --work-dir ./audit

# The agent then reads the same path
schemanator analyse example.com --work-dir ./audit
```

Or set it once for both:

```sh
export SCHEMANATOR_WORK_DIR=./audit
```

If the agent runs on a **different host** from the crawl, the work directory has
to be copied across, or the crawl has to happen there. There is no remote mode.

## The page as a machine sees it

Extraction writes `pages/<page-id>/content.md` beside the stored HTML: the page
with site chrome removed, as markdown.

It exists because *"here is the report, and here is what the page actually looks
like to a machine"* is a much stronger pairing than either alone. Nothing in the
check layer reads it — the tool has no opinion about whether your copy is any
good — but the operator and their agent often do, and this is the artefact that
makes that question answerable.

Chrome is removed two ways, neither of them a guess:

- **By declaration.** Anything inside `<nav>`, `<header>` or `<footer>`.
- **By measurement.** A block of text appearing on 80% or more of the crawled
  pages is site furniture. That needs the whole site, which is why a per-page
  tool cannot do it — and why a small `--max-pages` weakens it.

It costs about 2.5% of the stored HTML, and **`purge --html` keeps it**. So
reclaiming disk still leaves the readable content behind.

## Giving the agent the JSON instead

`--json` emits the machine-readable contract, which is better if the agent is
filtering or aggregating rather than reading:

```sh
schemanator analyse example.com --format json    # or --json, the alias
```

Pin against `report_schema`, which is an integer and bumps on any breaking
change. Full shape in [understanding the report](reports.md#the-json-contract).

For a fleet, this is the useful shape — one line per site, no prose:

```sh
for SITE_NAME in $(cat sites.txt); do
    schemanator analyse "${SITE_NAME}" --json --quiet \
    | jq -c --arg site "${SITE_NAME}" '{site: $site, errors: (.summary.by_severity.error // 0)}'
done
```

## What to tell the agent

Worth putting in the prompt, because they are the two things an agent will
otherwise get wrong:

**Absence of a finding is not always evidence of health.** Some checks are
narrow enough that they fire rarely or not at all, and a report with no
`graph.orphan-node` finding does not mean the graph was audited for orphans and
found clean. `summary.checks_run` lists what actually ran.

**The evidence under a finding is a sample, and it says so.** `observed` lists
at most ten rows and `omitted_count` says how many it did not list — so a
finding reading `omitted_count: 140` has 150 affected subjects, not the ten you
can see. An agent that works through the visible rows and reports the job done
has fixed a fifteenth of it. Where the full set matters, `pages_affected` is the
count and `pages.jsonl` has the pages; the rows beyond the cap are not recorded
anywhere, deliberately, so that a report about an 8,000-page site stays a
readable document.

Each row splits into an identifier and an annotation: `value` is the URL, `@id`
or title — the thing to match on — and `detail` is prose about it, such as
*"23 KB, 400 words"*. Match on `value`; never parse `detail`.

**Coverage qualifies every absence claim.** If `coverage.complete` is `false`,
any finding asserting something is missing may simply be describing a page that
was never fetched. Findings carry `coverage_qualified` for exactly this, and the
markdown report leads with a warning when it applies.

**A `google.missing-recommended` finding is not a work order.** This is the one
that will bite, because the group reads like a checklist and an agent that fixes
markup can satisfy every item without leaving the file.

`Product omits review` means *no review is marked up*. It does not mean a review
exists and the markup forgot it. Writing a `Review` node, or an
`aggregateRating` of 4.8 from 127 ratings, makes the finding disappear and the
markup false — and fabricated review markup is a Google guidelines violation
that risks a manual action against the whole site. A business rating itself is
ineligible for stars however the markup is written, so the fabrication does not
even buy the result it was invented for.

Every finding in that group carries a `tradeoff` field saying so. **Treat it as
a hard precondition:** act on these only where the underlying fact already
exists somewhere on the site, and where it does not, report the gap to a human
rather than closing it.

The two error checks — `google.missing-required` and
`google.incomplete-alternative` — are safer, but the same test applies. An
`Event` with no `location` needs the real venue, not a plausible one.

## The fix-and-verify loop

The loop the tool is built around, with the agent doing the middle step:

```sh
schemanator crawl example.com                    # you
schemanator analyse example.com > report.md      # you or the agent
                                                 # agent fixes the markup
schemanator crawl example.com                    # you, again
schemanator analyse example.com --since last     # proof it landed
```

`--since` matches findings by an id naming **the question asked, not the
answer**, so a contradiction fixed on 95 of 100 pages shows as one *Changed*
finding rather than one resolved plus one new. That distinction is what stops an
agent reporting success and regression at the same time for a single improvement.

Keep `--max-pages` consistent between the runs you intend to compare. The diff
warns when coverage dropped enough to make the comparison unsound, because
findings can otherwise appear resolved simply because the evidence was not looked
at.

## What it cannot tell you

Worth stating in the prompt, so the agent does not invent it:

- **It sees HTML, not your source code.** A finding points at a page, a block and
  a JSON pointer. It cannot point at a line of a theme file or a PHP function,
  and it does not guess.
- **It does not execute JavaScript.** Structured data injected by a tag manager
  or a review widget is invisible, and a report saying "no `Product` found" would
  be wrong on a site that injects `Product` client-side.
- **It never fetches off-site media.** `url.foreign-media-host` reports that your
  images depend on somebody else's server; it does not and cannot tell you
  whether they still resolve.
- **It cannot read the page.** The `google` group knows a `Product` node has no
  `review` property. It has no idea whether the page displays fifty customer
  reviews the markup never captured, or whether the product has never been
  reviewed by anyone. Those need opposite fixes, and only a human — or an agent
  that has actually looked at the rendered page — can tell them apart.
- **It does not check whether Google agrees.** These are Google's documented
  requirements applied offline. Eligibility also depends on content quality,
  policy and indexing, so a clean `google` group is a necessary condition for a
  rich result, never a sufficient one. Confirm with the Rich Results Test before
  telling anyone the problem is solved.
