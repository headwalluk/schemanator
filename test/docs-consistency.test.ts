/**
 * Documentation must describe what the tool does.
 *
 * This exists because the same bug shipped twice in one day: `docs/checks.md`
 * documented eight checks that did not exist, and `docs/configuration.md`
 * documented a config file that is never read. Both were written from the
 * design notes rather than from the code.
 *
 * The failure mode is silent — **prose describing a feature reads exactly the
 * same whether or not the feature exists** — so neither was caught by rereading
 * it. Both were caught by checking against the code, which is a job for a test
 * rather than for diligence.
 *
 * This catches only the mechanical cases. It cannot tell you the prose is
 * *right*, only that the names line up.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ALL_CHECKS, DISABLEABLE, EMITTED_CHECK_IDS } from '../src/checks/run.ts';
import { DEFAULT_MAX_PAGES } from '../src/crawl/run.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative: string): string => fs.readFileSync(path.join(ROOT, relative), 'utf8');

/**
 * Every markdown file under `docs/`, at any depth.
 *
 * Recursive rather than a flat `readdirSync`, which broke the moment
 * `docs/dev/` was added — and would have broken *silently* had it only been
 * skipping files rather than throwing on the directory. A leak check that
 * quietly stops covering a subdirectory is worse than no leak check.
 */
function docFiles(): string[] {
  return fs
    .readdirSync(path.join(ROOT, 'docs'), { recursive: true, encoding: 'utf8' })
    .filter((name) => name.endsWith('.md'))
    .map((name) => `docs/${name}`);
}

/**
 * Every check id the engine can emit.
 *
 * Read from the engine rather than restated here. This set used to spell out
 * `entity.page-scoped-value` as a literal exception — the id is raised by
 * `entity.contradiction` and is absent from `ALL_CHECKS` by design — which meant
 * the test knew about an emittable id that `--disable` did not. That gap was the
 * bug: the id was documented, appeared in `finding.check`, and could not be
 * disabled.
 */
const BUILT = new Set(EMITTED_CHECK_IDS);

const CHECKS_DOC = read('docs/checks.md');

