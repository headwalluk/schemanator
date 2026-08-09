/**
 * Every shipped data file must have a loader that refuses to accept nonsense.
 *
 * This pattern arose independently four times — `cardinality.ts`,
 * `hierarchy.ts`, `values.ts` and `google.ts` all parse strictly and throw — and
 * each records the same reason in its own words. `cardinality.ts` puts it best:
 *
 * > a typo that silently degrades every entity check to "everything is plural"
 * > would produce a clean, confident, empty report — the worst possible failure
 * > for a tool whose output people act on.
 *
 * That is the whole argument. These files are **rules**, not configuration:
 * `data/` decides which properties are functional, which values are
 * placeholders, and what Google requires. A loader that shrugs at a malformed
 * file does not fail — it produces a report that looks fine and checks nothing.
 *
 * So the pattern is enforced rather than remembered. A new file under `data/`
 * fails this suite until somebody decides, in writing, which side it is on.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseCardinalityRules } from './checks/cardinality.ts';
import { parseGoogleRules } from './checks/google.ts';
import { parseAiCrawlers } from './checks/robots.ts';
import { parseHierarchy } from './checks/hierarchy.ts';
import { parseValueHeuristics } from './checks/values.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = path.join(ROOT, 'data');

/** Files that carry rules, with the parser that guards each. */
const GUARDED: Record<string, (json: string, source?: string) => unknown> = {
  'functional-properties.json': parseCardinalityRules,
  'ai-crawlers.json': parseAiCrawlers,
  'google-rich-results.json': parseGoogleRules,
  'schema-subclasses.json': parseHierarchy,
  'value-heuristics.json': parseValueHeuristics,
};

/**
 * Files exempt, each with the reason. Being on this list is a decision.
 *
 * `schema-context.json` is the vendored schema.org JSON-LD context. It is not a
 * rule we authored and not one we interpret — it is handed straight to
 * `jsonld.expand`, which validates it far more thoroughly than we could, and
 * fails loudly when it cannot. A hand-rolled validator over 190 KB of somebody
 * else's vocabulary would add a second opinion with no authority behind it.
 */
const EXEMPT: Record<string, string> = {
  'schema-context.json':
    'vendored schema.org context; validated by jsonld.expand at the point of use',
};

test('every file in data/ is either guarded by a parser or explicitly exempt', () => {
  // The point of the suite. A new data file cannot arrive unnoticed.
  const present = fs
    .readdirSync(DATA_DIR)
    .filter((name) => name.endsWith('.json'))
    .sort();
  const accounted = [...Object.keys(GUARDED), ...Object.keys(EXEMPT)].sort();

  assert.deepEqual(
    present,
    accounted,
    'a file under data/ has no parser and no exemption — add one, or say why it needs neither',
  );
});

test('every guarded file parses as shipped', () => {
  for (const [name, parse] of Object.entries(GUARDED)) {
    const target = path.join(DATA_DIR, name);
    assert.doesNotThrow(
      () => parse(fs.readFileSync(target, 'utf8'), target),
      `${name} does not parse`,
    );
  }
});

test('every parser rejects malformed input rather than degrading quietly', () => {
  // Three shapes of wrong, and silence on any of them is the failure mode this
  // whole suite exists for: an empty rule set produces a confident empty report.
  for (const [name, parse] of Object.entries(GUARDED)) {
    assert.throws(() => parse('this is not json', name), `${name}: accepted non-JSON`);
    assert.throws(() => parse('{}', name), `${name}: accepted an empty object`);
    assert.throws(() => parse('null', name), `${name}: accepted null`);
  }
});

test('every parser names the file it was reading', () => {
  // These files are edited by hand. An error saying only "invalid" sends someone
  // hunting; one naming the file and the key is a fix.
  for (const [name, parse] of Object.entries(GUARDED)) {
    assert.throws(
      () => parse('{}', `data/${name}`),
      (error: unknown) => {
        assert.equal(error instanceof Error, true);
        assert.match((error as Error).message, new RegExp(name.replace('.', '\\.')));
        return true;
      },
      `${name}: the error does not say which file was at fault`,
    );
  }
});

test('every shipped data file is valid JSON and non-trivial', () => {
  for (const name of fs.readdirSync(DATA_DIR).filter((entry) => entry.endsWith('.json'))) {
    const raw = fs.readFileSync(path.join(DATA_DIR, name), 'utf8');
    assert.doesNotThrow(() => JSON.parse(raw), `${name} is not valid JSON`);
    assert.equal(raw.length > 100, true, `${name} looks empty`);
  }
});
