# The checks

Every check is on by default. Disable one, or a whole group:

```sh
schemanator example.com --disable graph.dangling-reference --disable coverage
```

## Severity

| Severity | Means |
| --- | --- |
| **Error** | Contradictory or broken. Something is definitely wrong |
| **Warning** | Probably wrong, or wrong under a common reading |
| **Opportunity** | Nothing is broken; something is missing or could be better |

There is also a **silenced** bucket, shown in the report summary as *"Considered
and not reported"*. It exists so you can tell the difference between a tool that
looked and decided, and one that missed something. If a report shows three
findings and 1,847 silenced instances, that is a considered result rather than a
shallow scan.

## What is deliberately not reported

**Repetition.** A plugin emitting a byte-identical `Organization` on all 200
pages is correct behaviour, not duplication.

**Partiality.** A property present on some observations of an entity and absent
from others. Plugins do this constantly — a rich node on the homepage, a lean
one sitewide — and nothing is broken: the statements union. Counted, never
listed.

*The one exception is the [`google`](#google--googles-rich-result-requirements)
group, which reports per page because that is the unit Google judges. A field
present on one page and absent on another is a real defect on the second page,
even though the site-level statements still union.*

**Set order.** `sameAs: [A, B]` and `[B, A]` are the same statement.

**Vocabulary validity.** Whether a property is legal on a type is
validator.schema.org's job, and it is free. Nothing here re-implements it.

**Rich-result previews.** What the search result will look like is Google's own
tool. Nothing here guesses at it.

---

## `entity` — one entity, seen across many pages

### `entity.contradiction` — Error

A property that should have one value has several, across observations of the
same `@id`.

> The same `@id` carries `url` = `/about/` on 120 pages and `url` = `/` on 30.

**Why it matters:** nothing reconciles those. A consumer's view of the entity
depends on which page it happened to see.

**How to fix:** emit one value, on every page that describes the entity.

Which properties count as single-valued is a judgement, not a rule the
vocabulary makes — see [Configuration → Functional
properties](configuration.md#functional-properties) if you disagree with ours.

### `entity.page-scoped-value` — Error

The same evidence as a contradiction, but with roughly one distinct value per
page. That is not a disagreement between variants — the property is page-scoped,
so the entity has no stable value at all.

> `url` takes a different value on every one of 150 pages.

**Common cause:** a setting that was never configured, where the generator falls
back to the current page URL. Worth checking the obvious plugin option before
anything else.

### `entity.type-narrowing` — Opportunity

One `@id` described more richly on some pages than others — `LocalBusiness` with
an address and phone on two pages, plain `Organization` on the other forty-five.

Nothing is logically inconsistent: the richer type refines the leaner one. But
nothing unions them either, so a visitor arriving on a lean page sees the
thinner entity.

**This one names a trade-off rather than telling you what to do**, because it is
a question about consumer behaviour that a crawl cannot settle: content-matching
(mark up only what the page displays) against entity consistency (one `@id`
means one entity however you reach it). Your call.

### `entity.type-conflict` — Error

One `@id` declared as types with no relationship — `Person` and `Product`. One
entity cannot be both.

### `entity.multi-value` — Warning

Two values for a single-valued property on **one** page — the within-a-page twin
of `entity.contradiction`.

schema.org permits any property to repeat, so a per-page validator passes this.
Whether a property should be single-valued is our judgement, and it comes from
the same list `entity.contradiction` uses.

---

## `graph` — structural integrity

### `graph.identity-fracture` — Error

Two different `@id`s describing what looks like the same entity.

> Both named "Acme Ltd", with compatible types and the same `url`.

**Why it matters:** nothing can merge them, so the entity's identity is forked
and no consumer sees the whole of it. Both nodes are individually valid, which is
why per-page validators pass this.

Detection is deliberately conservative — a matching name **plus** compatible
types **plus** a corroborating `url` or `sameAs`. Never a name alone, because
"Support" is a plausible name for several different things on one site.

**How to fix:** pick one `@id` and repoint everything that referenced the other.

### `graph.dangling-reference` — Warning

Something references an `@id` that no crawled page defines.

Syntactically valid, so every per-page tool passes it. Under a partial crawl this
is marked as qualified by coverage — the definition may live on a page that was
not fetched.

### `graph.relative-id` — Warning

An entity published under a fragment-only `@id` such as `"#organization"`.

A fragment resolves against the page it sits on, so the same markup on 150 pages
declares 150 different entities and nothing can merge them. Every page looks
correct on its own.

A *root-relative* `@id` like `"/shop"` is **not** reported: it resolves to the
same absolute IRI on every page, so nothing fractures.

**How to fix:** publish an absolute `@id`.

### `graph.blank-node-entity` — Opportunity

A substantial entity — an `Organization`, `Person` or `Product` — published with
no `@id` at all.

> 150 `Person` entities are published with no `@id`.

**Why it matters:** nothing can reference it and nothing can merge it, so what is
almost certainly one author or one company appears to a consumer as N separate
anonymous entities. Each page is valid on its own; the loss only shows when you
look at the whole site.

Reported once per type, not once per node.

### `graph.orphan-node` — Opportunity

A node that nothing references and that cannot mean anything on its own — a
`PostalAddress`, `GeoCoordinates` or `OpeningHoursSpecification` floating free.

Deliberately narrow. It will never tell you an `Article` or a `Product` is
orphaned: nothing links to those precisely because they are what the page is
about.

---

## `url` — identity hygiene

### `url.canonical-mismatch` — Warning

The page's `<link rel="canonical">` disagrees with the URL it was served at.

Both sides are canonicalised before comparison, so a difference in
percent-encoding case is not reported.

### `url.insecure-self-reference` — Warning

Schema pointing at this site over `http` when the site is served over `https`.
Two different IRIs for one resource, so the graph carries two identities.

### `url.trailing-slash-drift` — Opportunity

Both `/foo` and `/foo/` published for the same resource.

Canonicalisation deliberately leaves these alone so this check can see them. To
anything comparing IRIs as strings — which is what consumers do — they are two
resources where you meant one.

### `url.foreign-media-host` — Warning

Images referenced from a host that is neither this site, a subdomain of it, nor
a recognised CDN.

> 3 media URLs on `oldagency.example` referenced as `image`, `url`,
> `primaryImageOfPage`.

**Commonly a migration leftover**, and a common cause of silently broken images.

**schemanator does not fetch off-site media, so it cannot tell you whether these
resolve.** What it can tell you is that your images depend on somebody else's
server. Gravatar, common CDNs and your own subdomains are not reported — see
[Configuration](configuration.md#media-hosts) to add your own.

---

## `value` — what the values actually say

### `value.placeholder` — Error

A value that is a recognised generator or theme default.

> `name` is "My Website", which is a WordPress/Yoast default site name.

Published to consumers as fact, and it almost always means a setting was never
filled in. Matching is against the whole value, never a substring — a site
selling a lorem ipsum generator is not flagged for saying so.

The list is short and will never be complete. Add your own in
[Configuration](configuration.md#placeholder-values).

### `value.empty` — Error

A property emitted with an empty string.

**Worse than an absent property.** Absence says nothing; `""` asserts that the
value exists and is blank, and consumers will not agree on what that means. An
entirely blank `PostalAddress` is the usual instance.

**How to fix:** fill it in, or stop emitting the property when there is nothing
to say.

---

## `coverage` — absence and opportunity

Everything in this group is qualified by how much of the site was audited. Under
a capped crawl these are marked accordingly, because an absence claim is only as
good as the coverage behind it.

### `coverage.no-structured-data` — Opportunity

Pages carrying no structured data at all.

### `coverage.competing-syntax` — Opportunity

Microdata alongside your JSON-LD. Usually theme boilerplate — `WPHeader`,
`SiteNavigationElement`, `Blog` — which adds nothing and competes with a
purpose-built graph. Most themes have a switch to turn it off.

Reported once for the site, not once per page. The entity-level comparison
between the two syntaxes is not performed.

### `coverage.type-gap` — Opportunity

A section of the site where most pages carry a type and a minority do not.
*"2 of 19 `/plugin/` pages carry no `Product`."*

Deliberately hard to trigger, because the obvious version of this check is
useless. It needs a section of **at least 10 pages**, the type present on **at
least 80%** of them, and it only considers types that say what a page is *about*
— so it will never tell you that some of your pages lack a `WebPage` or a
`ReadAction`. A section's own index page (`/shop/`) is not treated as a member of
that section, because an archive page is not a product.

Suppressed entirely under a capped crawl: the pages apparently missing the type
may just be ones that were never fetched.

### `coverage.missing-expected-entity` — Opportunity

Things a business site normally publishes and this one does not: no
`Organization` anywhere, an `Organization` with no `logo`, no `sameAs` links at
all.

Narrow on purpose. It reports only absences that are unambiguous from crawl data,
and it never guesses what a page is *about* — "you have a contact page but no
`LocalBusiness`" needs to read the page, which this tool does not do.

---

## `breadcrumb` — the site as a tree

Every `BreadcrumbList` on the site is assembled into one hierarchy, then the
hierarchy is checked. Individually valid trails can still describe an impossible
site, which is why a per-page validator passes all of them.

A final crumb with no `item` is **normal** and never reported — it is the current
page, so it needs no link.

### `breadcrumb.cycle` — Error

A trail that loops. Either one trail visiting the same page twice
(`/ > /blog/ > /blog/ > post`), or parent links that lead back to where they
started across several pages. Nothing can walk a looping tree to the top.

### `breadcrumb.multiple-parents` — Warning

One page placed under different parents. Reported two ways, because the fix
differs:

- **Two trails on one page disagree.** Two plugins are each emitting breadcrumbs.
  Turn one off.
- **Different pages disagree.** A taxonomy problem — pick the right parent.

### `breadcrumb.broken-trail-item` — Warning

A crumb linking to a page that returned a non-200 status when crawled.

Only pages actually fetched are judged. A crumb pointing somewhere the crawl
never visited is **not** reported: a sitemap-driven crawl routinely never sees
section landing pages, and calling those broken would be a guess dressed as a
finding. Off-site crumbs are not judged either, since we do not fetch other
people's hosts.

### `breadcrumb.inconsistent-depth` — Opportunity

The same page at different depths in different trails, with the same parent
throughout. Not broken — a page reachable by two routes will do this — but
breadcrumbs exist to say how deep a page sits, and this gives two answers.

Suppressed where `breadcrumb.cycle` or `breadcrumb.multiple-parents` already
explains it.

### `breadcrumb.missing` — Opportunity

A page that another page's trail names as a crumb — so the site asserts it has a
place in the hierarchy — which publishes no trail of its own, while its parent
does. Suppressed under a capped crawl.

---

## `syntax` — blocks that never made it into the graph

Both are recorded by extraction rather than computed from the graph: a block that
fails to parse produces no entities, so by the time the checks run the evidence
is already gone.

The cost of either is total and silent — every entity in the block vanishes, and
the page looks merely empty rather than broken.

### `syntax.malformed-json` — Error

A `<script type="application/ld+json">` block that could not be read. Reported as
two distinct problems, because they send you to different places:

- **Not valid JSON.** A trailing comma before a closing brace is the usual cause,
  and the message says so where it can be detected.
- **Valid JSON that would not expand.** Usually a malformed `@context`, or a
  JSON-LD keyword used where the algorithm does not allow one. A syntax checker
  will pass this file.

The raw text is kept verbatim under `pages/<page-id>/raw/`, so you can see
exactly what was emitted. A malformed block never aborts the page — everything
else on it is still extracted.

### `syntax.unresolvable-context` — Error

An `@context` that could not be resolved. schema.org is bundled; anything else is
refused rather than fetched, because a crawl that depends on a third party's
server being up is not reproducible.

---

## `google` — Google's rich-result requirements

The one group that reports **per-page** problems, and the one that overlaps with
something you can already see elsewhere: these are the findings Search Console
raises against your site under *Products*, *Events*, *Merchant listings* and the
rest.

They are here because they are a different question from everything above.
Nothing in this group is a contradiction — the markup is valid, self-consistent,
and usually identical on every page. It is simply missing a field Google needs
before it will show a rich result.

**This is not vocabulary validation.** Every rule here concerns markup
validator.schema.org already passes. Google's requirements are a publisher policy
layered on top of the vocabulary, published per feature, and the only tools that
apply them are Search Console — which reports pages Google has already crawled,
with no pointer to the block or node — and the Rich Results Test, one URL at a
time. What this adds is the whole site at once, with provenance.

Requirements live in `data/google-rich-results.json`, and every type cites the
Google page it came from.

**Types covered:** `Product`, `Offer`, `AggregateOffer`, `Event`, `Place`,
`VirtualLocation`, `LocalBusiness`, `Review`, `AggregateRating`, `Rating`,
`VideoObject`, `FAQPage`, `Question`, `Answer`.

**Types deliberately not covered:** `Recipe`, `JobPosting`, `HowTo`, `Course`,
`Book` and `Movie`, none of which appear in the corpus this tool is tested
against — an unchecked rule is how false positives ship. `Article` and its
subclasses, because Google's required set for them is now nearly empty.
`Organization`, because it is sitewide header markup and judging it per page
floods the report.

Three things shape how this group behaves, and all three are worth knowing:

- **A nested type is judged in its parent's context, never alone.** An `Offer`
  nothing references is not a finding; the price requirement belongs to the
  product snippet, not to every `Offer` in existence.
- **The most specific type wins.** An `AggregateOffer` is judged as one, not as
  the `Offer` it inherits from — it carries `lowPrice` where an `Offer` carries
  `price`, and asking it for the wrong one is a false positive.
- **One omission is one finding, however many pages carry it.** A generator
  omitting `review` on 250 products is one setting and one fix.

### `google.missing-required` — Error

A field Google requires is absent, so the rich result cannot appear at all.

An `Event` with no `location`, a `LocalBusiness` with no `address`. The markup is
valid schema.org, which is exactly why it survives every other kind of checking.

### `google.incomplete-alternative` — Error

None of a set Google requires at least one of.

A `Product` needs `offers`, `review` or `aggregateRating` — any one will do.
Reported as a set rather than as three missing fields, because the fix is one
choice rather than three edits.

### `google.missing-recommended` — Opportunity

A field Google recommends is absent. Nothing is broken and the result can still
appear; it will simply be thinner than it could be. These are the entries Search
Console lists as warnings.

**Only act on these where the fact exists.** The check reports an absence and
cannot tell whether you have anything true to put there. Ratings nobody gave and
reviews nobody wrote are a guidelines violation that risks a manual action, and a
business reviewing itself is ineligible for stars however the markup is written —
so every finding here carries that trade-off with it.

`bestRating` and `worstRating` are recommended by Google and deliberately **not**
reported: they default to 5 and 1, so their absence says nothing.

---

## `robots` — can a machine fetch the site at all?

The first thing that can stop a consumer, before indexing and before anything
else. If `robots.txt` says no, nothing downstream matters.

These read the `robots.txt` your crawl already stored verbatim, so they need no
network and work on any existing crawl.

### `robots.ai-crawler-blocked` — Warning

`robots.txt` disallows crawlers that feed AI systems — `GPTBot`, `ClaudeBot`,
`Google-Extended`, `PerplexityBot` and others. The full list, with a citation
for every token, is in `data/ai-crawlers.json`.

**This may be exactly what you intended, and if so there is nothing to do.** It
is reported because the block is more often inherited than chosen: WordPress
security and SEO plugins add these by default, and an unexamined default is
worth seeing once. Confirming it and moving on is a perfectly good outcome —
`--disable robots.ai-crawler-blocked` silences it for good.

The finding separates two things that need different decisions:

- **Training** crawlers collect text to train a model. Blocking them does not
  affect whether an assistant can answer questions about your site today.
- **Retrieval** crawlers fetch a page to answer a user's question *at the moment
  they ask it*, often because that user asked about your site. Blocking those
  makes you invisible exactly when somebody is looking for you.

A site blocking *everything* — `User-agent: *` with `Disallow: /` — is not
reported here. That is a much larger problem, and burying it inside a finding
about AI crawlers would be the wrong headline.

### `robots.resource-blocked` — Warning

CSS, JavaScript or theme assets disallowed for all crawlers. Google renders a
page before judging it, so blocking these means it sees an unstyled skeleton —
and any conclusion that depends on layout is drawn from something no visitor
ever sees.

Blocking `/wp-admin/` is normal and is not reported. Blocking
`/wp-content/themes/` or `/wp-includes/` is. An `Allow` rule covering the same
path is the documented fix and silences the finding.

### `robots.sitemap-missing` — Opportunity

Sitemaps exist and were found by probing well-known paths, but `robots.txt`
carries no `Sitemap:` line. Nothing is broken — the major search engines probe
the same paths — but a crawler that does not guess has no way to find them, and
the directive is one line.

---

## `indexing` — the signals disagree about whether to index a page

The group closest to what this tool already does everywhere else. Every check
here is **two claims contradicting each other**: a sitemap entry is a request to
index, a `404` is the page saying it does not exist, and both cannot be true.

Everything in this group reads data the crawl already stored. No re-crawl.

### `indexing.sitemap-dead-url` — Error

A sitemap lists URLs that return 404 or 5xx. A sitemap is a set of claims that
these pages exist and are worth indexing; the server disagrees. Reported once
per status code rather than once per URL.

Stale entries usually mean the generator's sitemap cache needs clearing.

### `indexing.sitemap-redirects` — Warning

A sitemap lists URLs that redirect. Nothing is broken and the destination is
reached, but the sitemap nominates a URL the site itself disclaims — so every
crawler pays an extra request, and the sitemap and the redirect disagree about
which URL is real.

Keep the redirects; update the sitemap to list the destinations.

### `indexing.redirect-chain` — Opportunity

Two or more hops before a page is served. Chains are usually accidental — two
migrations layered on each other, where the first rule was never repointed at
the final destination.

### `indexing.canonical-to-redirect` — Warning

A page declares a canonical URL which then redirects somewhere else. The
canonical claims that URL is authoritative; the redirect says it is not. Which
claim wins is not something you control.

### `indexing.canonical-chain` — Warning

A canonicals to B, and B canonicals to C. Consumers generally follow one hop, so
the end of the chain may never be reached.

### `indexing.thin-sitemap-entry` — Opportunity

URLs in the sitemap with fewer than 25 words of their own content, once site
furniture is removed. A sitemap is a request to index, and these have little to
index — carts, baskets, account screens, login gates and thank-you pages are the
usual set.

**Read the list before acting.** Word count cannot tell a cart from a contact
page: a contact page is often a form and a phone number, and belongs in the
sitemap. Transactional and account pages generally do not, and are usually
better set to `noindex`.

It does **not** claim to find low-value *archives*. That was designed and then
measured away: on the test corpus a WooCommerce product archive renders full
descriptions and scores 0.00 links per word, while a single product page scores
0.03 — archives look exactly like content pages by every text measure available
here. An archive with nothing unique on it still needs a human eye.

### `indexing.duplicate-content` — Warning

Two distinct URLs returning byte-identical content. Indexing has to choose which
represents the page, and anything you have said about one of them — links,
canonicals, structured data — is split across the set.

**This compares whole responses, so it finds only exact duplicates.** Two pages
differing by a single highlighted menu item are not reported. Near-duplicate
detection needs text extraction and is not built yet.

URLs that *redirect* to one page are not duplicates and are not reported here —
`indexing.sitemap-redirects` covers those, and billing one defect twice helps
nobody.

### `indexing.sitemap-duplicate-url` — Opportunity

The same URL listed more than once inside one sitemap. Nothing is broken —
every consumer deduplicates, as this crawler does, and no page is fetched twice
because of it.

It is worth seeing because a sitemap is generated, and a generator emitting one
URL twice is usually joining across something it should be collapsing: a post
that appears under two taxonomies feeding the same file, or a query missing a
`DISTINCT`.

### `indexing.sitemap-overlap` — Opportunity

The same URL listed in more than one sitemap of an index. An index exists to
divide a site between files, so a URL in two of them means one generator's idea
of what belongs where is wrong.

Reported per pair of files rather than per URL, because the fix is at the file
level. Worth checking whether the smaller file is contributing anything at all:
one site audited during development had a product sitemap whose every entry was
either a duplicate of another file's or a URL that redirected away.

> **Both need a crawl from 1.12.0 or later.** Deduplication happens while
> sitemaps are being read, so a repeat is invisible by the time any page record
> exists. Older crawls report nothing here — and *nothing* means "not measured",
> not "none found". Unlike most of this tool, re-running `analyse` cannot fill it
> in; it takes a re-crawl.

---

## `content` — the page was fetched, but can a machine find the content?

The group that answers the question the rest of this tool cannot: an AI agent
fetches your page, and does it actually get the words?

**Every check here is a discrepancy, not a judgement.** This tool has no opinion
about whether your copy is any good — that is the copywriter's job. What it can
say is that two views of the same page disagree: plenty of text is present, and
a machine reading the document's own structure finds almost none of it.

The de-boilerplated page is written to `pages/<page-id>/content.md`, so you can
read exactly what a machine gets.

### `content.not-extractable` — Error

Substantial text sitting **outside** the page's own `<main>` and `<article>`
landmarks. A consumer following those landmarks — which is what most AI agents
and a `web_fetch` do — reads a fraction of what a person sees.

> A 2,030-word article whose landmarks hold 32 words.

The usual cause is a body wrapped in a plain `<div>` while `<article>` is used
for something else, such as related-post cards.

Only reported where the page has at least 50 words and does carry a landmark.
A short page is not a finding — thinness is not a machine-readability defect.

### `content.javascript-only` — Error

A large response containing almost no readable text: the signature of content
assembled in the browser.

**schemanator does not run JavaScript, and here that is the point rather than a
limitation.** It sees exactly what a non-rendering consumer sees, which is what
most AI agents are and what Google's first indexing pass is.

Both thresholds are extreme — over 50 KB, under 100 words — because a contact
page is allowed to be short.

### `content.main-in-aside` — Warning

More of the page's text in `<aside>` than in `<main>` and `<article>` combined.
`<aside>` means "tangential", and extractors commonly drop it — so if that is
where the substance lives, the substance is what gets dropped.

### `content.hidden-text` — Warning

More words behind `hidden` or `aria-hidden` than in the open.

Tabs, accordions and mobile menus are normal and are **not** reported: hidden
navigation is excluded, and both sides must carry real text. This is a page
whose substance is concealed from anything honouring those attributes, which
includes screen readers and most text extractors.

### `content.no-landmark` — Opportunity

Neither `<main>` nor `<article>` anywhere on a page that has real text, so a
consumer must guess which part of the page is the page. Most get it right most
of the time; the ones that do not fail silently.

Reported once for the site — it is one template decision however many pages
carry it.

---

## `page` — the content was found, but can a machine parse the document?

Everything here is something a machine *uses* to build its model of the page.
Nothing here is a style opinion, and each check reports **once for the site**: a
per-page finding for missing alt text on a 500-page site is 500 findings
describing one template.

### `page.title-missing` — Error

No `<title>`. It is the strongest single signal a machine has for what a page
is, used as the heading in search results and as the label almost everywhere
else a page is referenced.

### `page.h1-missing` — Warning

No top-level heading, so a consumer building an outline has nothing to hang it
on and the page's own statement of what it is about is missing.

### `page.h1-multiple` — Opportunity

More than one `<h1>`.

**This is valid HTML and Google has said it is fine**, so nothing is broken —
the finding exists because a consumer picking one line to represent the document
has to choose, and it will not always choose the one you meant. The one-`h1`
rule is HTML4 and is still widely repeated as though it applied; this is
reported as an ambiguity to resolve, not an error to fix.

### `page.image-alt-missing` — Warning

Images with **no `alt` attribute at all**. To anything reading the page as text
an image without alt is simply absent — whatever it shows, says or sells is
invisible to a search engine, an AI agent and a screen reader alike.

An explicitly empty `alt=""` is *not* reported: that is the correct way to mark
an image as decorative.

### `page.image-alt-useless` — Warning

Alt text that exists and describes nothing — `1000005782`, `IMG`, `untitled`.
It passes every automated check that only asks whether the attribute exists, and
tells a reader nothing, which is arguably worse than an empty one because it
looks handled.

A file extension alone is not enough to qualify: `Rural Pie Co logo.jpg`
describes its image perfectly well and is not reported.

### `page.lang-missing` — Opportunity

No `lang` on `<html>`, so anything processing the text has to guess the
language. Guessing is usually right, and silent when it is not.

### `page.title-duplicate` — Warning

One title used on several pages. Site-wide by nature, so a per-page tool can see
a title but not that it is shared. Where several pages claim the same title,
nothing distinguishes them — not in a search result, and not to anything
deciding which of them to keep.

**Not reported:** skipped heading levels. 549 of 1,831 pages in the test corpus
skip one — 29% — so at that incidence it is normal practice rather than a
defect, and a slightly malformed outline does not stop a machine consuming the
page. Title and description *length* are excluded too: Google truncates on pixel
width, and nobody can act on "63 characters" without looking at the page.

---

## Not yet implemented

Designed and specified, but **not built** — they will not appear in a report:

| Check | Would report |
| --- | --- |
| `entity.formatting-drift` | Values differing only in spelling — `+44 118 334 4955` against `+441183344955` |
| `url.schema-url-mismatch` | A node's `url` disagreeing with the page it was found on |
| `url.host-drift` | Schema URLs using a different host spelling than the crawl |
