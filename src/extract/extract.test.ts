import { test } from 'node:test';
import assert from 'node:assert/strict';

import { extract } from './index.ts';

const PAGE = 'https://example.com/about/';
const PAGE_ID = 'about-4b81ee02';

const page = (head: string): string => `<!DOCTYPE html><html><head>${head}</head><body></body></html>`;
const ld = (body: string): string => `<script type="application/ld+json">${body}</script>`;

const short = (iri: string): string => iri.split('/').pop() ?? iri;
const byType = <T extends { types: string[] }>(nodes: T[], type: string): T[] =>
  nodes.filter((node) => node.types.some((candidate) => short(candidate) === type));

// --- @context variants (dev-notes/03) ---------------------------------------

test('resolves a string @context', async () => {
  const result = await extract(page(ld('{"@context":"https://schema.org","@type":"Organization","name":"Acme"}')), PAGE, PAGE_ID);
  assert.equal(result.counts.json_ld_failed, 0);
  assert.equal(result.nodes.length, 1);
  assert.equal(short(result.nodes[0]?.types[0] ?? ''), 'Organization');
});

test('resolves http, https and trailing-slash spellings alike', async () => {
  for (const context of ['http://schema.org', 'https://schema.org', 'http://schema.org/', 'https://schema.org/']) {
    const result = await extract(
      page(ld(`{"@context":"${context}","@type":"Person","name":"X"}`)),
      PAGE,
      PAGE_ID,
    );
    assert.equal(result.counts.json_ld_failed, 0, `failed for ${context}`);
    assert.equal(short(result.nodes[0]?.types[0] ?? ''), 'Person', context);
  }
});

test('post-expansion IRIs are consistent regardless of the spelling used', async () => {
  // The trap in `03`: http and https produce different IRIs for the same type,
  // so a site with mixed-vintage markup would otherwise report phantom
  // contradictions. Both must land on the same IRI here.
  const viaHttp = await extract(page(ld('{"@context":"http://schema.org","@type":"Person","name":"X"}')), PAGE, PAGE_ID);
  const viaHttps = await extract(page(ld('{"@context":"https://schema.org","@type":"Person","name":"X"}')), PAGE, PAGE_ID);
  assert.deepEqual(viaHttp.nodes[0]?.types, viaHttps.nodes[0]?.types);
  assert.deepEqual(Object.keys(viaHttp.nodes[0]?.props ?? {}), Object.keys(viaHttps.nodes[0]?.props ?? {}));
});

test('resolves an array @context with an inline object', async () => {
  const result = await extract(
    page(ld('{"@context":["https://schema.org",{"custom":"https://example.com/vocab#"}],"@type":"Organization","name":"Acme","custom":"x"}')),
    PAGE,
    PAGE_ID,
  );
  assert.equal(result.counts.json_ld_failed, 0);
  assert.equal(Object.keys(result.nodes[0]?.props ?? {}).some((key) => key.startsWith('https://example.com/vocab#')), true);
});

test('resolves an inline @vocab with no remote context at all', async () => {
  const result = await extract(
    page(ld('{"@context":{"@vocab":"https://schema.org/"},"@type":"Organization","name":"Acme"}')),
    PAGE,
    PAGE_ID,
  );
  assert.equal(result.counts.json_ld_failed, 0);
  assert.equal(result.nodes.length, 1);
});

test('refuses an unknown remote context rather than fetching it', async () => {
  const result = await extract(page(ld('{"@context":"https://elsewhere.example/ctx.jsonld","@type":"Thing"}')), PAGE, PAGE_ID);
  assert.equal(result.counts.json_ld_failed, 1);
  assert.match(result.blocks[0]?.error ?? '', /refusing to fetch remote context/);
});

// --- document shapes --------------------------------------------------------

test('handles @graph at the top level', async () => {
  const result = await extract(
    page(ld('{"@context":"https://schema.org","@graph":[{"@type":"Organization","@id":"#o","name":"A"},{"@type":"WebSite","@id":"#w","name":"B"}]}')),
    PAGE,
    PAGE_ID,
  );
  assert.equal(result.nodes.length, 2);
});

test('handles a bare array of nodes', async () => {
  const result = await extract(
    page(ld('[{"@context":"https://schema.org","@type":"Organization","name":"A"},{"@context":"https://schema.org","@type":"Person","name":"B"}]')),
    PAGE,
    PAGE_ID,
  );
  assert.equal(result.nodes.length, 2);
});

