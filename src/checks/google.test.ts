/**
 * Tests for group `google`.
 *
 * The negative tests matter more than the positive ones here. Every "does not
 * fire" case below is a false positive the corpus actually produced against an
 * earlier version of the rules — six findings, all six wrong — and each is the
 * kind that looks perfectly reasonable in the code and only shows up when you
 * read the output. They are regression tests, not hypotheticals.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { ExtractedNode } from '../extract/types.ts';
import type { PageRecord } from '../store/workdir.ts';
import { loadHierarchy } from './hierarchy.ts';
import { loadGoogleRules, parseGoogleRules, ruleFor } from './google.ts';
import { runChecks } from './run.ts';

const S = (name: string): string => `http://schema.org/${name}`;

let sequence = 0;
function node(options: {
  id: string;
  page?: string;
  types: string[];
  props?: Record<string, unknown[]>;
}): ExtractedNode {
  sequence += 1;
  return {
    node_id: options.id,
    raw_id: null,
    is_blank: options.id.startsWith('_:'),
    page_id: options.page ?? 'a',
    types: options.types,
    props: options.props ?? {},
    source: { syntax: 'json-ld', block: 0, pointer: `/${sequence}` },
  };
}

function page(id: string): PageRecord {
  return {
    page_id: id,
    url: `https://example.com/${id}`,
    canonical_url: `https://example.com/${id}`,
    declared_canonical: null,
    source: 'sitemap',
    http_status: 200,
    redirect_chain: [],
    content_type: 'text/html',
    fetched_at: '2026-08-01T00:00:00Z',
    // Unique per page: a shared hash would mean these fixtures are
    // byte-identical, which `indexing.duplicate-content` would rightly
    // report and no suite here means to say.
    content_sha256: `sha-${id}`,
    bytes: 1,
    html_purged: false,
    microdata_types: [],
    extraction: {
      json_ld_blocks: 1,
      json_ld_failed: 0,
      microdata_items: 0,
      rdfa_items: 0,
      nodes: 1,
    },
    errors: [],
  };
}

/** Only this group. Everything else is another suite's business. */
function google(nodes: ExtractedNode[], pages: PageRecord[] = [page('a'), page('b')]) {
  return runChecks({ nodes, pages, partialCoverage: false }).findings.filter((finding) =>
    finding.check.startsWith('google.'),
  );
}

const value = (text: string) => [{ '@value': text }];
const ref = (id: string) => [{ '@id': id }];

/** Swap one node of a fixture for another with the same `@id`. */
function replacing(nodes: ExtractedNode[], replacement: ExtractedNode): ExtractedNode[] {
  const swapped = nodes.map((candidate) =>
    candidate.node_id === replacement.node_id ? replacement : candidate,
  );
  assert.notDeepEqual(swapped, nodes, `nothing in the fixture had @id ${replacement.node_id}`);
  return swapped;
}

/** A Product that satisfies everything, for tests that vary one thing. */
function completeProduct(overrides: Record<string, unknown[]> = {}): ExtractedNode[] {
  return [
    node({
      id: 'https://example.com/#product',
      types: [S('Product')],
      props: {
        [S('name')]: value('A Thing'),
        [S('image')]: ref('https://example.com/a.jpg'),
        [S('review')]: ref('https://example.com/#review'),
        [S('aggregateRating')]: ref('https://example.com/#rating'),
        [S('offers')]: ref('https://example.com/#offer'),
        ...overrides,
      },
    }),
    node({
      id: 'https://example.com/#offer',
      types: [S('Offer')],
      props: {
        [S('price')]: value('9.99'),
        [S('priceCurrency')]: value('GBP'),
        [S('availability')]: value('InStock'),
        [S('priceValidUntil')]: value('2027-01-01'),
      },
    }),
    node({
      id: 'https://example.com/#review',
      types: [S('Review')],
      props: {
        [S('author')]: ref('https://example.com/#person'),
        [S('reviewRating')]: ref('https://example.com/#rating'),
        [S('datePublished')]: value('2026-01-01'),
      },
    }),
    node({
      id: 'https://example.com/#rating',
      types: [S('AggregateRating')],
      props: { [S('ratingValue')]: value('4.5'), [S('reviewCount')]: value('12') },
    }),
  ];
}

// --- the rules file ----------------------------------------------------------

