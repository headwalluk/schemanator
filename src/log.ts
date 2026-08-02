/**
 * Logging.
 *
 * **Logs go to stderr. Data goes to stdout.** Nothing else here matters as
 * much. The report renders markdown to stdout so it can be piped — into a
 * pager, a file, or a coding agent — and a single stray progress line in that
 * stream corrupts the output. Standard Unix discipline, load-bearing here
 * because of how `05` expects the report to be consumed.
 */

import process from 'node:process';

export const LOG_LEVELS = ['silent', 'error', 'warn', 'info', 'debug'] as const;

export type LogLevel = (typeof LOG_LEVELS)[number];

const RANK: Record<LogLevel, number> = { silent: 0, error: 1, warn: 2, info: 3, debug: 4 };

export interface Logger {
  readonly level: LogLevel;
  error(message: string): void;
  warn(message: string): void;
  info(message: string): void;
  debug(message: string): void;
}

export function isLogLevel(value: string): value is LogLevel {
  return (LOG_LEVELS as readonly string[]).includes(value);
}

/**
 * Resolve the level from the precedence chain in `06`:
 * flag beats environment beats config beats default.
 */
export function resolveLogLevel(options: {
  flag?: string | undefined;
  env?: string | undefined;
  config?: string | undefined;
}): LogLevel {
  for (const candidate of [options.flag, options.env, options.config]) {
    if (candidate === undefined || candidate === '') continue;
    const normalised = candidate.toLowerCase();
    if (isLogLevel(normalised)) return normalised;
    throw new Error(`invalid log level ${JSON.stringify(candidate)} — expected one of ${LOG_LEVELS.join(', ')}`);
  }
  return 'info';
}

export function createLogger(level: LogLevel, write: (text: string) => void = (text) => process.stderr.write(text)): Logger {
  const emit = (at: LogLevel, prefix: string, message: string): void => {
    if (RANK[level] < RANK[at]) return;
    // Prefix only the levels that are unusual. An `info` line is the normal
    // narrative and reads better unadorned.
    write(prefix === '' ? `${message}\n` : `${prefix} ${message}\n`);
  };

  return {
    level,
    error: (message) => emit('error', 'ERROR', message),
    warn: (message) => emit('warn', 'WARN ', message),
    info: (message) => emit('info', '', message),
    debug: (message) => emit('debug', 'DEBUG', message),
  };
}

/** For tests and library use — says nothing, ever. */
export const SILENT_LOGGER: Logger = createLogger('silent', () => undefined);
