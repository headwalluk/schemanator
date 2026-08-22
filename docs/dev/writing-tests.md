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
catalogue went from 13 checks to 27, and again when group `google` arrived: a
test about type refinement began failing because its fixture was a
`LocalBusiness` with one property, which the new group correctly has plenty to
say about.

The fix there was to disable the noisy group in the shared helper rather than to
weaken the assertion — see the comment on `run` in `checks/run.test.ts`. A group
whose rules apply to the types fixtures are naturally written in will bury every
other test in the file otherwise.

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

`test/fixtures/site.ts` holds **three** sites, each assembled from those routes
and each with a job of its own:

| Site | Covers |
| --- | --- |
| `startFixtureSite()` | The crawler's nasty cases — robots exclusions, a redirect chain, a 404, a non-HTML response, a sitemap index, a URL advertised under two spellings |
| `startLinkGraphSite()` | A link graph that disagrees with its sitemap: a noindexed hub, unlisted pagination, an orphan, and an asset link the hop must not fetch |
| `startDefectSite()` | One deliberate defect per check that had never fired on anything real, plus the near misses each must stay *silent* on |

Two rules:

- **Always `close()` the server in a `finally`.** A leaked listener hangs the run.
- **Use `MIN_DELAY_MS`**, or every test pays the 1-second politeness delay.

**Add your case to the site whose semantics it already shares; start a fourth
only when it would not fit.** These are separate on purpose rather than by
accident — a dozen tests assert exact counts against each, so a defect added to
one site for another's benefit is a count to re-derive everywhere. `site.ts`
says so at the top of each one, and the reason is worth reading before you pick.

An earlier version of this page said to add pages to the one shared corpus
rather than stand up a second server. That was true when there was one site and
it stopped being true at the second; it is recorded here because a stale
instruction is worse than a missing one — it gets followed.

### 4. Consistency tests

These exist because prose describing a feature reads exactly the same whether or
not the feature exists. They are cheap and they have already caught real drift.

- **`test/docs-consistency.test.ts`** — every built check is documented and
  every documented check is built; every documented check and group can actually
  be `--disable`d; nothing in "Not yet implemented" quietly got implemented;
  every CLI flag in `usage.md` exists; the page cap in the docs is the page cap
  in the code; no document names a client site; and the README badges have not
  fallen behind.
- **`test/packaging.test.ts`** — `dev-notes/` never ships, `data/` always does,
  `bin` points at `dist/` rather than the TypeScript source.
- **`src/checks/sample-caps.test.ts`** — no check truncates a list with a bare
  number, and no check asserts `coverage_qualified: true`. Both are read from
  the source of every check module, because a behavioural version can only see
  the checks a fixture happens to make fire.
- **`src/checks/finding-volume.test.ts`** — no check scales its finding count
  with site size, no observed row claims more pages than the finding containing
  it, and nothing is qualified by coverage on a complete crawl.
- **`src/checks/run.test.ts`** — every `aggregate_title` reads correctly after a
  count.
- **`src/report/contract.test.ts`** and **`test/exit-codes.test.ts`** — the two
  published contracts, pinned so a change has to be a decision.

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
