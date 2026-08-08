# Adding a check

The loop that has actually been working. Six classes of false positive have been
caught this way across three sessions, and **not one was visible from reading the
code** — which is the entire argument for doing it in this order.

## 0. Look at the markup first

Before writing anything, find out what the thing you are about to check actually
looks like in the wild. `work/*/graph/nodes.jsonl` is the corpus and it is plain
JSONL, so a throwaway script answers most questions in a minute.

This is not diligence theatre. Surveying breadcrumb markup before writing the
breadcrumb checks turned up that **1,545 of 4,777 crumbs carry no `item`**, and
that every one of those is the final crumb — the current page, which needs no
link. A check written from the specification alone would have fired on 18 of the
18 sites that carry breadcrumbs.

Questions worth answering before you write a rule:

- What shapes does this property actually arrive in? (Literal? `{"@id"}`? A
  reference to a node?)
- How often is it absent, and is the absence meaningful or normal?
- Is the thing you are about to call an error something every generator does?

## 1. Write the check

Checks live in `src/checks/`. Small related ones share a module —
`structure.ts` holds seven — and a group large enough to need its own file gets
one, as `breadcrumb.ts` and `google.ts` did.

If the rule is really a *table* — a policy that will be edited more often than
the code reading it — put the table in `data/` and keep the module to the
mechanism. `cardinality.ts`, `hierarchy.ts`, `values.ts` and `google.ts` all
work this way, and each validates its file strictly on load: a typo that
silently degraded a rules file to "nothing is required" would produce a clean,
confident, empty report, which is the worst failure available to a tool whose
output people act on.

A check is a pure function over the graph plus page records:

```ts
const myCheck: Check = {
  id: 'group.name',           // kebab-case, stable forever
  group: 'group',
  run({ graph, pages, hierarchy, partialCoverage }) {
    return [ /* findings */ ];
  },
};
```

Export it from the module's array and add that array to `ALL_CHECKS` in
`run.ts`.

**The id is permanent.** It appears in finding ids, in `--disable`, and in
cross-run diffs, so renaming one breaks a user's history. Choose carefully once.

### What the framework gives you

`src/checks/framework.ts` — `Finding`, `findingId()`, `provenanceOf()`,
`indexPagesById()`. Import from there, not from `run.ts`, which imports every
check module and would be circular.

### Two traps in `EntityGraph`

Both cost a shakedown round to find, so they are worth knowing up front:

- **`graph.index` is deduplicated by `@id`.** A named node repeated across 150
  pages collapses to one entry. It is right for *following a reference* and
  wrong for anything counting, scanning or collecting — use **`graph.allNodes`**
  for those.
- **`graph.referenced` excludes url-valued properties on purpose**, because
  counting them raised 38 false dangling references. If your question is "is
  anything at all pointing at this node?", you want **`graph.referencedAnywhere`**
  instead.

## 2. Obey the rules that make the tool usable

The short version, all six learned the hard way. Full detail, with the corpus
evidence behind each, is in the internal design archive (`dev-notes/04`) — see
[the note on citations](./README.md#a-note-on-dev-notes-citations):

1. **A reference is not an observation.** `{"@id": …}` as a property value is a
   pointer, not a statement. Ignoring this turned 3 findings into 15.
2. **Repetition is silence; only divergence speaks.** Byte-identical sitewide
   nodes are how every SEO plugin works.
3. **An absence claim is only as good as the coverage.** If your check asserts
   something is missing, gate it on `partialCoverage` — and be honest about what
   "complete" means. It means "we fetched everything we discovered", *not* "we
   saw every URL on the site". Reading it as the latter produced a report saying
   four live pages did not exist.
4. **A label is not a description.** Breadcrumb crumb text is not the entity's
   name — 56 false contradictions on one site.
5. **One root cause is one finding.** Supply a `pattern`, and findings sharing
   one collapse above a threshold of 3. 28 findings from one generator behaviour
   still invite 28 unnecessary edits.
6. **Compare what a value denotes, not how it is labelled.** Use `denote()`.

## 3. Write the tests

See [writing tests](./writing-tests.md). At minimum: one test that it fires when
it should, and one that it does *not* fire on the normal case you found in
step 0.

## 4. Shake it down — and read every finding

```sh
tools/shakedown.sh --detail
```

22 sites, no network, about a minute.

**A tally is not a shakedown.** The count tells you nothing about whether the
findings are *right*, and every false positive found so far looked perfectly
reasonable in the summary line. Read them. For each one, ask whether you would
be comfortable sending it to the site's owner.

What this has actually caught:

| Check | What the reasonable-looking rule did |
| --- | --- |
| `graph.orphan-node` | 1,480 findings, every one a page subject |
| `breadcrumb.broken-trail-item` | Called four live pages non-existent |
| `coverage.type-gap` | *"1 of 25 pages carry no `Thing`"* |
| `breadcrumb.inconsistent-depth` | Billed twice for one repeated crumb |

**A check that fires on nothing has not been validated, only untriggered.** That
is an acceptable outcome — `graph.orphan-node` is deliberately silent across the
whole corpus, because narrowing it correctly left nothing to report — but it has
to be a decision you record, not one you discover later.

## 5. Update the documentation

Three places, and a test enforces the first two:

- **`docs/checks.md`** — a `### \`group.name\` — Severity` write-up. Say what it
  reports, why it matters, and how to fix it. `docs-consistency.test.ts` fails if
  a built check is undocumented, or a documented check is not built.
- **`dev-notes/04-check-catalogue.md`** — the design entry, with the corpus
  evidence. **If the shakedown made you narrow the rule, write down what the
  wide version did and how many times.** That paragraph is the only thing
  standing between your fix and somebody re-widening it in six months.
- **`CHANGELOG.md`**.

## 6. Check in

```sh
npm run typecheck && npm test
```

Then update the README's check count and test count badges if they moved.