test('handles multiple blocks each with their own @graph', async () => {
  const result = await extract(
    page(
      ld('{"@context":"https://schema.org","@graph":[{"@type":"Organization","@id":"#o","name":"A"}]}') +
        ld('{"@context":"https://schema.org","@graph":[{"@type":"WebSite","@id":"#w","name":"B"}]}'),
    ),
    PAGE,
    PAGE_ID,
  );
  assert.equal(result.counts.json_ld_blocks, 2);
  assert.equal(result.nodes.length, 2);
  // Block provenance is the diagnostic question when two sources collide.
  assert.deepEqual(result.nodes.map((node) => node.source.block).sort(), [0, 1]);
});

// --- the nasty cases --------------------------------------------------------

test('a malformed block does not abort the page', async () => {
  const result = await extract(
    page(ld('{ "@context": "https://schema.org", broken') + ld('{"@context":"https://schema.org","@type":"Person","name":"Survivor"}')),
    PAGE,
    PAGE_ID,
  );
  assert.equal(result.counts.json_ld_blocks, 2);
  assert.equal(result.counts.json_ld_failed, 1);
  assert.notEqual(result.blocks[0]?.error, null);
  // Everything else still extracted.
  assert.equal(result.nodes.length, 1);
  assert.deepEqual(result.nodes[0]?.props['http://schema.org/name'], [{ '@value': 'Survivor' }]);
});

test('the raw text of a malformed block is preserved verbatim', async () => {
  const broken = '{ "@context": "https://schema.org", broken';
  const result = await extract(page(ld(broken)), PAGE, PAGE_ID);
  // A finding you cannot show source for is unfixable (`03`).
  assert.equal(result.blocks[0]?.text, broken);
});

test('names a trailing comma as the likely cause', async () => {
  const result = await extract(page(ld('{"@context":"https://schema.org","@type":"Person","name":"X",}')), PAGE, PAGE_ID);
  assert.match(result.blocks[0]?.error ?? '', /trailing comma/);
});

test('strips a BOM and leading whitespace', async () => {
  const result = await extract(page(ld('﻿\n  {"@context":"https://schema.org","@type":"Person","name":"X"}')), PAGE, PAGE_ID);
  assert.equal(result.counts.json_ld_failed, 0);
});

test('unwraps CDATA and comment guards', async () => {
  for (const wrapped of [
    '//<![CDATA[{"@context":"https://schema.org","@type":"Person","name":"X"}]]>',
    '<!--{"@context":"https://schema.org","@type":"Person","name":"X"}-->',
  ]) {
    const result = await extract(page(ld(wrapped)), PAGE, PAGE_ID);
    assert.equal(result.counts.json_ld_failed, 0, wrapped.slice(0, 20));
  }
});

test('ignores script tags that are not ld+json', async () => {
  const result = await extract(
    page('<script>var x = 1;</script><script type="application/json">{"a":1}</script>'),
    PAGE,
    PAGE_ID,
  );
  assert.equal(result.counts.json_ld_blocks, 0);
});

test('accepts a type attribute carrying a charset parameter', async () => {
  const result = await extract(
    page('<script type="application/ld+json; charset=UTF-8">{"@context":"https://schema.org","@type":"Person"}</script>'),
    PAGE,
    PAGE_ID,
  );
  assert.equal(result.counts.json_ld_blocks, 1);
});

// --- flattening (amendment A) ------------------------------------------------

test('hoists a nested node and leaves a reference behind', async () => {
  const result = await extract(
    page(ld('{"@context":"https://schema.org","@type":"Organization","@id":"#o","name":"A","logo":{"@type":"ImageObject","@id":"#l","url":"https://example.com/l.png"}}')),
    PAGE,
    PAGE_ID,
  );

  assert.equal(result.nodes.length, 2);
  const org = byType(result.nodes, 'Organization')[0];
  const logoValue = org?.props['http://schema.org/logo']?.[0] as Record<string, unknown>;
  assert.deepEqual(logoValue, { '@id': `${PAGE}#l` });
});

