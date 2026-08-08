# schemanator

[![npm](https://img.shields.io/npm/v/@headwall/schemanator)](https://www.npmjs.com/package/@headwall/schemanator)
[![licence](https://img.shields.io/npm/l/@headwall/schemanator)](LICENSE)
[![node](https://img.shields.io/node/v/@headwall/schemanator)](https://nodejs.org/)
[![tests: 363](https://img.shields.io/badge/tests-363-success)](#)
[![checks: 30](https://img.shields.io/badge/checks-30-blue)](docs/checks.md)

**Whole-site structured-data integrity checking.** Crawls a site, reconstructs
its structured-data graph across every page, and reports the contradictions that
per-page validators are architecturally incapable of seeing.

```sh
npx @headwall/schemanator example.com
```

## The gap it fills

Every structured-data tool on the market validates **one document at a time**.
validator.schema.org and Google's Rich Results Test take a single page.
Screaming Frog and Sitebulb crawl, then validate per URL — one row per page, a
shape that cannot express *"the `Organization` on page A contradicts the one on
page B."* Schema App and WordLift build entity graphs, but they are generators,
not auditors of markup you already have.

Nobody reconciles an existing graph. That gap is structural, not accidental.

It matters most for **hybrid markup**: hand-written JSON-LD layered over
plugin-generated JSON-LD, two sources describing one business, never reconciled,
each individually valid. Increasingly common as sites outgrow what their SEO
plugin emits.

### And the per-page gaps, while it is in there

Whole-site reconciliation is the reason this exists, but the crawl has already
read every node by the time it runs — so the [`google`](docs/checks.md#google--googles-rich-result-requirements)
group also reports the rich-result fields Google requires and recommends. Those
are the warnings Search Console shows you *after* it has crawled you, aggregated
by item type, with no pointer to the block they came from.

Same findings, before deployment rather than weeks after it, across the whole
site at once, and traced to the exact node. It is not a rich-results previewer
and it does not re-implement vocabulary validation — validator.schema.org is free
and already does that.

## The rule that makes it usable

**Repetition is normal; divergence is the bug.**

An SEO plugin repeats a byte-identical `Organization` node on all 200 pages of a
site. That is correct behaviour. A tool that reports it as "duplicate `@id`
across 200 URLs" is uninstalled within one session.

- Same `@id`, identical node → **silence**.
- Same `@id`, divergent properties → **error**, with a property-level diff and
  the exact source location.

Getting that discrimination right *is* the product. Everything else is crawling
and plumbing.

## Who it is for

- **Agencies and hosts** auditing a fleet of client sites, where the same
  misconfiguration tends to repeat across many of them.
- **Site owners** whose markup comes from more than one source — a plugin, plus
  a theme, plus something hand-written — who want to know whether those sources
  agree.
- **Anyone handing structured-data problems to a coding agent.** The report is
  machine-readable by design, states the expected value rather than only the
  discrepancy, and carries provenance down to the JSON pointer.

It is **not** a schema generator, not a rich-results previewer, and not a
general SEO crawler. It audits what is there and never writes markup.

## Example finding

```
### 1. url has 2 different values under one @id

- Check: entity.contradiction  •  Severity: Error
- Subject: https://example.com/#organization
- Pages affected: 150

The same @id carries 2 different values for url across 150 observations on
150 pages. Nothing reconciles these, so a consumer's view of the entity
depends on which page it saw.

Observed:
- https://example.com/about/ — on 120 page(s)
    json-ld block 0, pointer /5
- https://example.com/ — on 30 page(s)
    json-ld block 0, pointer /4
```

Every one of those pages passes validator.schema.org individually.

## Documentation

| | |
| --- | --- |
| [Installation](docs/installation.md) | Requirements, `npx`, installing locally |
| [Usage](docs/usage.md) | Commands, options, and the fix-and-verify workflow |
| [Understanding the report](docs/reports.md) | What each part means, and the JSON contract |
| [The checks](docs/checks.md) | Every check, what it means, and how to fix it |
| [Configuration](docs/configuration.md) | Config file, environment variables, tuning the rules |
| [Using it with an AI agent](docs/agents.md) | The crawl/analyse split, and the sandbox pitfall |
| [Politeness](docs/politeness.md) | What it does to the servers it crawls |

Working on schemanator rather than with it? See
[`docs/dev/`](docs/dev/) — [getting started](docs/dev/getting-started.md),
[writing tests](docs/dev/writing-tests.md), and
[adding a check](docs/dev/adding-a-check.md).

## Licence

[AGPL-3.0-or-later](LICENSE). The bundled schema.org vocabulary derivatives in
`data/` are CC BY-SA 3.0 and are **not** covered by the AGPL — see
[NOTICE](NOTICE).