/** Checks with a full write-up: `### \`id\` — Severity`. */
const DOCUMENTED = new Set(
  [...CHECKS_DOC.matchAll(/^### `([a-z][a-z0-9.-]+)` — /gm)].map((match) => match[1] as string),
);

/** The "Not yet implemented" table, which promises nothing. */
const PLANNED = new Set(
  [
    ...CHECKS_DOC.slice(CHECKS_DOC.indexOf('## Not yet implemented')).matchAll(
      /^\| `([a-z][a-z0-9.*-]+)`/gm,
    ),
  ].map((match) => match[1] as string),
);

test('check ids are unique, well-formed, and prefixed with their own group', () => {
  // Three invariants that are cheap here and expensive to discover in the wild.
  //
  // `docs/dev/adding-a-check.md` calls an id permanent: it appears in finding
  // ids, in `--disable`, and in cross-run diffs. A duplicate would silently
  // collide two checks' finding ids and corrupt a `--since` diff.
  //
  // The prefix rule is the one with teeth. `--disable <group>` matches on
  // `check.group`, while a reader types the group they saw at the front of an
  // id — so a check whose id and group disagree survives being disabled and
  // keeps appearing in a report the operator believes they silenced.
  const seen = new Set<string>();

  for (const check of ALL_CHECKS) {
    // Digits are legal after the first letter: `page.h1-missing`.
    assert.match(
      check.id,
      /^[a-z]+\.[a-z][a-z0-9-]*$/,
      `${check.id} is not a lower-case dotted id`,
    );
    assert.equal(seen.has(check.id), false, `duplicate check id: ${check.id}`);
    seen.add(check.id);
    assert.equal(
      check.id.startsWith(`${check.group}.`),
      true,
      `${check.id} is in group "${check.group}", so --disable ${check.group} would not disable it`,
    );
  }
});

test('every built check is documented', () => {
  const missing = [...BUILT].filter((id) => !DOCUMENTED.has(id)).sort();
  assert.deepEqual(missing, [], `built but undocumented: ${missing.join(', ')}`);
});

test('every documented check can actually be disabled', () => {
  // The invariant that was missing on 2026-08-22, and the one that would have
  // caught the bug. `docs/reports.md` tells consumers a check id is stable so
  // they can `--disable` it, and `docs/checks.md` gives each one a write-up —
  // two promises that `--disable` has to keep for every id, not for most of
  // them.
  //
  // Asserted against the documentation rather than against the engine's own
  // list, deliberately. Comparing the engine to itself cannot fail; the
  // catalogue is written by hand and is what an operator reads.
  const undisableable = [...DOCUMENTED].filter((id) => !DISABLEABLE.has(id)).sort();

  assert.deepEqual(
    undisableable,
    [],
    `documented but --disable does not accept it: ${undisableable.join(', ')}`,
  );
});

test('every group named at the front of a check id is disableable', () => {
  // `--disable <group>` is documented in usage.md and checks.md, and a reader
  // types the group they saw at the front of an id.
  const groups = new Set([...DOCUMENTED].map((id) => id.split('.')[0] ?? ''));
  const missing = [...groups].filter((group) => !DISABLEABLE.has(group)).sort();

  assert.deepEqual(missing, [], `documented group cannot be disabled: ${missing.join(', ')}`);
});

test('every documented check is built', () => {
  // The bug this exists for. Operator docs promising checks that never fire is
  // what makes documentation untrustworthy.
  const fictional = [...DOCUMENTED].filter((id) => !BUILT.has(id)).sort();
  assert.deepEqual(fictional, [], `documented but not built: ${fictional.join(', ')}`);
});

test('nothing in "Not yet implemented" has quietly been implemented', () => {
  const stale = [...PLANNED].filter((id) => BUILT.has(id)).sort();
  assert.deepEqual(stale, [], `listed as planned but actually built: ${stale.join(', ')}`);
});

test('the check-group table lists only real groups', () => {
  const groups = new Set(ALL_CHECKS.map((check) => check.group));
  for (const heading of [...CHECKS_DOC.matchAll(/^## `([a-z]+)`/gm)].map(
    (match) => match[1] as string,
  )) {
    assert.equal(
      groups.has(heading),
      true,
      `docs/checks.md documents an unknown group: ${heading}`,
    );
  }
});

test('every CLI flag documented in usage.md exists', () => {
  const cli = read('src/cli.ts');
  const usage = read('docs/usage.md');

  // The options table: | `--flag <arg>` | description |
  const documented = [...usage.matchAll(/^\| `(--[a-z-]+)/gm)].map((match) => match[1] as string);
  assert.equal(
    documented.length > 10,
    true,
    'the options table looks empty — has the format changed?',
  );

  for (const flag of new Set(documented)) {
    const name = flag.slice(2);
    assert.equal(
      cli.includes(`'${name}'`) || cli.includes(`${name}:`),
      true,
      `docs/usage.md documents ${flag}, which parseArgs does not define`,
    );
  }
});

test('every documented environment variable is read somewhere', () => {
  const sources = ['src/cli.ts', 'src/runtime.ts', 'src/net/fetcher.ts', 'src/log.ts']
    .map((file) => read(file))
    .join('\n');

  for (const variable of new Set(
    [
      ...read('docs/configuration.md').matchAll(/^\| `(SCHEMANATOR_[A-Z_]+|LOG_LEVEL|NODE_ENV)`/gm),
    ].map((match) => match[1] as string),
  )) {
    assert.equal(
      sources.includes(variable),
      true,
      `docs document ${variable}, which nothing reads`,
    );
  }
});

/**
 * Sites that must never appear in anything published.
 *
 * Three are deliberately absent — `headwall-hosting.com`, `power-plugins.com`
 * and `vulnz.net` are ours, and naming our own sites in our own evidence is
 * fine. Everything else in the corpus belongs to a client, and naming a client
 * alongside a defect on their site is not ours to do.
 *
 * Case-insensitive, because the leak that got closest was not a hostname at all
 * — it was a client's page title, `"PermaJet Inkjet Paper | FREE NEXT DAY
 * DELIVERY"`, sitting in a source comment as an illustrative example. Client
 * data wears more shapes than a domain.
 */
const CLIENT_NAMES =
  /bravanark|footballinberkshire|rcem\.ac\.uk|permajet|activehands|aurahear|tgfelectrical|intrepiddesign|the-observatory|emdrtherapy|jupiterartland|graphenstone|cheeselogs|clearpipe|heathcote|skintechacademy|burleighdesign|webidaze|ahc\.co\.uk/i;

test('docs never name a real client site', () => {
  // `dev-notes/` names real sites and their defects; `docs/` is written to be
  // published. Nothing may cross.
  for (const file of [...docFiles(), 'README.md', 'CONTRIBUTING.md', 'CHANGELOG.md']) {
    const match = CLIENT_NAMES.exec(read(file));
    assert.equal(match, null, `${file} names a client: ${match?.[0] ?? ''}`);
  }
});

test('no shipped source or data file names a client', () => {
  // `src/` and `data/` both ship — `src/` because AGPL-3.0 requires recipients
  // can obtain the source, `data/` because the tool cannot start without it.
  // Neither can be gitignored, so this is the only thing standing between a
  // client's name and a public repository.
  //
  // Comments in `src/` reach the published tarball three ways: the `.ts` source
  // itself, the compiled `dist/` (TypeScript keeps comments by default), and
  // the source maps.
  //
  // **`test/` is here because the repository is public**, which is a different
  // question from what npm packs. It is absent from the `files` list and still
  // published to everyone, and a fixture written from a real site is exactly
  // where a client name goes unnoticed — this test was extended after one did,
  // in a comment explaining which site had exposed a bug.
  const roots = ['src', 'data', 'test'];
  const offenders: string[] = [];

  for (const root of roots) {
    const entries = fs.readdirSync(path.join(ROOT, root), { recursive: true, encoding: 'utf8' });
    for (const entry of entries) {
      if (!/\.(ts|json)$/.test(entry)) continue;
      const relative = `${root}/${entry}`;
      // This file holds the list of names, so it necessarily matches itself.
      if (relative === 'test/docs-consistency.test.ts') continue;
      const match = CLIENT_NAMES.exec(read(relative));
      if (match !== null) offenders.push(`${relative}: ${match[0]}`);
    }
  }

  assert.deepEqual(offenders, [], `client names in shipped files:\n  ${offenders.join('\n  ')}`);
});

test('nothing published links into dev-notes/', () => {
  // `dev-notes/` is gitignored and absent from the public repository, so a
  // markdown link into it renders as a 404 on GitHub. Plain-text citations
  // (`dev-notes/04`) are fine and deliberate — they are citations, not links,
  // and `docs/dev/README.md` explains that. This catches the linked form only.
  //
  // Only the *path* is inspected, never the fragment: the heading that explains
  // all this anchors as `#a-note-on-dev-notes-citations`, and a naive match over
  // the whole link flagged the very document doing the explaining.
  const LINK = /\]\(([^)#]*)/g;

  for (const file of [...docFiles(), 'README.md', 'CONTRIBUTING.md', 'CHANGELOG.md', 'CLAUDE.md']) {
    const offenders = [...read(file).matchAll(LINK)]
      .map((match) => match[1] ?? '')
      .filter((target) => target.includes('dev-notes'));

    assert.deepEqual(offenders, [], `${file} links into dev-notes/, which is not published`);
  }
});

test('the published surface is covered by the leak check', () => {
  // The check above is only worth as much as the file list it walks. `docs/dev`
  // was invisible to it until the walk became recursive.
  const covered = docFiles();
  assert.equal(covered.length > 5, true, 'the docs walk looks empty — has the layout changed?');
  assert.equal(
    covered.some((file) => file.startsWith('docs/dev/')),
    true,
    'docs/dev/ is published and must be covered by the client-name check',
  );
});

test('the version is not hardcoded anywhere', () => {
  // It used to live in package.json, both report builders and the User-Agent.
  // Bump one and the report claims an old version while the User-Agent claims
  // a third — the same silent-drift class as documentation describing features
  // that do not exist.
  const manifest = JSON.parse(read('package.json')) as { version: string };

  for (const file of [
    'src/analyse.ts',
    'src/pipeline.ts',
    'src/net/fetcher.ts',
    'src/report/build.ts',
  ]) {
    assert.equal(
      /['"`]\d+\.\d+\.\d+['"`]/.test(read(file)),
      false,
      `${file} contains a literal version string; import VERSION from runtime.ts instead`,
    );
  }

  assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
});

test('the documented page cap is the page cap', () => {
  // `--max-pages` went from 500 to 100 in 1.13.0, and the number was written
  // out in five places across three documents and the `--help` text. Every one
  // of them reads perfectly whether or not it matches the code, and an operator
  // who plans a crawl around "stops at 500 pages" gets a fifth of what they
  // budgeted for with no error to tell them why.
  //
  // Each entry is the sentence as it is actually written, not a general pattern
  // — a loose one would either miss a rewording or capture the unrelated
  // numbers in the same paragraphs, and a docs test that quietly matches
  // nothing is the failure it was built to prevent. Hence the count assertion
  // at the end: if a sentence is rephrased, this test fails and gets updated
  // alongside it, rather than passing on zero matches.
  const CLAIMS: Array<[string, RegExp]> = [
    ['docs/usage.md', /Cap the crawl\. Default (\d+)/],
    ['docs/usage.md', /stops at (\d+) pages/],
    ['docs/politeness.md', /^\| Maximum pages \| (\d+) \|$/m],
  ];

  const wrong: string[] = [];
  for (const [file, pattern] of CLAIMS) {
    const found = pattern.exec(read(file));
    if (found === null) {
      wrong.push(`${file} no longer contains ${String(pattern)}`);
      continue;
    }
    if (Number(found[1]) !== DEFAULT_MAX_PAGES) {
      wrong.push(`${file} claims a cap of ${found[1]}`);
    }
  }

  assert.deepEqual(
    wrong,
    [],
    `the default cap is ${DEFAULT_MAX_PAGES} pages — update these, or an operator plans around the wrong number`,
  );

  // The `--help` text carries the same claim, so it interpolates the constant
  // rather than restating it. `MIN_DELAY_MS` set the precedent in the line below.
  assert.equal(
    /Cap the crawl\. Default \d/.test(read('src/cli.ts')),
    false,
    'src/cli.ts hardcodes the page cap in --help; interpolate DEFAULT_MAX_PAGES instead',
  );
});

test('the README test-count badge matches reality', () => {
  // Static badges drift. This one is cheap to keep honest, and a badge that
  // lies about the test count undermines the ones that do not.
  const badge = /!\[tests: (\d+)\]/.exec(read('README.md'));
  assert.notEqual(badge, null, 'the README test-count badge has gone missing');

  const suites = ['src', 'test'].flatMap((dir) =>
    fs
      .readdirSync(path.join(ROOT, dir), { recursive: true, encoding: 'utf8' })
      .filter((name) => name.endsWith('.test.ts'))
      .map((name) => read(path.join(dir, name))),
  );

  const actual = suites.reduce(
    (total, source) => total + (source.match(/^test\(/gm)?.length ?? 0),
    0,
  );
  const claimed = Number(badge?.[1]);

  // Loop-generated cases mean the runner reports more than the `test(` count,
  // so this is a floor rather than an equality: it catches a badge that has
  // fallen behind, without breaking every time a table-driven case is added.
  assert.equal(
    claimed >= actual,
    true,
    `README claims ${claimed} tests but there are at least ${actual} test() calls`,
  );
});

test('the README check-count badge matches reality', () => {
  // The other static badge. Exact rather than a floor: unlike the test count,
  // this number cannot be undercounted by loop-generated cases, and a
  // catalogue that grows without the badge moving is the drift that had this
  // project claiming "13 of 23" while its own table listed 27.
  const badge = /!\[checks: (\d+)\]/.exec(read('README.md'));
  assert.notEqual(badge, null, 'the README check-count badge has gone missing');

  assert.equal(
    Number(badge?.[1]),
    BUILT.size,
    `README claims ${badge?.[1]} checks, the engine can emit ${BUILT.size}`,
  );
});

test('nothing anywhere claims a check count that is not the check count', () => {
  // The badge test above guards one number in one file. The same number is
  // written in prose in at least three others, and every one of them was wrong
  // at some point today — `CLAUDE.md` and `docs/dev/getting-started.md` both
  // still said 52 after the catalogue reached 54, and were corrected by hand.
  //
  // Correcting a number by hand is a job that recurs; a test is a job that
  // does not. This is deliberately wider than `docs/`, because the two stale
  // claims found in the 1.12.0 wrap-up were both in files nothing was
  // checking — `CLAUDE.md`, which instructs whoever picks this up, and the
  // internal notes. Prose reads exactly the same whether or not it is true.
  const FILES = [
    'README.md',
    'CLAUDE.md',
    'CONTRIBUTING.md',
    'docs/checks.md',
    'docs/usage.md',
    'docs/agents.md',
    'docs/reports.md',
    'docs/dev/getting-started.md',
    'docs/dev/adding-a-check.md',
    'docs/dev/writing-tests.md',
  ];

  const wrong: string[] = [];
  for (const file of FILES) {
    let source: string;
    try {
      source = read(file);
    } catch {
      continue; // A file that does not exist is another test's problem.
    }
    // **"All 54 checks", "The 54 checks" — a definite article and a number.**
    // That is how a claim about the whole catalogue is actually written in this
    // repository, checked rather than assumed: the only other numbered mention
    // anywhere is `writing-tests.md` recounting that the catalogue "went from 13
    // checks to 27", which is history and must not be flagged.
    //
    // A first attempt matched any number before the word and exempted anything
    // below the real total, to spare counts of a subset. That exemption swallowed
    // exactly the failure being guarded against — every stale claim found so far
    // has been an *under*-count, written when the catalogue was smaller — and the
    // test passed against a deliberately broken copy. Hence the narrower match
    // and no exemption.
    for (const match of source.matchAll(/\b(?:All|The) (\d+) checks\b/g)) {
      const claimed = Number(match[1]);
      if (claimed !== BUILT.size) wrong.push(`${file} claims ${claimed} checks`);
    }
  }

  assert.deepEqual(
    wrong,
    [],
    `the engine can emit ${BUILT.size} checks — update these, or the next reader trusts the wrong number`,
  );
});

test('only badges that cannot be sourced live are static', () => {
  // npm serves version, licence and the engines floor, so those three are
  // dynamic and cannot rot. Test and check counts have no live source without
  // CI, so they are static and each has a test above. Anything else static is
  // a badge nobody is watching.
  const badges = [
    ...read('README.md').matchAll(/!\[([^\]]+)\]\((https:\/\/img\.shields\.io[^)]+)\)/g),
  ];
  const stat = badges.filter(([, , url]) => (url ?? '').includes('/badge/'));

  assert.deepEqual(
    stat.map(([, label]) => (label ?? '').split(':')[0]).sort(),
    ['checks', 'tests'],
    'a static badge exists with nothing asserting it stays true',
  );
});
