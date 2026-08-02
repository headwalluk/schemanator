# Writing tests

`node:test` and `node:assert/strict`. No framework, no runner config, no mocking
library. Run everything with:

```sh
npm test
```

Run one file while you work on it:

```sh
node --test src/checks/breadcrumb.test.ts
```

## Where a test goes

**Unit tests sit beside the code they test**, as `<name>.test.ts`. A test for
`src/checks/breadcrumb.ts` is `src/checks/breadcrumb.test.ts`.

**`test/` is for tests that do not belong to one module** — end-to-end crawls,
and the consistency tests that hold the documentation and the packaging honest.

Everything under `src/**/*.test.ts` is excluded from `dist/` by
`tsconfig.build.json`, so tests never end up in the compiled output.

## The four kinds of test here

### 1. Unit tests over pure functions

Most of the suite. Checks are pure functions over a node graph plus page
records, which is what makes them cheap to test — no I/O, no fixtures on disk,
no network.

The pattern in every check test file is a `node()` and a `page()` builder, then
a helper that runs the engine and filters to the check under test:

```ts
const only = (check: string, nodes: ExtractedNode[], pages: PageRecord[]) =>
  runChecks({ nodes, pages, partialCoverage: false }).findings.filter(
    (finding) => finding.check === check,
  );
```

**Filter to the check you are testing.** Asserting on the total finding count
couples your test to every other check in the catalogue, and it will break the
next time somebody adds one. That is not hypothetical — it happened when the
catalogue went from 13 checks to 27.

### 2. Tests that pin a false positive

**The most valuable tests in this repository**, and the ones to write first when
you fix a check.

When the shakedown catches a check firing wrongly, the fix is not finished until
a test says *"and this specific thing must never be a finding"*. Write it so it
fails against the old behaviour, and say in a comment what the evidence was:

```ts
test('a final crumb with no item is normal, not a broken trail', () => {
  // 1,544 of the 1,545 crumbs in the corpus that omit `item` are the final
  // one: it is the current page, so it needs no link. Flagging this would
  // fire on 18 of 18 sites carrying breadcrumbs.
  ...
  assert.deepEqual(run(nodes, [page('a')]), []);
});
```

The number matters. *"This would be noisy"* is an opinion; *"this fires on 18 of
18 sites"* is a reason, and it is what stops the rule being re-widened by
somebody who was not there.

### 3. End-to-end crawls against the fixture corpus

`test/crawl.e2e.test.ts`, driven by a local HTTP server:

```ts
import { startFixtureSite } from './fixtures/site.ts';

const site = await startFixtureSite();
try {
  const summary = await runCrawl({ startUrl: site.origin, workRoot, delayMs: MIN_DELAY_MS });
  ...
} finally {
  await site.close();
}
```

`test/helpers/server.ts` builds a server from a route map, where a route is
either a fixed response or a function of `(request, hitCount)` — which is how
the 429-then-succeed and redirect-chain cases are written.

`test/fixtures/site.ts` assembles those into a site with the nasty cases already
present: robots exclusions, a redirect chain, a 404, a non-HTML response, a
sitemap index, and a URL advertised under two spellings.

Two rules:

- **Always `close()` the server in a `finally`.** A leaked listener hangs the run.
- **Use `MIN_DELAY_MS`**, or every test pays the 1-second politeness delay.

If you need a new fixture page, add it to `test/fixtures/site.ts` rather than
standing up a second server — one corpus that everything shares is why these
tests stay fast.

### 4. Consistency tests

These exist because prose describing a feature reads exactly the same whether or
not the feature exists. They are cheap and they have already caught real drift.

- **`test/docs-consistency.test.ts`** — every built check is documented, every
  documented check is built, nothing in "Not yet implemented" quietly got
  implemented, every CLI flag in `usage.md` exists, and the README test-count
  badge has not fallen behind.
- **`test/packaging.test.ts`** — `dev-notes/` never ships, `data/` always does,
  `bin` points at `dist/` rather than the TypeScript source.

If you add a check, a flag or a shipped file, one of these will tell you what
else needs updating. That is the point of them.

## Conventions

- **`assert/strict`.** Never the loose variants.
- **Name the behaviour, not the function.** `'a root-relative @id is NOT a
  finding'` beats `'relativeId returns empty'` — the first survives a rename and
  tells the next reader why the test exists.
- **Say why in a comment when the answer is surprising.** Especially for a test
  asserting that something is *not* a finding, since the natural reading of an
  empty assertion is that nothing was tested.
- **No snapshot tests.** A snapshot that changes is indistinguishable from a
  snapshot that broke, and finding text is edited often.
- **No network, ever.** Not in unit tests, not in e2e tests. If a test needs a
  server, start one locally.

## Keeping the badge honest

The README carries a test count, and a test asserts it has not fallen behind:

```sh
cat $(find src test -name '*.test.ts') | grep -c "^test("
```

Update the badge in `README.md` when you add tests. The assertion is a floor
rather than an equality, so loop-generated cases do not break it.
