# Developer documentation

For people working **on** schemanator. If you are working *with* it — crawling a
site and reading a report — you want [`../`](../) instead, starting at
[usage](../usage.md).

| Document | Covers |
| --- | --- |
| [Getting started](./getting-started.md) | Clone, install, run, and what to check before you commit |
| [Writing tests](./writing-tests.md) | The test layout, the four kinds of test here, and how to add one |
| [Adding a check](./adding-a-check.md) | The full loop for a new check, including the shakedown that catches what review does not |

## The one thing to read first

**Repetition is normal; divergence is the bug.**

SEO plugins repeat identical entity nodes on every page by design. A tool that
flags that as duplication emits hundreds of findings on a healthy site and gets
uninstalled the same day. Only *divergence* under a shared `@id` is a finding.

Everything else here is downstream of that.

## A note on `dev-notes/` citations

Source comments and these documents cite `dev-notes/NN` in a few places. That is
an **internal design archive, and it is not published with this repository.** It
records what each check is for and what the 22-site validation corpus proved —
which means it names real client sites alongside the defects found on them, and
that is precisely what cannot be public.

**Nothing here depends on having it.** Those references are citations rather than
links, in the way a code comment might cite a ticket number. Every one states its
substance inline, because a comment that only points elsewhere is not worth
writing — so `// Amendment A in dev-notes/00: do not use jsonld.flatten` tells
you the rule, and the citation only says where it was argued out.

If a comment ever cites the archive *without* saying what it means, that is a bug
in the comment. Fix the comment.
