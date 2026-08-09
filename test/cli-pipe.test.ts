/**
 * The CLI must survive a reader that stops reading.
 *
 * `docs/usage.md` recommends `schemanator example.com | less`. Quitting the
 * pager early, or piping to `head`, closes the pipe while the CLI is still
 * writing — and Node's default response is an unhandled `'error'` event and a
 * stack trace.
 *
 * Whether it fires is a race between the reader exiting and the next write, so
 * it is intermittent. These run the same case repeatedly rather than once.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'src', 'cli.ts');

/**
 * Run the CLI and hang up on its stdout after the first chunk, the way `head`
 * does. Resolves with whatever it put on stderr and how it exited.
 */
function hangUpEarly(
  args: string[],
): Promise<{ stderr: string; code: number | null; signal: string | null }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';

    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.stdout.once('data', () => {
      child.stdout.destroy();
    });
    child.on('close', (code, signal) => resolve({ stderr, code, signal }));
  });
}

const CASES: { name: string; args: string[] }[] = [
  { name: '--help', args: ['--help'] },
  { name: 'sites', args: ['sites', '--work-dir', path.join(ROOT, 'work')] },
];

for (const { name, args } of CASES) {
  test(`${name} survives its reader hanging up`, async () => {
    // Repeated because the failure is a race; once is not evidence.
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const result = await hangUpEarly(args);

      assert.equal(
        /EPIPE/.test(result.stderr),
        false,
        `attempt ${attempt}: EPIPE reached the user\n${result.stderr}`,
      );
      assert.equal(
        /Unhandled|throw er/.test(result.stderr),
        false,
        `attempt ${attempt}: an unhandled error escaped\n${result.stderr}`,
      );
      assert.notEqual(result.code, 7, `attempt ${attempt}: crashed on an unhandled rejection`);
    }
  });
}

test('a broken pipe is not reported as a failure', async () => {
  // The consumer got what it asked for, so this is a success by any reading.
  const result = await hangUpEarly(['--help']);
  assert.equal(result.signal, null);
  assert.equal(result.code === 0 || result.code === null, true, `exited ${result.code}`);
});
