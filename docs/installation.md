# Installation

## Requirements

**Node.js 22 or later.** The published package is plain JavaScript, so any
Node 22 will run it.

Nothing else. No database, no headless browser, no native modules — the
filesystem is the datastore, and the runtime dependencies are a JSON-LD
processor, an HTML parser, a robots.txt parser and an XML parser.

> **Working from a checkout needs Node 22.18 or later**, which is where
> TypeScript stripping runs without a flag. The repository has no build step in
> development; the build exists only so installed users on 22.0–22.17 are not
> excluded.

## Run it without installing

```sh
npx @headwall/schemanator example.com
```

The first run downloads the package; subsequent runs are cached by npm. Nothing
is fetched from schema.org at any point — the vocabulary is bundled — so it
works offline apart from crawling the site itself.

## Install locally

```sh
npm install --save-dev @headwall/schemanator
npx schemanator example.com
```

## Install globally

```sh
npm install --global @headwall/schemanator
schemanator example.com
```

## From a checkout

```sh
git clone https://github.com/headwalluk/schemanator.git
cd schemanator
npm install
npm run schemanator -- example.com
```

A checkout needs **Node 22.18 or later**, unlike the published package — that is
where type stripping runs without a flag, and a checkout has no build step.

Running from a checkout changes three things — see
[Configuration → Runtime mode](configuration.md#runtime-mode). The important one
is that output goes to `./work` beside the code rather than into your home
directory.

## Where output goes

| How you installed it | Output directory |
| --- | --- |
| `npx`, global, or a dependency | `$XDG_STATE_HOME/schemanator`, usually `~/.local/state/schemanator` |
| From a git checkout | `./work` in the repository |

Override with `--work-dir` or `SCHEMANATOR_WORK_DIR`.

**It is state, not cache.** A crawl of a large site takes hours, so it is
deliberately somewhere a cache cleaner will not delete it mid-run. It is also
not in your Documents folder: the contents are bulk machine-generated copies of
somebody else's website, not something you authored.

### It can get large

Measured across 1,829 pages of real sites: **about 250 KB of stored HTML per
page**, and roughly 370 KB per page once the extracted nodes and raw blocks are
counted. So a 500-page site is around 125 MB of HTML, or 180 MB all in.

The stored HTML is what lets you re-analyse a crawl without re-fetching it, but
it is disposable:

```sh
find ~/.local/state/schemanator -name page.html -delete
```

Everything except re-analysis still works afterwards.

One wrinkle worth knowing: `pages.jsonl` carries an `html_purged` flag, and
deleting the files by hand does not set it. The manifest will still say the HTML
is there. Nothing reads that flag today, so nothing breaks — but do not trust it
after a manual purge.

## Before you crawl anything you do not own

Set a contact URL. It goes in the `User-Agent`, and it is how someone seeing you
in their logs works out who you are and how to ask you to stop.

```sh
export SCHEMANATOR_CONTACT=https://your-site.example/contact
```

See [Politeness](politeness.md).

## Verifying the install

```sh
schemanator example.com --dry-run
```

This fetches `robots.txt` and the sitemaps, prints the URL list it *would*
crawl, and fetches no pages. About four requests, and a quick way to confirm
both that it works and that the site is reachable.