test('the shipped rules file loads and validates', () => {
  const rules = loadGoogleRules();
  assert.equal(rules.schemaVersion, 1);
  assert.equal(rules.types.has('Product'), true);
  assert.equal(rules.types.has('LocalBusiness'), true);
  assert.equal(rules.types.has('Event'), true);
});

test('every rule cites the Google page it came from', () => {
  // A requirement nobody can check against its source is not a requirement,
  // it is folklore. The parser enforces this; this asserts the shipped data
  // actually carries it.
  for (const [name, rule] of loadGoogleRules().types) {
    assert.match(rule.source, /^https:\/\/developers\.google\.com\//, `${name} must cite a source`);
  }
});

test('the parser rejects a rules file it cannot trust', () => {
  // Strict and throwing, for cardinality.ts's reason: silently degrading to
  // "no type has any requirement" produces a clean, confident, empty report.
  assert.throws(() => parseGoogleRules('{"types":{}}'), /schema_version/);
  assert.throws(() => parseGoogleRules('{"schema_version":1}'), /types/);
  assert.throws(() => parseGoogleRules('{"schema_version":1,"types":{}}'), /empty/);
  assert.throws(
    () => parseGoogleRules('{"schema_version":1,"types":{"Product":{"source":"https://x"}}}'),
    /entry/,
  );
  assert.throws(
    () => parseGoogleRules('{"schema_version":1,"types":{"Product":{"entry":true}}}'),
    /source/,
  );
  // A one_of set with a single member is a required field wearing a disguise,
  // and would report under the wrong check.
  assert.throws(
    () =>
      parseGoogleRules(
        '{"schema_version":1,"types":{"Product":{"entry":true,"source":"https://x","one_of":[["name"]]}}}',
      ),
    /at least two/,
  );
});

// --- dispatching on the most specific type -----------------------------------

test('the most specific declared type wins', () => {
  const rules = loadGoogleRules();
  const hierarchy = loadHierarchy();

  // The false positive this exists for: AggregateOffer is a subclass of Offer,
  // so a closure match hits both, and five corpus nodes were reported as
  // missing Offer's price when they correctly carry lowPrice.
  assert.equal(ruleFor([S('AggregateOffer')], rules, hierarchy)?.typeName, 'AggregateOffer');
  assert.equal(ruleFor([S('Offer')], rules, hierarchy)?.typeName, 'Offer');
  // Same shape one level down the review types.
  assert.equal(ruleFor([S('AggregateRating')], rules, hierarchy)?.typeName, 'AggregateRating');
  assert.equal(ruleFor([S('Rating')], rules, hierarchy)?.typeName, 'Rating');
  // LocalBusiness is a Place and an Organization; its own rule is the specific one.
  assert.equal(ruleFor([S('LocalBusiness')], rules, hierarchy)?.typeName, 'LocalBusiness');
  // A subclass with no rule of its own inherits the nearest one that has.
  assert.equal(ruleFor([S('Store')], rules, hierarchy)?.typeName, 'LocalBusiness');
  // But only up its own branch. Museum is a CivicStructure and so a Place, and
  // is *not* a LocalBusiness in schema.org however much it behaves like one —
  // so it inherits Place's rule, which is nested-only and asks it for nothing.
  assert.equal(ruleFor([S('Museum')], rules, hierarchy)?.typeName, 'Place');
  assert.deepEqual(google([node({ id: 'https://example.com/#m', types: [S('Museum')] })]), []);
});

test('a type nothing covers has no rule', () => {
  const rules = loadGoogleRules();
  const hierarchy = loadHierarchy();
  assert.equal(ruleFor([S('Person')], rules, hierarchy), null);
  assert.equal(ruleFor(['https://example.com/vocab#Widget'], rules, hierarchy), null);
});

test('an AggregateOffer under a Product is never asked for Offer.price', () => {
  // The corpus false positive, end to end. lowPrice and priceCurrency are what
  // an AggregateOffer carries, and they satisfy it completely.
  const findings = google([
    node({
      id: 'https://example.com/#product',
      types: [S('Product')],
      props: {
        [S('name')]: value('A Thing'),
        [S('offers')]: ref('https://example.com/#agg'),
        [S('image')]: ref('https://example.com/a.jpg'),
        [S('review')]: ref('https://example.com/#r'),
        [S('aggregateRating')]: ref('https://example.com/#ar'),
      },
    }),
    node({
      id: 'https://example.com/#agg',
      types: [S('AggregateOffer')],
      props: {
        [S('lowPrice')]: value('5.00'),
        [S('priceCurrency')]: value('GBP'),
        [S('highPrice')]: value('9.00'),
        [S('offerCount')]: value('3'),
      },
    }),
    node({
      id: 'https://example.com/#r',
      types: [S('Review')],
      props: {
        [S('author')]: ref('https://example.com/#p'),
        [S('reviewRating')]: ref('https://example.com/#ar'),
        [S('datePublished')]: value('2026-01-01'),
      },
    }),
    node({
      id: 'https://example.com/#ar',
      types: [S('AggregateRating')],
      props: { [S('ratingValue')]: value('4'), [S('reviewCount')]: value('2') },
    }),
  ]);

  assert.deepEqual(findings, []);
});

// --- dotted-path alternatives ------------------------------------------------

test('an Offer priced through priceSpecification satisfies the price requirement', () => {
  // The second corpus false positive: Google accepts price or
  // priceSpecification.price, and a rule knowing only the first reported a
  // correctly-marked-up offer as missing a required field.
  const findings = google([
    ...replacing(
      completeProduct(),
      node({
        id: 'https://example.com/#offer',
        types: [S('Offer')],
        props: {
          [S('priceSpecification')]: ref('https://example.com/#spec'),
          [S('priceCurrency')]: value('GBP'),
          [S('availability')]: value('InStock'),
          [S('priceValidUntil')]: value('2027-01-01'),
        },
      }),
    ),
    node({
      id: 'https://example.com/#spec',
      types: [S('UnitPriceSpecification')],
      props: { [S('price')]: value('9.99'), [S('priceCurrency')]: value('GBP') },
    }),
  ]);

  assert.deepEqual(
    findings.map((finding) => finding.title),
    [],
  );
});

test('an Offer with neither price nor priceSpecification.price is reported', () => {
  const findings = google(
    replacing(
      completeProduct(),
      node({
        id: 'https://example.com/#offer',
        types: [S('Offer')],
        props: {
          [S('priceCurrency')]: value('GBP'),
          [S('availability')]: value('InStock'),
          [S('priceValidUntil')]: value('2027-01-01'),
        },
      }),
    ),
  );

  assert.equal(findings.length, 1);
  assert.equal(findings[0]?.check, 'google.incomplete-alternative');
  assert.equal(findings[0]?.severity, 'error');
  assert.match(findings[0]?.title ?? '', /price, priceSpecification\.price/);
});

// --- context: entry versus nested --------------------------------------------

test('an Offer nobody references is not judged at all', () => {
  // entry: false. Google's Offer requirements belong to the product snippet,
  // not to every Offer node in existence.
  assert.deepEqual(
    google([
      node({
        id: '_:stray',
        types: [S('Offer')],
        props: { [S('url')]: ref('https://example.com/x') },
      }),
    ]),
    [],
  );
});

test('a Review nested under the thing it reviews is not asked for itemReviewed', () => {
  // Google requires itemReviewed only on a review that stands alone; nested,
  // the parent supplies the identity. Every corpus site nests properly, so a
  // rule without this would have fired on all of them.
  const findings = google(completeProduct());
  assert.deepEqual(findings, []);
});

test('a free-standing Review is asked for itemReviewed', () => {
  const findings = google([
    node({
      id: 'https://example.com/#review',
      types: [S('Review')],
      props: {
        [S('author')]: ref('https://example.com/#p'),
        [S('reviewRating')]: ref('https://example.com/#rating'),
        [S('datePublished')]: value('2026-01-01'),
      },
    }),
    node({
      id: 'https://example.com/#rating',
      types: [S('Rating')],
      props: { [S('ratingValue')]: value('5') },
    }),
  ]);

  assert.equal(findings.length, 1);
  assert.equal(findings[0]?.check, 'google.missing-required');
  assert.equal(findings[0]?.subject.property, 'itemReviewed');
});

// --- required and recommended ------------------------------------------------

test('a required field is an error and a recommended one an opportunity', () => {
  const findings = google([
    node({
      id: 'https://example.com/#biz',
      types: [S('LocalBusiness')],
      props: { [S('name')]: value('Acme') },
    }),
  ]);

  const required = findings.find((finding) => finding.check === 'google.missing-required');
  assert.equal(required?.severity, 'error');
  assert.equal(required?.subject.property, 'address');
  assert.match(required?.remediation ?? '', /developers\.google\.com/);

  const recommended = findings.filter((finding) => finding.check === 'google.missing-recommended');
  assert.equal(recommended.length > 0, true);
  for (const finding of recommended) assert.equal(finding.severity, 'opportunity');
});

test('the recommended check states the trade-off it cannot resolve', () => {
  // Reporting "no aggregateRating" must never read as "go and add ratings".
  // Inventing them is a guidelines violation and risks a manual action.
  const findings = google([
    node({
      id: 'https://example.com/#p',
      types: [S('Product')],
      props: {
        [S('name')]: value('X'),
        [S('offers')]: ref('https://example.com/#o'),
        [S('image')]: ref('https://example.com/i.jpg'),
      },
    }),
    node({
      id: 'https://example.com/#o',
      types: [S('Offer')],
      props: {
        [S('price')]: value('1'),
        [S('priceCurrency')]: value('GBP'),
        [S('availability')]: value('InStock'),
        [S('priceValidUntil')]: value('2027-01-01'),
      },
    }),
  ]);

  const rating = findings.find((finding) => finding.subject.property === 'aggregateRating');
  assert.equal(rating?.check, 'google.missing-recommended');
  assert.match(rating?.tradeoff ?? '', /guidelines/);
});

test('a Product with none of offers, review or aggregateRating fails the set', () => {
  const findings = google([
    node({
      id: 'https://example.com/#p',
      types: [S('Product')],
      props: { [S('name')]: value('X'), [S('image')]: ref('https://example.com/i.jpg') },
    }),
  ]);

  const alternative = findings.find((finding) => finding.check === 'google.incomplete-alternative');
  assert.equal(alternative?.severity, 'error');
  assert.match(alternative?.title ?? '', /offers, review, aggregateRating/);
});

test('bestRating and worstRating are never reported', () => {
  // They default to 5 and 1. The first version reported both on 14 nodes of one
  // corpus site, which amounted to telling an operator that five is the best of
  // five. Recorded in the rules file.
  const findings = google([
    node({
      id: 'https://example.com/#p',
      types: [S('Product')],
      props: {
        [S('name')]: value('X'),
        [S('image')]: ref('https://example.com/i.jpg'),
        [S('review')]: ref('https://example.com/#r'),
        [S('aggregateRating')]: ref('https://example.com/#ar'),
        [S('offers')]: ref('https://example.com/#o'),
      },
    }),
    node({
      id: 'https://example.com/#o',
      types: [S('Offer')],
      props: {
        [S('price')]: value('1'),
        [S('priceCurrency')]: value('GBP'),
        [S('availability')]: value('InStock'),
        [S('priceValidUntil')]: value('2027-01-01'),
      },
    }),
    node({
      id: 'https://example.com/#r',
      types: [S('Review')],
      props: {
        [S('author')]: ref('https://example.com/#p2'),
        [S('reviewRating')]: ref('https://example.com/#ar'),
        [S('datePublished')]: value('2026-01-01'),
      },
    }),
    node({
      id: 'https://example.com/#ar',
      types: [S('AggregateRating')],
      props: { [S('ratingValue')]: value('4'), [S('reviewCount')]: value('9') },
    }),
  ]);

  assert.deepEqual(findings, []);
});

// --- the rules that keep the report readable ---------------------------------

test('one generator omission across many pages is one finding', () => {
  // Rule 5, and the reason this group survives contact with a real site: 252
  // corpus products omit review, and that is one setting and one fix.
  const nodes = ['a', 'b', 'c', 'd'].map((pageId) =>
    node({
      id: `https://example.com/${pageId}#p`,
      page: pageId,
      types: [S('Product')],
      props: {
        [S('name')]: value('X'),
        [S('offers')]: ref(`https://example.com/${pageId}#o`),
        [S('image')]: ref('https://example.com/i.jpg'),
        [S('aggregateRating')]: ref(`https://example.com/${pageId}#ar`),
      },
    }),
  );
  const offers = ['a', 'b', 'c', 'd'].map((pageId) =>
    node({
      id: `https://example.com/${pageId}#o`,
      page: pageId,
      types: [S('Offer')],
      props: {
        [S('price')]: value('1'),
        [S('priceCurrency')]: value('GBP'),
        [S('availability')]: value('InStock'),
        [S('priceValidUntil')]: value('2027-01-01'),
      },
    }),
  );
  const ratings = ['a', 'b', 'c', 'd'].map((pageId) =>
    node({
      id: `https://example.com/${pageId}#ar`,
      page: pageId,
      types: [S('AggregateRating')],
      props: { [S('ratingValue')]: value('4'), [S('reviewCount')]: value('9') },
    }),
  );

  const findings = google([...nodes, ...offers, ...ratings], ['a', 'b', 'c', 'd'].map(page));

  assert.equal(findings.length, 1);
  assert.equal(findings[0]?.subject.property, 'review');
  assert.equal(findings[0]?.pages_affected, 4);
});

test('partiality is reported here, unlike everywhere else', () => {
  // The one place the silencing rule is inverted, and it is deliberate: Google
  // evaluates a page, not an @id. A corpus LocalBusiness has two observations,
  // one with address and one without, and grouping by @id hid a real error.
  const findings = google([
    node({
      id: 'https://example.com/#biz',
      page: 'a',
      types: [S('LocalBusiness')],
      props: {
        [S('name')]: value('Acme'),
        [S('address')]: ref('https://example.com/#addr'),
        [S('telephone')]: value('1'),
        [S('priceRange')]: value('££'),
        [S('openingHoursSpecification')]: ref('https://example.com/#oh'),
        [S('geo')]: ref('https://example.com/#geo'),
        [S('url')]: ref('https://example.com/'),
        [S('image')]: ref('https://example.com/i.jpg'),
      },
    }),
    node({
      id: 'https://example.com/#biz',
      page: 'b',
      types: [S('LocalBusiness')],
      props: {
        [S('name')]: value('Acme'),
        [S('telephone')]: value('1'),
        [S('priceRange')]: value('££'),
        [S('openingHoursSpecification')]: ref('https://example.com/#oh'),
        [S('geo')]: ref('https://example.com/#geo'),
        [S('url')]: ref('https://example.com/'),
        [S('image')]: ref('https://example.com/i.jpg'),
      },
    }),
  ]);

  assert.equal(findings.length, 1);
  assert.equal(findings[0]?.check, 'google.missing-required');
  assert.equal(findings[0]?.subject.property, 'address');
  assert.equal(findings[0]?.pages_affected, 1);
});

test('an empty string counts as present, because value.empty owns it', () => {
  // One defect billed under two checks costs an operator more than it tells them.
  const findings = google([
    node({
      id: 'https://example.com/#biz',
      types: [S('LocalBusiness')],
      props: {
        [S('name')]: value(''),
        [S('address')]: value(''),
        [S('telephone')]: value('1'),
        [S('priceRange')]: value('£'),
        [S('openingHoursSpecification')]: ref('https://example.com/#oh'),
        [S('geo')]: ref('https://example.com/#geo'),
        [S('url')]: ref('https://example.com/'),
        [S('image')]: ref('https://example.com/i.jpg'),
      },
    }),
  ]);

  assert.deepEqual(
    findings.filter((finding) => finding.check === 'google.missing-required'),
    [],
  );
});

test('findings carry provenance back to the block and pointer', () => {
  // `01` makes this mandatory: a finding you cannot trace to exact source text
  // is unreportable, and unfixable by the person reading it.
  const findings = google([
    node({
      id: 'https://example.com/#biz',
      types: [S('LocalBusiness')],
      props: { [S('name')]: value('Acme') },
    }),
  ]);

  const provenance = findings[0]?.observed[0]?.provenance[0];
  assert.equal(provenance?.syntax, 'json-ld');
  assert.equal(provenance?.url, 'https://example.com/a');
  assert.equal(typeof provenance?.pointer, 'string');
});

test('the whole group can be disabled by name', () => {
  const { findings } = runChecks({
    nodes: [
      node({
        id: 'https://example.com/#biz',
        types: [S('LocalBusiness')],
        props: { [S('name')]: value('Acme') },
      }),
    ],
    pages: [page('a')],
    partialCoverage: false,
    disabled: ['google'],
  });

  assert.deepEqual(
    findings.filter((finding) => finding.check.startsWith('google.')),
    [],
  );
});
