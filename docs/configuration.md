# Configuration

Everything is optional. schemanator runs with no configuration at all; this is
for defaults you get tired of retyping, and for tuning the rules when your site
is unusual.

## Precedence

Lowest to highest:

```
built-in defaults → environment → CLI flags
```

## Config file — not yet implemented

There is no config file yet. Everything is set by environment variable or
command-line flag.

A file at `$XDG_CONFIG_HOME/schemanator/config.json` is designed and will slot
in between defaults and environment, so that anything settable by a flag is also
settable persistently. Until then, a shell alias or a wrapper script is the way
to avoid retyping:

```sh
alias scan='SCHEMANATOR_CONTACT=https://your-site.example/contact \
            schemanator --delay 2000 --max-pages 200'
```

## Environment variables

| Variable | Effect |
| --- | --- |
| `SCHEMANATOR_CONTACT` | Contact URL in the `User-Agent`. **Set this before crawling anything you do not own** |
| `SCHEMANATOR_WORK_DIR` | Where output goes |
| `SCHEMANATOR_ENV` | `development` or `installed`. Normally detected |
| `LOG_LEVEL` | `silent`, `error`, `warn`, `info`, `debug` |

`NODE_ENV` is read as a fallback for `SCHEMANATOR_ENV` (`production` maps to
`installed`), but never written — it is a shared convention with effects well
beyond this tool.

## Runtime mode

Detected, not configured: is the running module inside `node_modules` or not?
That covers `npx`, a global install and a project dependency alike.

| | From a checkout | Installed |
| --- | --- | --- |
| Work directory | `./work` | `$XDG_STATE_HOME/schemanator` |
| `by-type/` browsing view | written | not written |
| Errors | full stack trace | message only |

**Nothing about checking changes.** A finding never depends on how the tool was
installed.

## Logging

Five levels. `info` is the default: the crawl narrative and per-page progress.
`warn` drops to sitemap problems and dropped entries; `debug` adds per-sitemap
detail.

**Logs always go to stderr, reports to stdout.** So `schemanator example.com >
report.md` gives you a clean file no matter what the log level is.

An invalid level is a loud error rather than a silent fallback — a typo in
`LOG_LEVEL` should not quietly change what you see.

## Tuning the rules

Two data files ship with schemanator. Both are plain JSON, both are meant to be
tuned, and both record *why* each entry is there so you can judge whether it
applies to your site.

### Functional properties

`data/functional-properties.json` decides which properties may only have one
value — the difference between a contradiction and a property that is simply
plural.

```jsonc
{
  "default_cardinality": "multi-valued",
  "properties": {
    "https://schema.org/telephone": {
      "cardinality": "functional",
      "basis": "asserted",
      "note": "Stricter than RDF on purpose…"
    }
  }
}
```

`basis` distinguishes what was measured from what was decided:

- **`observed`** — real markup was seen carrying two values, so it is
  definitively plural. Empirical.
- **`asserted`** — a deliberate policy, stricter than the vocabulary requires,
  because a divergence is worth reporting.

`telephone` is the clearest case. A business genuinely can have two numbers, and
validator.schema.org is happy with that — but publishing *different* numbers
under one `@id` on different pages is exactly what this tool exists to catch.

**Anything not listed is treated as plural, and therefore never raises a
contradiction.** The costs are not symmetric: a missing entry costs one
unreported finding, while a wrong one costs a false contradiction on every site
that uses the property legitimately. Eleven properties are listed as functional
out of the hundred-plus that appear in real markup, and that ratio is
deliberate.

**Editing it currently means editing the shipped file.** Pointing at your own
copy arrives with the config file.

### Placeholder values

`data/value-heuristics.json` holds the values that mean "nobody filled this in".

```jsonc
{
  "placeholders": [
    {
      "pattern": "^my website$",
      "label": "WordPress/Yoast default site name",
      "basis": "observed"
    }
  ]
}
```

Patterns are case-insensitive regular expressions matched against the **trimmed
whole value**. Anchor yours with `^` and `$`: a site selling a lorem ipsum
generator should not be told its own product name is a placeholder.

There is exactly one unanchored pattern in the shipped file — `unexecuted
template code`, which matches `<?php`, `{{…}}`, `%%…%%` and `${…}` anywhere in a
value. Template code is a fragment by nature and turns up wrapped in whatever
text surrounded it, so it cannot anchor, and it is safe unanchored because no
legitimate value contains `<?php`. Hold a second exception to the same standard.

The list will never be complete, and that is fine — the cost of a gap is a
missed finding, not a false one.

### Media hosts

The same file lists hosts that may legitimately serve your images. Subdomains of
your own domain are always allowed and need no entry — `cdn.example.com` serving
`example.com`'s images is the normal shape of a CDN.

Gravatar and the common CDNs are listed because otherwise
`url.foreign-media-host` fires on nearly every WordPress site and is worthless.
Add your own image host here if you use one that is not covered — again, by
editing the shipped file for now.

## Turning checks off

```sh
schemanator example.com --disable graph.dangling-reference
schemanator example.com --disable coverage           # the whole group
```

Disabled checks are listed at the bottom of every report, so a quiet report is
never quiet because somebody turned something off and forgot.

## URL canonicalisation

URLs are normalised before being stored, hashed or compared: lowercased scheme
and host, punycode, default ports stripped, dot-segments resolved,
percent-encoding normalised, fragments stripped, tracking parameters removed,
query parameters sorted.

The built-in tracking-parameter list covers `utm_*`, `fbclid`, `gclid` and
friends. Extending it needs the config file. Use `--no-sort-query` if your site
is order-sensitive.

**Three things are deliberately *not* normalised:** trailing slash, `www` versus
bare host, and `http` versus `https`. Collapsing those would hide exactly the
identity fractures this tool exists to report.
