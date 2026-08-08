# Getting started

## Requirements

**Node.js 22.18 or later.** That is where TypeScript type stripping runs without
a flag, which is why a checkout has no build step and no bundler.

The *published package* only needs Node 22 — it ships compiled JavaScript. The
two floors are deliberately different, and `test/packaging.test.ts` asserts both.

```sh
node --version        # must be >= 22.18
```

## Clone and install

```sh
git clone ssh://git@headgit.net:7652/headwall/schemanator.git
cd schemanator
npm install
node ./src/cli.ts --version
```

That last line should print a bare version number and nothing else:

```
1.0.0
```

If it prints a stack trace about an unknown option, your checkout predates
`--version`. If it fails to parse the file at all, your Node is older than 22.18.

Running `.ts` directly is not a trick or a wrapper — Node strips the types
itself. There is no `tsx`, no `ts-node`, and nothing to build before the CLI
works.

## Run it

```sh
node ./src/cli.ts --help
```

Then, against the fixture corpus rather than anybody's real website:

```sh
npm test
```

**Do not crawl a third-party site to test a code change.** The fixture corpus
exists precisely so you never have to, and pointing the crawler at somebody's
server to check whether your refactor compiles is how a hosting company's IP
range gets flagged. Live crawls are for deliberate validation runs against sites
you own or have permission for.

## Working against real markup, without the network

The interesting command during development is `analyse`. It re-runs extraction
and every check against **stored HTML** from a previous crawl, so a rule change
can be evaluated against real sites in seconds and with zero requests:

```sh
node ./src/cli.ts analyse <site> --site <site> --work-dir work
```

That is what makes the shakedown affordable, and the shakedown is what catches
the false positives that review does not. See
[adding a check](./adding-a-check.md).

## The four commands you will actually use

| Command | What it does |
| --- | --- |
| `npm test` | The whole suite. ~17 seconds |
| `npm run typecheck` | `tsc --noEmit`. Strict, plus `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes` |
| `npm run build` | Emit `dist/`. Only needed when touching packaging |
| `tools/shakedown.sh --detail` | Every check against all crawled sites. No network |

## Before you commit

```sh
npm run typecheck && npm test
```

Both must pass. If you touched a check, run the shakedown as well and **read the
findings** — not the tally.

There is no CI yet, so this is genuinely the gate rather than a formality.

## Project layout

```
src/
  cli.ts            Argument parsing and command dispatch
  pipeline.ts       crawl -> extract -> check -> report
  analyse.ts        Re-run extraction and checks against stored HTML
  runtime.ts        Runtime mode, paths, version
  crawl/            Seeding, politeness, frontier, sitemaps, robots
  net/              The fetcher, and nothing else that touches the network
  extract/          HTML -> nodes.jsonl. JSON-LD expansion and flattening
  checks/           The 30 checks, the framework they share, the entity graph
  report/           report.json, the markdown renderer, cross-run diffing
  store/            The work directory and its manifest
  url/              Canonicalisation. Load-bearing; see below
data/               Runtime data files. The tool cannot start without these
docs/               Operator documentation, published
docs/dev/           This
dev-notes/          Design notes. Internal, never shipped
test/               Cross-cutting tests; unit tests sit beside their source
tools/              Development scripts, not shipped
work/               Crawl output. Gitignored — other people's website content
```

### Two directories to be careful with

**`work/`** holds other people's website content. It is gitignored and must stay
that way.

**`src/url/canonical.ts`** decides whether two spellings of a URL are the same
page. The whole tool is about identity, so a change here can turn every finding
on every site into a phantom. It has its own test suite for that reason, and the
things it deliberately does *not* normalise — trailing slash, `www` versus bare
host, `http` versus `https` — are divergences the tool exists to report. Leave
them alone.
