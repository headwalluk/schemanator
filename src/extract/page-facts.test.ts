import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  extractBlocks,
  extractLinks,
  extractPageFacts,
  hammingDistance,
  isChromeCandidate,
  isUselessAlt,
  loadDom,
  renderMarkdown,
  simhash,
} from './page-facts.ts';

const PAGE = `<!doctype html>
<html lang="en-GB">
<head>
  <title>Managed hosting</title>
  <meta name="description" content="Fast hosting.">
  <meta name="robots" content="noindex, follow">
  <link rel="alternate" hreflang="en-GB" href="https://example.com/">
</head>
<body>
  <nav><ul><li><a href="/">Home</a></li><li><a href="/contact/">Contact</a></li></ul></nav>
  <main>
    <h1>Managed hosting</h1>
    <p>We host WordPress sites with daily backups and constant monitoring.</p>
    <h2>What is included</h2>
    <p>Every plan includes automatic updates and a staging environment for testing.</p>
    <img src="a.jpg" alt="A rack of servers">
    <img src="b.jpg">
    <img src="DSC00213.JPEG" alt="DSC00213.JPEG">
    <p hidden>This paragraph is hidden from every reader that respects it.</p>
  </main>
  <footer><p>Copyright Acme Limited, all rights reserved worldwide.</p></footer>
</body></html>`;

const dom = () => loadDom(PAGE);

test('facts are read from the document, not guessed', () => {
  const facts = extractPageFacts(dom(), extractBlocks(dom()));

  assert.equal(facts.title, 'Managed hosting');
  assert.equal(facts.meta_description, 'Fast hosting.');
  assert.equal(facts.html_lang, 'en-GB');
  assert.deepEqual(facts.heading_levels, [1, 2]);
  assert.deepEqual(facts.hreflang, [{ lang: 'en-GB', href: 'https://example.com/' }]);
  assert.equal(facts.landmarks.has_main, true);
  assert.equal(facts.landmarks.has_article, false);
});

test('robots directives are parsed into the two decisions that matter', () => {
  const facts = extractPageFacts(dom(), []);
  assert.equal(facts.robots.index, false);
  assert.equal(facts.robots.follow, true);
  assert.equal(facts.robots.raw, 'noindex, follow');
});

test('a page with no robots meta is indexable, and says so honestly', () => {
  const facts = extractPageFacts(loadDom('<html><body><p>x</p></body></html>'), []);
  assert.equal(facts.robots.index, true);
  assert.equal(facts.robots.raw, null);
});

test('images are counted, and useless alt text is sampled', () => {
  const facts = extractPageFacts(dom(), []);
  assert.equal(facts.images.total, 3);
  assert.equal(facts.images.missing_alt, 1, 'no alt attribute at all');
  assert.deepEqual(facts.images.suspect_alt, ['DSC00213.JPEG']);
});

test('an empty alt is decorative, not useless', () => {
  // `alt=""` is the correct way to mark an image as decorative. Reporting it
  // would tell people to break a page that is already right.
  assert.equal(isUselessAlt(''), false);
  assert.equal(isUselessAlt('   '), false);
  assert.equal(isUselessAlt('A rack of servers'), false);

  for (const useless of ['DSC00213.JPEG', 'IMG_4021', 'image1', 'untitled', 'photo.png', '12345']) {
    assert.equal(isUselessAlt(useless), true, `${useless} should be useless`);
  }
});

// --- blocks ------------------------------------------------------------------

test('only innermost blocks are counted, so text is not billed twice', () => {
  // A `p` inside a `td` would otherwise contribute its words to both, inflating
  // every word count and corrupting the chrome frequency counts.
  const blocks = extractBlocks(
    loadDom('<table><td><p>One two three four five words</p></td></table>'),
  );
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0]?.tag, 'p');
});

test('short blocks are kept, because length is not evidence of boilerplate', () => {
  // An earlier version dropped anything under four words and quietly censored
  // the document: "What is included" is three, so nearly every heading on every
  // page vanished from the markdown. Frequency decides chrome, not length.
  assert.equal(extractBlocks(loadDom('<p>Home</p><p>Menu</p>')).length, 2);
});

