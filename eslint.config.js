// @ts-check
/**
 * ESLint, kept narrow on purpose.
 *
 * `tsconfig` already runs `strict` plus `noUncheckedIndexedAccess` and
 * `exactOptionalPropertyTypes`, and four suites enforce the things that
 * actually go wrong here — `docs-consistency`, `exit-codes`, `contract` and
 * `data-files`. **A linter enforces shape; those enforce meaning**, and no rule
 * set was ever going to catch "this documented check does not exist" or "this
 * error class has an exit code nobody chose".
 *
 * So this exists to catch the mechanical class the compiler does not, and to
 * keep style consistent across Paul's projects. It is not the quality gate.
 *
 * ## Two things here are load-bearing and must not be "fixed"
 *
 * 1. **Real `.ts` import specifiers.** `import … from './foo.ts'` is what makes
 *    the no-build-step development loop work — Node ≥ 22.18 strips types
 *    natively, so there is nothing to resolve `.js` to. Any rule that rewrites
 *    or complains about them breaks `node src/cli.ts`.
 * 2. **`erasableSyntaxOnly`.** No enums, no parameter properties, no namespaces.
 *    The compiler enforces it; nothing here should second-guess it.
 */

import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    // Build output, vendored data, and other people's website content.
    ignores: ['dist/', 'work/', 'node_modules/', 'data/'],
  },

  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,

  {
    languageOptions: {
      parserOptions: {
        // Follows tsconfig, which is what knows about `.ts` specifiers and
        // `allowImportingTsExtensions`.
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },

    rules: {
      /**
       * Deliberately OFF: `no-magic-numbers`.
       *
       * It fires on `0`, `1`, `-1` and every array index, and the rule that
       * actually matters here is about *identifiers and contracts* — check ids,
       * group names, exit codes — which is stated in `CLAUDE.md` and enforced by
       * `exit-codes.test.ts`. A noisy rule everybody disables inline is worse
       * than no rule, because the inline disables train people to stop reading.
       */

      // Unused arguments are usually a signature being honoured, so only
      // complain when nothing prefixed with `_` explains it.
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' },
      ],

      // `any` is already excluded by `strict`; where it appears it is at a
      // JSON boundary and deliberate, and the code casts through `unknown`.
      '@typescript-eslint/no-explicit-any': 'error',

      /**
       * Downgraded, not disabled: the codebase is full of `JSON.parse` results
       * flowing into hand-rolled validators, which is exactly what these rules
       * describe. The validators are the point — see `data-files.test.ts` — so
       * the pattern is intended, but a warning is still worth seeing when it
       * appears somewhere new.
       */
      '@typescript-eslint/no-unsafe-assignment': 'warn',
      '@typescript-eslint/no-unsafe-member-access': 'warn',
      '@typescript-eslint/no-unsafe-argument': 'warn',
      '@typescript-eslint/no-unsafe-call': 'warn',
      '@typescript-eslint/no-unsafe-return': 'warn',

      /**
       * A floating promise in a crawler is a write that may never land, so this
       * stays on — but `node:test`'s `test()` returns a promise nobody is meant
       * to await, and the rule fired **402 times** on the idiom every suite in
       * this repository uses. Allow-listing the three entry points keeps the
       * rule live for genuinely floating work in the same files.
       */
      '@typescript-eslint/no-floating-promises': [
        'error',
        {
          allowForKnownSafeCalls: [
            { from: 'package', package: 'node:test', name: 'test' },
            { from: 'package', package: 'node:test', name: 'describe' },
            { from: 'package', package: 'node:test', name: 'it' },
          ],
        },
      ],
      '@typescript-eslint/require-await': 'error',
    },
  },

  {
    // Tests reach into internals and assert on loosely-typed fixtures by design.
    files: ['**/*.test.ts'],
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
    },
  },

  {
    /**
     * Not part of the typed program, so linted without type information rather
     * than not at all. `tsconfig.json` covers `src/` and `test/` only, and
     * widening it to `tools/` would put throwaway maintenance scripts through
     * the same gate as shipped code — which is how a data refresh ends up
     * blocked on a type error in a script that ran fine.
     */
    files: ['eslint.config.js', 'tools/**/*.ts'],
    ...tseslint.configs.disableTypeChecked,
  },
);
