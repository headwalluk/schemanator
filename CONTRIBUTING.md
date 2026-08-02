# Contributing

Developer documentation lives in [`docs/dev/`](./docs/dev/):

- **[Getting started](./docs/dev/getting-started.md)** — clone, install, run, and
  what to check before you commit.
- **[Writing tests](./docs/dev/writing-tests.md)** — the layout, the four kinds
  of test here, and how to add one.
- **[Adding a check](./docs/dev/adding-a-check.md)** — the full loop, including
  the shakedown that catches what review does not.

Source comments cite `dev-notes/NN` here and there. That is an internal design
archive which is **not published with this repository** — it names real client
sites alongside their defects. Nothing depends on having it: every citation
states its substance inline. See
[the note in `docs/dev/`](./docs/dev/README.md#a-note-on-dev-notes-citations).

## Three things worth knowing before you start

**Repetition is normal; divergence is the bug.** SEO plugins repeat identical
entity nodes on every page by design. Flagging that makes the tool worthless.

**Never crawl a third-party site to test a change.** The fixture corpus in
`test/fixtures/` exists so you never have to. Live crawls are for deliberate
validation against sites you own or have permission for.

**Politeness is not optional.** This tool fetches other people's websites. Every
default errs slow, and none of them are yours to speed up.