test('headings are never candidates for chrome', () => {
  // A site using the same section heading throughout — "Specification",
  // "Opening hours" — would otherwise have its outline stripped out by its own
  // consistency.
  const blocks = extractBlocks(loadDom('<h2>Specification</h2><p>Some prose here</p>'));
  assert.deepEqual(
    blocks.filter(isChromeCandidate).map((block) => block.tag),
    ['p'],
  );
});

test('hidden text is marked rather than dropped', () => {
  // It is still in the DOM, so a consumer *might* see it. The finding is the
  // discrepancy, so both halves have to be measurable.
  const hidden = extractBlocks(dom()).filter((block) => block.hidden);
  assert.equal(hidden.length, 1);
  assert.match(hidden[0]?.text ?? '', /hidden from every reader/);
});

// --- links -------------------------------------------------------------------

test('links resolve, and internal is decided by host', () => {
  const links = extractLinks(dom(), 'https://example.com/hosting/', 'example.com');
  assert.deepEqual(
    links.map((link) => link.to),
    ['https://example.com/', 'https://example.com/contact/'],
  );
  assert.equal(
    links.every((link) => link.internal),
    true,
  );
});

test('non-navigational hrefs are not links', () => {
  const links = extractLinks(
    loadDom(
      '<a href="#top">a</a><a href="mailto:x@y.z">b</a><a href="tel:123">c</a><a href="javascript:void(0)">d</a>',
    ),
    'https://example.com/',
    'example.com',
  );
  assert.deepEqual(links, []);
});

test('fragments are stripped so one page is one target', () => {
  // `/pricing#basic` and `/pricing#pro` are the same page. Counting them
  // separately would understate how often a nav target appears.
  const links = extractLinks(
    loadDom('<a href="/pricing#basic">a</a><a href="/pricing#pro">b</a>'),
    'https://example.com/',
    'example.com',
  );
  assert.deepEqual([...new Set(links.map((link) => link.to))], ['https://example.com/pricing']);
});

// --- simhash -----------------------------------------------------------------

test('simhash is stable and near-identical text stays near', () => {
  const original = 'The quick brown fox jumps over the lazy dog on a warm afternoon in June';
  const nudged = `${original} today`;
  const different = 'Structured data describes entities so machines can consume a website reliably';

  assert.equal(simhash(original), simhash(original), 'must be deterministic across runs');
  assert.equal(
    hammingDistance(simhash(original), simhash(nudged)) < 16,
    true,
    'one extra word must not look like a different document',
  );
  assert.equal(
    hammingDistance(simhash(original), simhash(different)) > 16,
    true,
    'unrelated text must not look like a near-duplicate',
  );
});

test('simhash survives empty and tiny input', () => {
  assert.equal(simhash('').length, 16);
  assert.equal(simhash('one two').length, 16);
});

// --- markdown ----------------------------------------------------------------

test('markdown carries the content and drops the chrome', () => {
  const blocks = extractBlocks(dom());
  const footer = blocks.find((block) => block.text.startsWith('Copyright'));
  assert.notEqual(footer, undefined);

  const markdown = renderMarkdown(blocks, new Set([footer?.hash ?? '']), 'Managed hosting');

  assert.match(markdown, /^# Managed hosting$/m);
  assert.equal(markdown.includes('- Home'), false, 'nav is chrome by declaration');
  assert.match(markdown, /daily backups/);
  assert.match(markdown, /^## What is included$/m, 'headings keep their own level');
  assert.equal(
    (markdown.match(/^# Managed hosting$/gm) ?? []).length,
    1,
    'the title must not be printed twice when the h1 already says it',
  );
  assert.equal(markdown.includes('Copyright'), false, 'chrome must not reach the markdown');
  assert.equal(markdown.includes('hidden from every reader'), false, 'nor must hidden text');
});

test('markdown is readable prose rather than a dump', () => {
  // The whole reason it is stored: an operator can hand it to an agent and ask
  // about the opening paragraphs. That only works if it reads like a document.
  const markdown = renderMarkdown(extractBlocks(dom()), new Set(), 'Managed hosting');
  assert.equal(markdown.includes('<'), false, 'no markup should survive');
  assert.equal(markdown.endsWith('\n'), true);
  assert.equal(/\n{3,}/.test(markdown), false, 'no runs of blank lines');
});