test('a bare reference is not hoisted into an observation', async () => {
  // Rule 1 of `04`: a reference is a pointer, not a statement about the entity.
  // Hoisting it would manufacture an empty observation and, at M0, that exact
  // error turned 3 findings into 15.
  const result = await extract(
    page(ld('{"@context":"https://schema.org","@type":"WebSite","@id":"#w","publisher":{"@id":"#o"}}')),
    PAGE,
    PAGE_ID,
  );
  assert.equal(result.nodes.length, 1);
  assert.equal(result.nodes[0]?.node_id, `${PAGE}#w`);
});

test('blank node ids are stable and derived from position', async () => {
  const markup = ld('{"@context":"https://schema.org","@type":"Article","@id":"#a","author":{"@type":"Person","name":"X"}}');
  const first = await extract(page(markup), PAGE, PAGE_ID);
  const second = await extract(page(markup), PAGE, PAGE_ID);

  const blank = first.nodes.find((node) => node.is_blank);
  assert.notEqual(blank, undefined);
  assert.match(blank?.node_id ?? '', new RegExp(`^_:${PAGE_ID}/json-ld/0/`));
  // Stable across runs given unchanged markup — this is what makes run-to-run
  // diffing possible (`01`).
  assert.deepEqual(
    first.nodes.map((node) => node.node_id),
    second.nodes.map((node) => node.node_id),
  );
});

test('an author-supplied blank label keeps its identity within the block', async () => {
  // Two references to one _:label must not become two nodes.
  const result = await extract(
    page(ld('{"@context":"https://schema.org","@graph":[{"@type":"Organization","@id":"_:org","name":"A"},{"@type":"WebSite","@id":"#w","publisher":{"@id":"_:org"}}]}')),
    PAGE,
    PAGE_ID,
  );
  const blanks = result.nodes.filter((node) => node.is_blank);
  assert.equal(blanks.length, 1);
  assert.match(blanks[0]?.node_id ?? '', /\/org$/);
});

test('property values are always arrays, even singletons', async () => {
  const result = await extract(page(ld('{"@context":"https://schema.org","@type":"Person","name":"X"}')), PAGE, PAGE_ID);
  assert.equal(Array.isArray(result.nodes[0]?.props['http://schema.org/name']), true);
});

test('the same @id defined twice in one block is unioned, not clobbered', async () => {
  const result = await extract(
    page(ld('{"@context":"https://schema.org","@graph":[{"@type":"Organization","@id":"#o","name":"A"},{"@type":"Organization","@id":"#o","telephone":"+44"}]}')),
    PAGE,
    PAGE_ID,
  );
  assert.equal(result.nodes.length, 1);
  const props = Object.keys(result.nodes[0]?.props ?? {}).map(short);
  assert.deepEqual(props.sort(), ['name', 'telephone']);
});

// --- amendment C: raw versus resolved @id -----------------------------------

test('records the raw @id when it differed from the resolved one', async () => {
  const result = await extract(
    page(ld('{"@context":"https://schema.org","@type":"Organization","@id":"#organization","name":"A"}')),
    PAGE,
    PAGE_ID,
  );
  // Grouping uses the resolved IRI; the raw string is what lets one finding
  // cover N pages rather than raising N findings (`00`).
  assert.equal(result.nodes[0]?.node_id, `${PAGE}#organization`);
  assert.equal(result.nodes[0]?.raw_id, '#organization');
});

test('raw_id is null when the author wrote an absolute @id', async () => {
  const result = await extract(
    page(ld('{"@context":"https://schema.org","@type":"Organization","@id":"https://example.com/#o","name":"A"}')),
    PAGE,
    PAGE_ID,
  );
  assert.equal(result.nodes[0]?.raw_id, null);
});

// --- declared canonical ------------------------------------------------------

test('resolves a relative declared canonical', async () => {
  const result = await extract(page('<link rel="canonical" href="/about/">'), PAGE, PAGE_ID);
  assert.equal(result.declared_canonical, 'https://example.com/about/');
});

test('reads an absolute declared canonical and a multi-valued rel', async () => {
  assert.equal(
    (await extract(page('<link rel="canonical" href="https://example.com/x">'), PAGE, PAGE_ID)).declared_canonical,
    'https://example.com/x',
  );
  assert.equal(
    (await extract(page('<link rel="shortlink canonical" href="/y">'), PAGE, PAGE_ID)).declared_canonical,
    'https://example.com/y',
  );
});

test('declared canonical is null when absent', async () => {
  assert.equal((await extract(page('<title>x</title>'), PAGE, PAGE_ID)).declared_canonical, null);
});

// --- other syntaxes are counted, not silently ignored ------------------------

