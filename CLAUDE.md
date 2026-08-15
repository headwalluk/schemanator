# CLAUDE.md

Orientation for Claude Code working in this repo. Project rationale is in
[README.md](./README.md); developer documentation is in [`docs/dev/`](./docs/dev/).

**`dev-notes/` is an internal design archive and is not published with this
repository.** It names real client sites alongside the structured-data defects
found on them, which is what makes it useful while building and what keeps it
private. If you have a checkout that includes it, start at
`dev-notes/00-project-tracker.md` and read the numbered design docs before
writing code.

If you do not have it, nothing here is blocked. Source comments cite it as
`dev-notes/NN`, but those are citations rather than links — every one of them
states its substance inline, because a comment that only points elsewhere is not
worth writing.

## What this is

A whole-site structured-data integrity checker. It crawls a site, extracts every
piece of structured data (JSON-LD, microdata, RDFa), flattens it into a single
node graph, and reports contradictions that only appear when you look at the
whole site at once.

**Current state: the pipeline works end to end.** `schemanator <site>` crawls,
extracts, checks and renders a report; `--since` diffs two runs. All 54 checks in
the catalogue are built. Proven against a 22-site, 1,838-page local corpus.

Outstanding work is the distance between "works" and "shipped" — see
`dev-notes/00-project-tracker.md`, which is the authority on what is left.

## The one rule that matters most

**Repetition is normal; divergence is the bug.** SEO plugins repeat identical
entity nodes on every page by design. Flagging that as duplication makes the tool
worthless. Only *divergence* under a shared `@id` is a finding. Any check you add
must respect this — see README and `dev-notes/04`.

The `google` group is the one place the *conclusion* inverts — a field omitted
on all 250 products is exactly the finding — but the rule itself still holds:
it is reported **once**, because it is one generator setting and one fix.

## Tech stack

Settled and in use. `package.json` is the authority; this is the rationale.

- **Runtime:** Node.js ≥ 22.18, which strips types natively — so there is no
  build step in development. `tsconfig.json` enforces that with
  `erasableSyntaxOnly` and real `.ts` import specifiers.
- **Language:** TypeScript, `strict` plus `noUncheckedIndexedAccess` and
  `exactOptionalPropertyTypes`.
- **Storage:** the filesystem. No database. See `dev-notes/01`.
- **JSON-LD processing:** `jsonld` (jsonld.js) — the reference implementation of
  the expansion and flattening algorithms. **Do not hand-roll these.**
- **HTML parsing:** `cheerio`
- **Sitemaps:** `fast-xml-parser`
- **robots.txt:** `robots-parser`
- **Concurrency/rate limiting:** hand-rolled, not `p-queue`. One polite queue per
  host, see `dev-notes/02`.
- **Microdata:** type-level only, read from `itemtype` attributes rather than
  parsed. The maintained libraries emit RDF quads that cannot satisfy `01`'s
  provenance rule — the tension is documented at the end of `dev-notes/03`.
- **RDFa:** out of scope for 1.0.0. Absent from all 22 corpus sites.

Prefer the boring, mature, proven library over the newer/cleverer one unless
there's a project-specific reason.

## Architecture decisions

- **Filesystem as the database, for now.** Greppable, diffable and inspectable
  beats a schema while the output is still read by humans. Cross-run diffing
  arrived without needing one; a real datastore has still not earned its place.
- **Three-layer extraction.** Verbatim `raw/` → canonical `nodes.jsonl` →
  disposable `by-type/` browsing view. Checks read `nodes.jsonl` only.
  Rationale in `dev-notes/03`.
- **Provenance is mandatory.** Every node records which page, which syntax, which
  block and which JSON pointer it came from. A finding you can't trace back to
  exact source text is unreportable — and unfixable by the user.
- **Directory names are a human affordance; the manifest is truth.** Never derive
  identity from a directory name. `pages.jsonl` is the index. See `dev-notes/01`.
- **URL canonicalisation is a first-class concern**, not a utility detail. The
  whole tool is about identity; if two spellings of one page land in two
  directories, the tool reports phantom contradictions. It gets its own
  test-fixture suite.
- **Politeness is not optional.** This tool fetches other people's sites. Every
  default errs slow. See `dev-notes/02`.

## Non-goals

- **Not a schema *generator*.** It audits what's there. It never writes markup.
- **Not a rich-results previewer.** Google's own tools do that; don't reimplement.
- **Not a vocabulary validator.** Whether a property is legal on a type is
  validator.schema.org's job, and it is free.

  **This is narrower than the rule it replaces, deliberately.** Until 1.3.0 the
  non-goal read "not a per-page validator", and justified it by attributing
  Google's rich-result requirements to validator.schema.org — which does not
  check them and never has. Those requirements are a *publisher policy* on top
  of the vocabulary, and the only things applying them are Search Console, after
  the fact, and the Rich Results Test, one URL at a time.

  So the `google` group checks them, per page, and the boundary that survives is
  the one above: vocabulary validity and previews stay out. See `dev-notes/04`
  for the reasoning and the corpus evidence.
