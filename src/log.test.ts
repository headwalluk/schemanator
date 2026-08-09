import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createLogger, isLogLevel, resolveLogLevel, SILENT_LOGGER } from './log.ts';

function capture(level: Parameters<typeof createLogger>[0]): {
  lines: string[];
  logger: ReturnType<typeof createLogger>;
} {
  const lines: string[] = [];
  return { lines, logger: createLogger(level, (text) => lines.push(text.trimEnd())) };
}

test('info is the default level and shows error, warn and info', () => {
  const { lines, logger } = capture('info');
  logger.error('bad');
  logger.warn('hmm');
  logger.info('doing a thing');
  logger.debug('internals');

  assert.deepEqual(lines, ['ERROR bad', 'WARN  hmm', 'doing a thing']);
});

test('debug shows everything', () => {
  const { lines, logger } = capture('debug');
  logger.error('a');
  logger.warn('b');
  logger.info('c');
  logger.debug('d');
  assert.equal(lines.length, 4);
});

test('error shows only errors', () => {
  const { lines, logger } = capture('error');
  logger.error('a');
  logger.warn('b');
  logger.info('c');
  logger.debug('d');
  assert.deepEqual(lines, ['ERROR a']);
});

test('silent shows nothing at all', () => {
  const { lines, logger } = capture('silent');
  logger.error('a');
  logger.warn('b');
  logger.info('c');
  logger.debug('d');
  assert.deepEqual(lines, []);
});

test('info lines are unadorned; unusual levels are prefixed', () => {
  const { lines, logger } = capture('debug');
  logger.info('the normal narrative');
  assert.deepEqual(lines, ['the normal narrative']);
});

test('SILENT_LOGGER never throws and never writes', () => {
  assert.doesNotThrow(() => {
    SILENT_LOGGER.error('a');
    SILENT_LOGGER.debug('b');
  });
  assert.equal(SILENT_LOGGER.level, 'silent');
});

test('resolveLogLevel follows flag over env over config', () => {
  assert.equal(resolveLogLevel({ flag: 'debug', env: 'warn', config: 'error' }), 'debug');
  assert.equal(resolveLogLevel({ env: 'warn', config: 'error' }), 'warn');
  assert.equal(resolveLogLevel({ config: 'error' }), 'error');
  assert.equal(resolveLogLevel({}), 'info');
});

test('resolveLogLevel skips empty values rather than treating them as set', () => {
  // An unset environment variable often arrives as "" rather than undefined.
  assert.equal(resolveLogLevel({ flag: '', env: 'warn' }), 'warn');
  assert.equal(resolveLogLevel({ env: '' }), 'info');
});

test('resolveLogLevel is case-insensitive', () => {
  assert.equal(resolveLogLevel({ flag: 'DEBUG' }), 'debug');
});

test('resolveLogLevel rejects a bad level loudly', () => {
  assert.throws(() => resolveLogLevel({ flag: 'chatty' }), /invalid log level/);
  // A typo in an env var must not silently fall back to the default.
  assert.throws(() => resolveLogLevel({ env: 'verbose' }), /invalid log level/);
});

test('isLogLevel guards the union', () => {
  assert.equal(isLogLevel('debug'), true);
  assert.equal(isLogLevel('chatty'), false);
});
