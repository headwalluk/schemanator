import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  bareTypeName,
  closure,
  isSubClassOf,
  loadHierarchy,
  moreSpecific,
  parseHierarchy,
  typeSetRelation,
} from './hierarchy.ts';

const S = (name: string): string => `https://schema.org/${name}`;

test('the vendored hierarchy loads and is the expected shape', () => {
  const hierarchy = loadHierarchy();
  assert.equal(hierarchy.parents.size > 800, true);
  assert.equal(hierarchy.license, 'CC BY-SA 3.0');
  assert.match(hierarchy.sourceSha256, /^[0-9a-f]{64}$/);
});

test('known subclass relations resolve', () => {
  const hierarchy = loadHierarchy();
  assert.equal(isSubClassOf('LocalBusiness', 'Organization', hierarchy), true);
  assert.equal(isSubClassOf('ContactPage', 'WebPage', hierarchy), true);
  assert.equal(isSubClassOf('NewsArticle', 'CreativeWork', hierarchy), true);
  // Transitively: NewsArticle -> Article -> CreativeWork -> Thing
  assert.equal(isSubClassOf('NewsArticle', 'Thing', hierarchy), true);
});

test('unrelated types are not subclasses', () => {
  const hierarchy = loadHierarchy();
  assert.equal(isSubClassOf('Person', 'Organization', hierarchy), false);
  assert.equal(isSubClassOf('Organization', 'Person', hierarchy), false);
  assert.equal(isSubClassOf('Product', 'Person', hierarchy), false);
  // Not its own subclass.
  assert.equal(isSubClassOf('Person', 'Person', hierarchy), false);
});

test('the relation is directional', () => {
  const hierarchy = loadHierarchy();
  assert.equal(isSubClassOf('LocalBusiness', 'Organization', hierarchy), true);
  assert.equal(isSubClassOf('Organization', 'LocalBusiness', hierarchy), false);
});

test('full IRIs and bare names are interchangeable', () => {
  const hierarchy = loadHierarchy();
  assert.equal(isSubClassOf(S('LocalBusiness'), S('Organization'), hierarchy), true);
  assert.equal(isSubClassOf('http://schema.org/LocalBusiness', S('Organization'), hierarchy), true);
  assert.equal(isSubClassOf(S('LocalBusiness'), 'Organization', hierarchy), true);
});

test('bareTypeName strips only the schema.org prefix', () => {
  assert.equal(bareTypeName(S('Person')), 'Person');
  assert.equal(bareTypeName('http://schema.org/Person'), 'Person');
  assert.equal(bareTypeName('Person'), 'Person');
  assert.equal(
    bareTypeName('https://example.com/vocab#Person'),
    'https://example.com/vocab#Person',
  );
});

test('closure includes the type itself and all ancestors', () => {
  const hierarchy = loadHierarchy();
  const result = closure(['LocalBusiness'], hierarchy);
  assert.equal(result.has('LocalBusiness'), true);
  assert.equal(result.has('Organization'), true);
  assert.equal(result.has('Thing'), true);
  assert.equal(result.has('Person'), false);
});

test('closure of an unknown type is just that type', () => {
  const hierarchy = loadHierarchy();
  // A custom vocabulary must not blow up or silently acquire ancestors.
  assert.deepEqual(
    [...closure(['https://example.com/vocab#Widget'], hierarchy)],
    ['https://example.com/vocab#Widget'],
  );
});

// --- the case that mattered: type-set containment, not just subclassing ------

test('LocalBusiness vs Organization is a refinement', () => {
  const hierarchy = loadHierarchy();
  // headwall-hosting.com: the M0 type-narrowing finding.
  assert.equal(typeSetRelation(['LocalBusiness'], ['Organization'], hierarchy), 'refinement');
});

test('[Organization, Person] vs Person is also a refinement', () => {
  const hierarchy = loadHierarchy();
  // A real corpus site. Person and Organization are NOT subclass-related, so a
  // naive subclass test calls this a conflict. It is not: one observation
  // simply asserts an extra type, so the closures still nest. The first draft
  // of dev-notes/04 filed this wrongly.
  assert.equal(isSubClassOf('Person', 'Organization', hierarchy), false);
  assert.equal(typeSetRelation(['Organization', 'Person'], ['Person'], hierarchy), 'refinement');
});

test('genuinely unrelated types conflict', () => {
  const hierarchy = loadHierarchy();
  assert.equal(typeSetRelation(['Product'], ['Person'], hierarchy), 'conflict');
  assert.equal(typeSetRelation(['Event'], ['Organization'], hierarchy), 'conflict');
});

test('identical and equivalent type sets are "same"', () => {
  const hierarchy = loadHierarchy();
  assert.equal(typeSetRelation(['Person'], ['Person'], hierarchy), 'same');
  // Order must never matter.
  assert.equal(
    typeSetRelation(['Person', 'Organization'], ['Organization', 'Person'], hierarchy),
    'same',
  );
  // A redundant ancestor adds nothing to the closure.
  assert.equal(
    typeSetRelation(['LocalBusiness'], ['LocalBusiness', 'Organization'], hierarchy),
    'same',
  );
});

test('the relation is symmetric', () => {
  const hierarchy = loadHierarchy();
  for (const [left, right] of [
    [['LocalBusiness'], ['Organization']],
    [['Product'], ['Person']],
    [['Person'], ['Person']],
  ] as const) {
    assert.equal(
      typeSetRelation(left, right, hierarchy),
      typeSetRelation(right, left, hierarchy),
      `${left.join()} vs ${right.join()}`,
    );
  }
});

test('moreSpecific picks the richer set, or nothing on a conflict', () => {
  const hierarchy = loadHierarchy();
  assert.deepEqual(moreSpecific(['LocalBusiness'], ['Organization'], hierarchy), ['LocalBusiness']);
  assert.deepEqual(moreSpecific(['Organization'], ['LocalBusiness'], hierarchy), ['LocalBusiness']);
  assert.equal(moreSpecific(['Product'], ['Person'], hierarchy), null);
});

test('a cycle in the data cannot hang a check', () => {
  // The vendored file should be acyclic, but it is data and data can be wrong.
  // An infinite loop inside a check is far worse than an odd classification.
  const cyclic = parseHierarchy(
    JSON.stringify({ schema_version: 1, subclasses: { A: ['B'], B: ['C'], C: ['A'] } }),
  );
  const result = closure(['A'], cyclic);
  assert.deepEqual([...result].sort(), ['A', 'B', 'C']);
});

test('parse rejects a malformed hierarchy rather than degrading', () => {
  assert.throws(() => parseHierarchy('{ not json'), /not valid JSON/);
  assert.throws(() => parseHierarchy('{"subclasses":{}}'), /schema_version/);
  assert.throws(() => parseHierarchy('{"schema_version":1}'), /subclasses/);
  assert.throws(
    () => parseHierarchy('{"schema_version":1,"subclasses":{"A":"B"}}'),
    /must map to an array/,
  );
});
