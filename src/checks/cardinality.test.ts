import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  cardinalityRule,
  isFunctional,
  loadCardinalityRules,
  normalisePropertyIri,
  parseCardinalityRules,
} from './cardinality.ts';

const SCHEMA = (name: string): string => `https://schema.org/${name}`;

test('the shipped rules file loads and validates', () => {
  const rules = loadCardinalityRules();
  assert.equal(rules.schemaVersion, 1);
  assert.equal(rules.defaultCardinality, 'multi-valued');
  assert.equal(rules.properties.size > 15, true);
});

test('the identity properties are functional', () => {
  const rules = loadCardinalityRules();
  for (const name of ['name', 'url', 'logo', 'address', 'telephone', 'email', 'legalName']) {
    assert.equal(isFunctional(SCHEMA(name), rules), true, `${name} should be functional`);
  }
});

test('the properties the corpus proved plural are not functional', () => {
  const rules = loadCardinalityRules();
  for (const name of ['sameAs', 'image', 'keywords', 'itemListElement', 'areaServed', 'knowsAbout']) {
    assert.equal(isFunctional(SCHEMA(name), rules), false, `${name} should be multi-valued`);
  }
});

test('an unlisted property is multi-valued, and therefore silent', () => {
  const rules = loadCardinalityRules();
  // The safe default: a missing functional property costs one unreported
  // finding; a wrongly-functional one costs a false contradiction everywhere.
  assert.equal(isFunctional(SCHEMA('somethingNobodyHasCharacterised'), rules), false);
  assert.equal(isFunctional('https://example.com/custom/vocab#thing', rules), false);
});

test('http schema.org IRIs resolve to the same rule as https', () => {
  const rules = loadCardinalityRules();
  // Both spellings are in the wild and expand to different IRIs. A lookup that
  // skips normalisation silently misses every mixed-vintage site.
  assert.equal(isFunctional('http://schema.org/telephone', rules), true);
  assert.equal(isFunctional('http://schema.org/sameAs', rules), false);
});

test('normalisePropertyIri only touches the schema.org prefix', () => {
  assert.equal(normalisePropertyIri('http://schema.org/name'), 'https://schema.org/name');
  assert.equal(normalisePropertyIri('https://schema.org/name'), 'https://schema.org/name');
  // Must not rewrite an unrelated vocabulary that happens to be http.
  assert.equal(normalisePropertyIri('http://purl.org/dc/terms/title'), 'http://purl.org/dc/terms/title');
  // Must not match a lookalike host.
  assert.equal(normalisePropertyIri('http://notschema.org/name'), 'http://notschema.org/name');
});

test('every rule records the basis for its claim', () => {
  const rules = loadCardinalityRules();
  for (const [iri, rule] of rules.properties) {
    assert.equal(
      rule.basis === 'observed' || rule.basis === 'asserted',
      true,
      `${iri} must say whether the corpus proved it or we asserted it`,
    );
  }
});

test('anything the corpus proved plural is recorded as observed, not asserted', () => {
  const rules = loadCardinalityRules();
  // These were measured carrying two values. That is empirical, and mislabelling
  // it as policy would invite someone to "correct" it later.
  for (const name of ['sameAs', 'image', 'keywords', 'itemListElement']) {
    assert.equal(cardinalityRule(SCHEMA(name), rules)?.basis, 'observed', `${name}`);
  }
});

test('the functional list stays small on purpose', () => {
  const rules = loadCardinalityRules();
  const functional = [...rules.properties.values()].filter((rule) => rule.cardinality === 'functional');
  // 122 distinct properties in the corpus; a tight list is the low-false-positive
  // choice. If this ever grows past ~25, that is a decision worth revisiting
  // deliberately rather than by accretion.
  assert.equal(functional.length <= 25, true, `functional list has grown to ${functional.length}`);
});

test('parse rejects a file that would silently disable every entity check', () => {
  assert.throws(() => parseCardinalityRules('{ not json'), /not valid JSON/);
  assert.throws(() => parseCardinalityRules('{"default_cardinality":"multi-valued","properties":{}}'), /schema_version/);
  assert.throws(() => parseCardinalityRules('{"schema_version":1,"properties":{}}'), /default_cardinality/);
  assert.throws(() => parseCardinalityRules('{"schema_version":1,"default_cardinality":"multi-valued"}'), /properties/);
});

test('parse rejects an invalid cardinality or basis rather than guessing', () => {
  const base = '{"schema_version":1,"default_cardinality":"multi-valued","properties":';
  assert.throws(
    () => parseCardinalityRules(`${base}{"https://schema.org/x":{"cardinality":"single","basis":"asserted"}}}`),
    /invalid "cardinality"/,
  );
  assert.throws(
    () => parseCardinalityRules(`${base}{"https://schema.org/x":{"cardinality":"functional","basis":"vibes"}}}`),
    /invalid "basis"/,
  );
});

test('an operator override replaces the shipped list', () => {
  const override = parseCardinalityRules(
    JSON.stringify({
      schema_version: 1,
      default_cardinality: 'multi-valued',
      properties: { 'https://schema.org/sameAs': { cardinality: 'functional', basis: 'asserted' } },
    }),
  );
  // A site that really does publish one sameAs can say so.
  assert.equal(isFunctional(SCHEMA('sameAs'), override), true);
  assert.equal(isFunctional(SCHEMA('name'), override), false);
});
