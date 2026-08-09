/**
 * Runtime mode, and the paths that depend on it.
 *
 * Not a "dev mode" flag. **Detected, not configured** — a flag is one more
 * thing to set wrongly, and behaviour that only manifests under a flag is
 * behaviour nobody tests. The question we actually care about is *"am I running
 * from a git checkout, or from an installed package?"*, and that is knowable.
 *
 * `SCHEMANATOR_ENV` overrides the detection, for testing the other branch.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

export type RuntimeMode = 'development' | 'installed';

/**
 * Installed if we are running from inside `node_modules` — which covers `npx`,
 * a global install and a project dependency alike. A checkout is anything else.
 */
function detectMode(): RuntimeMode {
  const override = process.env['SCHEMANATOR_ENV'];
  if (override === 'development' || override === 'installed') return override;

  // NODE_ENV as a fallback, because the convention is familiar and costs
  // nothing to honour. We never *set* it: it is read by npm, bundlers, Express
  // and React, so writing it would have side effects well beyond this tool.
  //
  // Its vocabulary is not ours — it says "production" where we say "installed"
  // — so map rather than compare. Anything unrecognised (`test`, a typo) falls
  // through to detection, which is the more reliable signal anyway.
  const nodeEnv = process.env['NODE_ENV'];
  if (nodeEnv === 'development') return 'development';
  if (nodeEnv === 'production') return 'installed';

  const here = fileURLToPath(import.meta.url);
  return here.includes(`${path.sep}node_modules${path.sep}`) ? 'installed' : 'development';
}

export const MODE: RuntimeMode = detectMode();
export const IS_DEVELOPMENT = MODE === 'development';

/** The repository or package root — the directory holding `package.json`. */
export function packageRoot(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 8; depth += 1) {
    if (fs.existsSync(path.join(dir, 'package.json'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
}

function xdg(variable: string, fallback: string): string {
  const configured = process.env[variable];
  return configured !== undefined && configured !== ''
    ? configured
    : path.join(os.homedir(), fallback);
}

/**
 * Where crawl output goes.
 *
 * Development: `./work` beside the code, because Phase 0's whole purpose is
 * eyeballing and that is where you will look.
 *
 * Installed: `$XDG_STATE_HOME/schemanator`. **State, not cache** — a cache
 * cleaner deleting a two-hour crawl mid-run would be miserable — and not
 * Documents, which is for things a human authored, whereas this is bulk
 * machine-generated copies of other people's websites.
 */
export function defaultWorkRoot(): string {
  const explicit = process.env['SCHEMANATOR_WORK_DIR'];
  if (explicit !== undefined && explicit !== '') return explicit;

  return IS_DEVELOPMENT
    ? path.resolve(process.cwd(), 'work')
    : path.join(xdg('XDG_STATE_HOME', path.join('.local', 'state')), 'schemanator');
}

/** Operator configuration lives under `XDG_CONFIG_HOME`, in both modes. */
export function userConfigDir(): string {
  return path.join(xdg('XDG_CONFIG_HOME', '.config'), 'schemanator');
}

/**
 * Config files, lowest precedence first. Later files override earlier ones,
 * and every one of them is overridden by environment variables, which are in
 * turn overridden by CLI flags.
 *
 * The repo-local file exists only in development — an installed package must
 * not pick up a config from whatever directory it happened to be run in.
 */
export function configSearchPath(): string[] {
  const paths = [path.join(userConfigDir(), 'config.json')];
  if (IS_DEVELOPMENT) paths.push(path.join(packageRoot(), 'schemanator.config.json'));
  return paths;
}

/**
 * The package version, read from `package.json`.
 *
 * Single source of truth. It had been hardcoded in three places — the report
 * builder, the pipeline and the User-Agent — which is a drift waiting to
 * happen: bump `package.json` and the report keeps claiming the old version
 * while the User-Agent claims a third thing.
 */
export const VERSION: string = (() => {
  try {
    const manifest = JSON.parse(
      fs.readFileSync(path.join(packageRoot(), 'package.json'), 'utf8'),
    ) as {
      version?: unknown;
    };
    return typeof manifest.version === 'string' ? manifest.version : '0.0.0';
  } catch {
    return '0.0.0';
  }
})();

/** Emit the `by-type/` browsing view — a Phase 0 eyeballing aid, not an input. */
export const DEFAULT_EMIT_BY_TYPE = IS_DEVELOPMENT;

/** Print full stack traces. Installed users get the message; we get the trace. */
export const DEFAULT_VERBOSE_ERRORS = IS_DEVELOPMENT;
