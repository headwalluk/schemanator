/**
 * Process exit codes.
 *
 * **These are a public contract**, in exactly the way `report.json`'s
 * `report_schema` is. A shell script gates a deploy on them, `crawl-batch.sh`
 * decides whether to continue on them, and an agent branches on them without
 * reading the message — which is what makes a wrong code worse than a wrong
 * sentence. The agent acts on it silently instead of telling you.
 *
 * So they are named here, once, and never written as literals anywhere else.
 * They were bare numbers in `cli.ts` from the initial commit until 1.3.1, spread
 * over sixteen `return` statements and a six-branch `if/else` ladder, with the
 * only description of what they meant living in `docs/usage.md` and
 * `docs/politeness.md` — three places stating a contract, and nothing connecting
 * any of them to the code.
 *
 * **Codes are permanent.** Changing what one means breaks a script somebody
 * wrote months ago and never revisited, and it breaks it silently. Add a new
 * code rather than repurposing an old one.
 */

export const EXIT = {
  /** Completed. **Findings do not affect this** — a report full of errors still exits 0. */
  OK: 0,
  /** Bad arguments, or an unexpected failure. The catch-all. */
  FAILURE: 1,
  /** The crawl stopped early and deliberately — usually repeated `429`s (`02`). */
  CRAWL_ABORTED: 2,
  /** `robots.txt` could not be read, so crawling was refused rather than assumed (`02`). */
  ROBOTS_UNAVAILABLE: 3,
  /**
   * A crawl is already running, and nothing was started.
   *
   * Distinct from `FAILURE` on purpose: this is "wait and retry", where failure
   * is "stop and look". An agent that cannot tell them apart either retries a
   * genuine error forever or gives up on a queue that would have cleared in a
   * minute.
   */
  CRAWL_IN_PROGRESS: 4,
} as const;

export type ExitCodeName = keyof typeof EXIT;
export type ExitCode = (typeof EXIT)[ExitCodeName];

/**
 * Every code that exists, for the documentation-contract test.
 *
 * `docs/usage.md` carries the operator-facing table. The test asserts the two
 * agree in both directions: a code with no row is undocumented, and a row with
 * no code is fiction. That second failure is the one this project has shipped
 * before — see the header of `test/docs-consistency.test.ts`.
 */
export const ALL_EXIT_CODES: readonly ExitCode[] = Object.values(EXIT);
