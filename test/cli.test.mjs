import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const ANNOTATE = fileURLToPath(new URL('../bin/annotate.mjs', import.meta.url));
const DOWNLOAD = fileURLToPath(new URL('../bin/download.mjs', import.meta.url));
const SAMPLE = fileURLToPath(new URL('./fixtures/sample.sarif', import.meta.url));

/** Temp directory under the OS temp dir, never inside the workspace. */
async function tempDir(t) {
  const dir = await mkdtemp(join(tmpdir(), 'pd-cli-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

/**
 * Spawn one of the bin/ entry points and normalise the result so both the
 * exit-0 and non-zero cases read the same.
 *
 * @param {string} bin Absolute path of the entry point.
 * @param {string[]} args Flags after the script path.
 * @returns {Promise<{ code: number, stdout: string, stderr: string }>}
 */
async function run(bin, args) {
  try {
    const { stdout } = await execFileAsync(process.execPath, [bin, ...args], { env: process.env });
    return { code: 0, stdout, stderr: '' };
  } catch (error) {
    return { code: error.code, stdout: String(error.stdout ?? ''), stderr: String(error.stderr ?? '') };
  }
}

/** Expected failures print one clean line: the message, no stack trace. */
function assertCleanOneLine(stderr) {
  const lines = stderr.trim().split('\n');
  assert.strictEqual(lines.length, 1, `stderr is one line, got: ${JSON.stringify(lines)}`);
  assert.ok(!/^\s+at /m.test(stderr), 'no stack trace for an expected ActionError');
}

test('a nonexistent --sarif path is a hard failure: exit 2, one-line stderr, no stack', async (t) => {
  const dir = await tempDir(t);
  const missing = join(dir, 'not-there.sarif');
  const result = await run(ANNOTATE, ['--sarif', missing]);

  assert.strictEqual(result.code, 2, 'a missing scan must fail loudly, never look clean');
  assertCleanOneLine(result.stderr);
  assert.ok(result.stderr.includes(missing), `stderr names the file: ${result.stderr}`);
});

test('a SARIF file with invalid JSON is a hard failure: exit 2, one-line stderr, no stack', async (t) => {
  const dir = await tempDir(t);
  const broken = join(dir, 'broken.sarif');
  await writeFile(broken, '{ "runs": [not json at all', 'utf8');
  const result = await run(ANNOTATE, ['--sarif', broken]);

  assert.strictEqual(result.code, 2);
  assertCleanOneLine(result.stderr);
  assert.ok(result.stderr.toLowerCase().includes('sarif'), `stderr says what failed: ${result.stderr}`);
});

test('an invalid --mode exits 2 naming the valid values', async (t) => {
  const result = await run(ANNOTATE, ['--sarif', SAMPLE, '--mode', 'both']);
  assert.strictEqual(result.code, 2);
  assertCleanOneLine(result.stderr);
  assert.ok(result.stderr.includes('both'), `stderr echoes the bad value: ${result.stderr}`);
  assert.ok(
    result.stderr.includes('annotate') && result.stderr.includes('report'),
    `stderr names the valid values: ${result.stderr}`,
  );
});

test('an invalid --fail-on exits 2 naming the valid values', async (t) => {
  const result = await run(ANNOTATE, ['--sarif', SAMPLE, '--fail-on', 'fatal']);
  assert.strictEqual(result.code, 2);
  assertCleanOneLine(result.stderr);
  assert.ok(result.stderr.includes('fatal'), `stderr echoes the bad value: ${result.stderr}`);
  for (const level of ['none', 'note', 'warning', 'error']) {
    assert.ok(result.stderr.includes(level), `stderr names "${level}": ${result.stderr}`);
  }
});

test('--help exits 0 and documents all three exit codes', async (t) => {
  const result = await run(ANNOTATE, ['--help']);
  assert.strictEqual(result.code, 0);
  assert.ok(/--sarif/.test(result.stdout));
  assert.ok(/exit codes/i.test(result.stdout), `stdout has an exit-codes section: ${result.stdout}`);
  assert.match(result.stdout, /^\s+0\s+Passed:/m, 'documents exit 0');
  assert.match(result.stdout, /^\s+1\s+Failed:/m, 'documents exit 1');
  assert.match(result.stdout, /^\s+2\s+Hard failure:/m, 'documents exit 2');
  assert.match(result.stdout, /missing, unreadable or unparseable/, 'help states the hard-failure rule');
});

test('flags are scoped per entry point: annotate rejects --dest, download rejects --mode', async (t) => {
  const annotate = await run(ANNOTATE, ['--sarif', SAMPLE, '--dest', '/tmp/x']);
  assert.strictEqual(annotate.code, 2);
  assertCleanOneLine(annotate.stderr);
  assert.ok(annotate.stderr.includes('Unknown option --dest'), `stderr: ${annotate.stderr}`);
  assert.ok(annotate.stderr.includes('--fail-on'), 'supported options listed are annotate’s own');

  const download = await run(DOWNLOAD, ['--mode', 'annotate']);
  assert.strictEqual(download.code, 1, 'bin/download.mjs exits 1 on expected errors');
  assertCleanOneLine(download.stderr);
  assert.ok(download.stderr.includes('Unknown option --mode'), `stderr: ${download.stderr}`);
  assert.ok(download.stderr.includes('--dest'), 'supported options listed are download’s own');
});