- **Not a general SEO crawler.** No title-tag/meta-description/h1 auditing —
  Screaming Frog owns that and does it well. Structured data only.
- **Not a rank tracker, not a site monitor.**
- **No speculative extensibility.** Don't build config surfaces, plugin systems
  or abstraction layers ahead of a real second caller. The one seam that exists
  on purpose is `origin: "check"` on a finding, so a later analysis pass can add
  findings without a schema break.

## Coding standards

### No magic numbers. No magic strings for identifiers.

**An identifier that two pieces of code must agree on gets named once and
imported.** Check ids, group names, exit codes, severities, property and type
IRIs, file names under `data/`, JSON keys that form a contract. These are things
a *caller* depends on — `--disable <group>`, `finding.check` in the JSON, an exit
code in somebody's shell script — so a second spelling is not a duplicate, it is
a second version of the contract waiting to disagree with the first.

The failure is quiet, which is what makes it worth a rule. Exit codes were bare
numbers across sixteen `return`s and a six-branch ladder until 1.3.1; the docs
described them correctly by luck, and one error class had an exit code nobody had
chosen. `google.ts` shipped in 1.3.0 with each check id written twice.

**Literal human-readable text is fine anywhere, and hoisting it is worse.**
Finding titles, summaries, remediation prose, log lines, error messages, `--help`
output. That text is read by a person, not matched by a program, and it reads far
better next to the logic it describes than three files away behind a constant
name. Do not build a message catalogue.

The test is *"would a typo here be caught by a human reading the output, or would
it silently change behaviour?"* Prose fails loudly to a reader. An identifier
fails silently to a machine.

### Named constants carry their evidence

A threshold is a decision, so the constant records why the number is what it is —
`AGGREGATE_THRESHOLD`, `TYPE_GAP_MIN_GROUP`, `TYPE_GAP_MAJORITY` all do. A bare
`10` in a condition is a decision nobody can review and nobody dares change.

### Every file in `data/` gets a loader that throws

`data/` holds **rules, not configuration** — which properties are functional,
which values are placeholders, what Google requires. A loader that shrugs at a
malformed file does not fail: it produces a clean, confident, empty report,
which is the worst outcome available to a tool whose output people act on.

So each file has a `parse*` function that validates strictly and throws, naming
the file and the offending key, because these are edited by hand and an error
saying only "invalid" sends someone hunting. `data-files.test.ts` enforces it —
a new file fails the suite until it has a parser or a written exemption.

### `report.json` is a published contract

Consumers are told to pin `report_schema`, and `docs/reports.md` promises it
bumps on any breaking change. Removing or renaming a key, changing a type, or
making a guaranteed key optional is breaking and needs the bump; **adding** a key
is not. `report/contract.test.ts` pins the shape, so a change has to be a
decision rather than a side effect.

Exit codes are the same kind of contract, for the same reason: a caller branches
on both without reading any prose.

### Prefer a test over a convention

Prose describing a rule reads exactly the same whether or not the code follows
it — this repository has shipped that failure more than once. Where an invariant
can be asserted, assert it: `docs-consistency.test.ts` and `exit-codes.test.ts`
exist precisely so these standards are enforced rather than remembered. **Adding
a standard means asking what test would catch its violation.**

**Prettier and ESLint are configured and enforced** — M6, landed 2026-08-09.
`npm run format` writes, `npm run format:check` and `npm run lint` verify, and
both run in `prepublishOnly`. Do not hand-match the surrounding file's style;
run the formatter.

They complement these tests rather than replace them. A linter enforces *shape*;
`docs-consistency`, `exit-codes`, `contract` and `data-files` enforce *meaning*,
and no rule set was ever going to catch "this documented check does not exist".

### Naming

- **TypeScript:** `camelCase` for values and functions, `PascalCase` for types
  and classes, `SCREAMING_SNAKE_CASE` for module-level constants.
- **The global ALL-CAPS variable rule is for shell scripts only.** It does not
  apply to TypeScript, and applying it there would fight every convention in the
  file. See `## Conventions` below.
- Check ids and group names are `lower-kebab.dotted`, and **an id must begin with
  its own group** or `--disable <group>` silently misses it. Tested.

## Conventions

- `dev-notes/` is internal planning for whoever is building this. `docs/` is for
  operators. **Don't cross the streams** — and note `dev-notes/` names real
  client sites and their defects, whereas `docs/` is written to be published, so
  nothing from one may leak into the other.
- Open design questions are tracked in `dev-notes/00-project-tracker.md` next to
  the milestone that resolves them. **If you resolve one, update it there.**
- `work/` is runtime crawl output — gitignored, never committed. It contains
  other people's website content.
- Never default to common ports (3000, 8000, 8080, 8443, 9000). The dev host runs
  many services full-time.
- Shell scripts follow the global style: long ALL-CAPS variable names, braced
  expansions, single-exit functions.
- Don't crawl a third-party site to test a code change. Use the local fixture
  corpus (`dev-notes/02`). Live crawls are for deliberate validation runs only.
