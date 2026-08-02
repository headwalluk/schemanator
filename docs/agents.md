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

Three reasons, and only the first is about convenience:

- **`crawl` is slow by design.** One request per second, per host. A 500-page
  site takes nine minutes, which is longer than most agent shell tools will wait
  before timing out.
- **`analyse` is offline and idempotent.** It re-reads stored HTML, so the agent
  can run it as often as it likes, with different `--disable` flags, without
  touching anybody's server again.
- **It keeps the agent away from the one command that fetches other people's
  websites.** Politeness is the tool's responsibility, but an agent in a retry
  loop is a good way to undo it.

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

**Coverage qualifies every absence claim.** If `coverage.complete` is `false`,
any finding asserting something is missing may simply be describing a page that
was never fetched. Findings carry `coverage_qualified` for exactly this, and the
markdown report leads with a warning when it applies.

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