test('records microdata presence and types without a parser', async () => {
  const html =
    '<!DOCTYPE html><html><body>' +
    '<div itemscope itemtype="https://schema.org/Product"><span itemprop="name">X</span></div>' +
    '<div itemscope itemtype="https://schema.org/WPHeader"></div>' +
    '</body></html>';
  const result = await extract(html, PAGE, PAGE_ID);

  assert.equal(result.counts.microdata_items, 2);
  assert.deepEqual(result.microdata_types, ['https://schema.org/Product', 'https://schema.org/WPHeader']);

  // NOT a per-page error. Microdata beside JSON-LD is the normal state of a
  // WooCommerce site; flagging it per page would emit 242 findings across the
  // corpus saying only "we did not look".
  assert.deepEqual(result.errors, []);
});

test('microdata types are deduplicated and multi-valued itemtype is split', async () => {
  const html =
    '<!DOCTYPE html><html><body>' +
    '<div itemscope itemtype="https://schema.org/Blog https://schema.org/CreativeWork"></div>' +
    '<div itemscope itemtype="https://schema.org/Blog"></div>' +
    '</body></html>';
  const result = await extract(html, PAGE, PAGE_ID);
  assert.deepEqual(result.microdata_types, ['https://schema.org/Blog', 'https://schema.org/CreativeWork']);
});

test('Open Graph meta tags are not mistaken for RDFa', async () => {
  const result = await extract(page('<meta property="og:title" content="X">'), PAGE, PAGE_ID);
  assert.equal(result.counts.rdfa_items, 0);
});

test('a page with no structured data extracts cleanly', async () => {
  const result = await extract(page('<title>Nothing here</title>'), PAGE, PAGE_ID);
  assert.equal(result.nodes.length, 0);
  assert.deepEqual(result.errors, []);
  assert.equal(result.counts.json_ld_blocks, 0);
});

// --- two traps found by running against the real corpus ----------------------

test('an @id-typed property value survives as a reference, not stripped', async () => {
  // schema.org's context declares url, logo and sameAs as `"@type": "@id"`, so
  // they expand to {"@id": …} rather than {"@value": …}.
  //
  // This looks like a bare reference, and rule 1 of `04` says a reference is
  // not an observation — but that rule governs whether to HOIST a node, not
  // whether a property value is real. Applying it to values discards every url
  // on the site, which silently loses the flagship M0 finding
  // (a corpus site publishing two url values under one @id).
  const result = await extract(
    page(ld('{"@context":"https://schema.org","@type":"Organization","@id":"#o","url":"https://example.com/about/"}')),
    PAGE,
    PAGE_ID,
  );

  assert.equal(result.nodes.length, 1, 'the url value must not be hoisted into its own node');
  assert.deepEqual(result.nodes[0]?.props['http://schema.org/url'], [
    { '@id': 'https://example.com/about/' },
  ]);
});

test('a blank node embeds its page id, so checks must compare denotation', async () => {
  // Blank node ids are positional and carry page_id, which is right for
  // provenance and wrong for comparison: the same address on two pages gets two
  // ids. Comparing ids raised 150 false "address contradictions" against a
  // healthy site; comparing what the ids denote raised none.
  //
  // This test pins the property that makes the problem detectable, so the
  // constraint on the check engine stays visible.
  const markup = ld('{"@context":"https://schema.org","@type":"Organization","@id":"#o","address":{"@type":"PostalAddress","postalCode":"RG1 1NU"}}');

  const first = await extract(page(markup), 'https://example.com/a/', 'a-1111aaaa');
  const second = await extract(page(markup), 'https://example.com/b/', 'b-2222bbbb');

  const addressOf = (result: Awaited<ReturnType<typeof extract>>) =>
    (result.nodes.find((node) => !node.is_blank)?.props['http://schema.org/address']?.[0] as { '@id': string })['@id'];

  // Identical markup, different blank ids. Comparing these is a false positive.
  assert.notEqual(addressOf(first), addressOf(second));
  assert.match(addressOf(first), /^_:a-1111aaaa\//);

  // What they denote is identical, which is what a check must compare.
  const denote = (result: Awaited<ReturnType<typeof extract>>) => {
    const node = result.nodes.find((candidate) => candidate.is_blank);
    return JSON.stringify({ types: node?.types, props: node?.props });
  };
  assert.equal(denote(first), denote(second));
});
