/**
 * The exit-code contract, asserted rather than described.
 *
 * `docs/usage.md` has carried an exit-code table since 1.0.0 and
 * `docs/politeness.md` cites two of the codes in prose. Both were accurate, and
 * both were accurate *by luck*: nothing connected either to `src/cli.ts`, where
 * the codes lived as bare numbers.
 *
 * That is the failure mode `test/docs-consistency.test.ts` exists for — prose
 * describing a contract reads exactly the same whether or not the code honours
 * it — and exit codes had slipped through its net. They matter more than most
 * documentation because **a caller branches on them without reading the
 * message**, so a wrong code is acted on silently.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ALL_EXIT_CODES, EXIT } from './exit-codes.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative: string): string => fs.readFileSync(path.join(ROOT, relative), 'utf8');

test('every code is distinct', () => {
  // Two names for one number is a contract that cannot be branched on.
  assert.equal(new Set(ALL_EXIT_CODES).size, ALL_EXIT_CODES.length);
});

test('success is zero and nothing else is', () => {
  assert.equal(EXIT.OK, 0);
  for (const [name, code] of Object.entries(EXIT)) {
    if (name === 'OK') continue;
    assert.notEqual(code, 0, `${name} must not be 0 — a caller reads 0 as success`);
  }
});

test('docs/usage.md documents exactly the codes that exist', () => {
  // Both directions. A code with no row is undocumented; a row with no code is
  // fiction, and this repository has shipped that second failure before.
  const table = read('docs/usage.md').slice(read('docs/usage.md').indexOf('## Exit codes'));
  const documented = [...table.matchAll(/^\| `(\d+)` \|/gm)].map((match) => Number(match[1]));

  assert.equal(documented.length > 0, true, 'the exit-code table in usage.md has gone missing');
  assert.deepEqual(
    [...documented].sort((left, right) => left - right),
    [...ALL_EXIT_CODES].sort((left, right) => left - right),
  );
});

test('codes cited in prose elsewhere in docs are real', () => {
  // politeness.md names 2 and 3 in sentences rather than in a table, which is
  // the spelling most likely to rot unnoticed.
  for (const file of ['docs/politeness.md', 'docs/usage.md', 'docs/agents.md']) {
    for (const match of read(file).matchAll(/exit code (\d+)/gi)) {
      const code = Number(match[1]);
      assert.equal(
        (ALL_EXIT_CODES as readonly number[]).includes(code),
        true,
        `${file} cites exit code ${code}, which does not exist`,
      );
    }
  }
});

test('cli.ts contains no bare exit-code literals', () => {
  // The regression this whole module exists to prevent.
  const cli = read('src/cli.ts');
  assert.equal(/process\.exitCode = \d/.test(cli), false, 'cli.ts assigns a numeric literal to exitCode');
  assert.equal(/^\s*return \d+;$/m.test(cli), false, 'cli.ts returns a bare number as an exit code');
});

test('every exported Error class has a deliberate exit code', () => {
  // The gap that let UnresolvableContextError acquire an exit code nobody chose:
  // it was absent from the if/else ladder and fell into the catch-all. A new
  // error class must be a decision, not an omission.
  const cli = read('src/cli.ts');
  const table = cli.slice(cli.indexOf('const EXIT_BY_ERROR'), cli.indexOf('try {'));

  const classes = fs
    .readdirSync(path.join(ROOT, 'src'), { recursive: true, encoding: 'utf8' })
    .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))
    .flatMap((name) => [...read(`src/${name}`).matchAll(/^export class (\w*Error) extends Error/gm)])
    .map((match) => match[1] as string);

  assert.equal(classes.length >= 5, true, 'the error-class scan looks empty — has the declaration style changed?');

  const missing = [...new Set(classes)].filter((name) => !table.includes(name)).sort();
  assert.deepEqual(missing, [], `error classes with no row in EXIT_BY_ERROR: ${missing.join(', ')}`);
});
