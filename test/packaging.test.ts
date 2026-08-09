/**
 * What the published tarball may and may not contain.
 *
 * The stakes are asymmetric. Shipping `dist/` without `data/` produces a package
 * that installs cleanly and fails on first use — every check reads at least one
 * of the four data files. Shipping `dev-notes/` publishes real client hostnames
 * alongside their structured-data defects, and cannot be taken back.
 *
 * Both are one typo in a `files` array, and neither shows up in a test run
 * unless something asserts it. So this reads `package.json` directly rather than
 * trusting that anyone re-checked it.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as {
  name: string;
  version: string;
  bin: Record<string, string>;
  files: string[];
  engines: { node: string };
  scripts: Record<string, string>;
  private?: boolean;
};

const shipped = new Set(manifest.files);

test('dev-notes never ships — it names real client sites', () => {
  // The one entry in this file that is not merely a correctness matter.
  assert.equal(shipped.has('dev-notes'), false);
  for (const entry of manifest.files) {
    assert.equal(entry.startsWith('dev-notes'), false, `files includes ${entry}`);
  }
});

test('crawl output and the site list never ship', () => {
  for (const forbidden of ['work', 'sites.txt', 'tools']) {
    assert.equal(shipped.has(forbidden), false, `files includes ${forbidden}`);
  }
});

test('every runtime data file ships', () => {
  // Omitting `data/` yields a package that installs and then cannot start.
  assert.equal(shipped.has('data'), true, 'files must include data/');

  const required = [
    'schema-context.json',
    'schema-subclasses.json',
    'functional-properties.json',
    'value-heuristics.json',
  ];
  for (const name of required) {
    assert.equal(
      fs.existsSync(path.join(ROOT, 'data', name)),
      true,
      `data/${name} is read at runtime but does not exist`,
    );
  }
});

test('the licence and its attribution ship together', () => {
  // AGPL-3.0 requires recipients can obtain the source, which is why src/ is in
  // the list. NOTICE carries the CC BY-SA attribution for the schema.org data.
  assert.equal(shipped.has('LICENSE'), true);
  assert.equal(shipped.has('NOTICE'), true);
  assert.equal(shipped.has('src'), true, 'AGPL-3.0: the source must travel with the build');
});

test('bin points at the built output, not the TypeScript source', () => {
  // src/cli.ts only runs on Node >= 22.18. Pointing bin at it defeats the
  // entire reason the build exists.
  const entry = manifest.bin['schemanator'];
  assert.equal(entry, './dist/cli.js');
  assert.equal(shipped.has('dist'), true);
});

test('engines declares the consumer floor, not the development one', () => {
  // >=22.18 is what a *checkout* needs, for native type stripping. A consumer
  // installs plain JavaScript; declaring 22.18 would warn away exactly the
  // 22.0-22.17 users the dist build exists to serve. See dev-notes/06.
  assert.equal(manifest.engines.node, '>=22.0.0');
});

test('the package is publishable and correctly scoped', () => {
  assert.equal(manifest.private, undefined, 'private: true blocks publishing');
  assert.equal(manifest.name, '@headwall/schemanator');
});

test('prepublishOnly cannot ship stale or broken output', () => {
  const hook = manifest.scripts['prepublishOnly'] ?? '';
  for (const required of ['typecheck', 'test', 'build']) {
    assert.match(hook, new RegExp(required), `prepublishOnly must run ${required}`);
  }
});

test('the build config emits what bin promises', () => {
  const build = JSON.parse(
    fs.readFileSync(path.join(ROOT, 'tsconfig.build.json'), 'utf8').replace(/^\s*\/\/.*$/gm, ''),
  ) as {
    compilerOptions: Record<string, unknown>;
    exclude?: string[];
  };

  assert.equal(build.compilerOptions['outDir'], 'dist');
  assert.equal(build.compilerOptions['noEmit'], false);
  // Without this the emitted JS keeps `./foo.ts` specifiers and cannot resolve.
  assert.equal(build.compilerOptions['rewriteRelativeImportExtensions'], true);
  assert.deepEqual(build.exclude, ['src/**/*.test.ts'], 'tests must not ship in dist/');
});

test('the version is a plain release version', () => {
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
});
