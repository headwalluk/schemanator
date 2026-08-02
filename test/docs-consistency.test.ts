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

import { ALL_CHECKS } from '../src/checks/run.ts';

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
 * `entity.page-scoped-value` is raised by `entity.contradiction` rather than
 * registered separately, because only that check has the evidence to tell the
 * two apart — so it is absent from `ALL_CHECKS` by design.
 */
const BUILT = new Set([...ALL_CHECKS.map((check) => check.id), 'entity.page-scoped-value']);

const CHECKS_DOC = read('docs/checks.md');

/** Checks with a full write-up: `### \`id\` — Severity`. */
const DOCUMENTED = new Set([...CHECKS_DOC.matchAll(/^### `([a-z][a-z.-]+)` — /gm)].map((match) => match[1] as string));

/** The "Not yet implemented" table, which promises nothing. */
const PLANNED = new Set(
  [...CHECKS_DOC.slice(CHECKS_DOC.indexOf('## Not yet implemented')).matchAll(/^\| `([a-z][a-z.*-]+)`/gm)].map(
    (match) => match[1] as string,
  ),
);

test('every built check is documented', () => {
  const missing = [...BUILT].filter((id) => !DOCUMENTED.has(id)).sort();
  assert.deepEqual(missing, [], `built but undocumented: ${missing.join(', ')}`);
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
  for (const heading of [...CHECKS_DOC.matchAll(/^## `([a-z]+)`/gm)].map((match) => match[1] as string)) {
    assert.equal(groups.has(heading), true, `docs/checks.md documents an unknown group: ${heading}`);
  }
});

test('every CLI flag documented in usage.md exists', () => {
  const cli = read('src/cli.ts');
  const usage = read('docs/usage.md');

  // The options table: | `--flag <arg>` | description |
  const documented = [...usage.matchAll(/^\| `(--[a-z-]+)/gm)].map((match) => match[1] as string);
  assert.equal(documented.length > 10, true, 'the options table looks empty — has the format changed?');

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
    [...read('docs/configuration.md').matchAll(/^\| `(SCHEMANATOR_[A-Z_]+|LOG_LEVEL|NODE_ENV)`/gm)].map(
      (match) => match[1] as string,
    ),
  )) {
    assert.equal(sources.includes(variable), true, `docs document ${variable}, which nothing reads`);
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
  const roots = ['src', 'data'];
  const offenders: string[] = [];

  for (const root of roots) {
    const entries = fs.readdirSync(path.join(ROOT, root), { recursive: true, encoding: 'utf8' });
    for (const entry of entries) {
      if (!/\.(ts|json)$/.test(entry)) continue;
      const relative = `${root}/${entry}`;
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

  for (const file of ['src/analyse.ts', 'src/pipeline.ts', 'src/net/fetcher.ts', 'src/report/build.ts']) {
    assert.equal(
      /['"`]\d+\.\d+\.\d+['"`]/.test(read(file)),
      false,
      `${file} contains a literal version string; import VERSION from runtime.ts instead`,
    );
  }

  assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
});

test('the README test-count badge matches reality', () => {
  // Static badges drift. This one is cheap to keep honest, and a badge that
  // lies about the test count undermines the ones that do not.
  const badge = /!\[tests: (\d+)\]/.exec(read('README.md'));
  assert.notEqual(badge, null, 'the README test-count badge has gone missing');

  const suites = ['src', 'test']
    .flatMap((dir) => fs.readdirSync(path.join(ROOT, dir), { recursive: true, encoding: 'utf8' })
      .filter((name) => name.endsWith('.test.ts'))
      .map((name) => read(path.join(dir, name))));

  const actual = suites.reduce((total, source) => total + (source.match(/^test\(/gm)?.length ?? 0), 0);
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
